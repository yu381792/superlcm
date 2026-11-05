import { isDeepStrictEqual } from 'node:util'
import { estimateSummaryTokens } from './summary-tokens.js'

// Google places the live request signal inside its payload. structuredClone
// turns it into {}, which is not an AbortSignal and cannot be sent back to SDKs.
export function clonePiPayload(payload) {
  const copy=structuredClone(payload)
  if(payload?.config?.abortSignal&&copy.config)copy.config.abortSignal=payload.config.abortSignal
  return copy
}

// OpenAI Responses reasoning ciphertext is an encoding of model output, not
// ordinary prompt text. Use a *matching* earlier response's measured reasoning/output
// usage as a conservative allowance; never discount unverified or changed ciphertext.
function reasoningReceipts(history,model) {
  if(!Array.isArray(history)||!model?.provider||!model?.id||(model.api&&!['openai-responses','openai-completions'].includes(model.api)))return null
  const ids=new Map(),blocks=new WeakMap()
  for(const message of history){
    const u=message?.usage
    if(message?.role!=='assistant'||message.provider!==model.provider||message.model!==model.id||message.api!=='openai-responses'||
       !['stop','toolUse','length'].includes(message.stopReason)||!Array.isArray(message.content)||
       !Number.isSafeInteger(u?.output)||u.output<=0||!Number.isSafeInteger(u?.reasoning)||u.reasoning<0||u.reasoning>u.output||
       !['input','cacheRead','cacheWrite'].every(k=>Number.isSafeInteger(u?.[k]??0)&&(u?.[k]??0)>=0)||
       (u.input||0)+(u.cacheRead||0)+(u.cacheWrite||0)<=0)continue
    const nonThinking=message.content.filter(b=>b?.type!=='thinking')
    const nonThinkingTokens=nonThinking.length?estimateSummaryTokens(JSON.stringify(nonThinking)):0
    const group={tokens:Math.max(u.reasoning,u.output-nonThinkingTokens)}
    for(const block of message.content){
      if(block?.type!=='thinking'||typeof block.thinkingSignature!=='string')continue
      let item;try{item=JSON.parse(block.thinkingSignature)}catch{continue}
      if(item?.type!=='reasoning'||typeof item.id!=='string'||!item.id||typeof item.encrypted_content!=='string'||!item.encrypted_content)continue
      const spec={item,group,block};blocks.set(block,spec)
      ids.set(item.id,ids.has(item.id)?null:spec) // Ambiguous IDs never receive a discount.
    }
  }
  return {ids,blocks}
}

// Count native and Pi image forms as visual input, not base64 text. Recognized
// reasoning records may use their actual source receipts; all unknown content,
// missing receipts and other request formats retain the original conservative count.
export function estimatePiRequest(value,{history,model}={}) {
  const index=reasoningReceipts(history,model),used=new Set(),groups=new Set()
  const matched=spec=>{
    if(!spec||index.ids.get(spec.item.id)!==spec||used.has(spec.item.id))return false
    used.add(spec.item.id);groups.add(spec.group);return true
  }
  let counted=value
  if(Array.isArray(value)){
    counted=value.map(message=>{
      if(!message||typeof message!=='object')return message
      let base=message
      if(base.role==='toolResult'&&(base.details!==undefined||base.nestedCalls!==undefined))
        base={...base,details:undefined,nestedCalls:undefined}
      else if(base.role==='assistant'&&(base.usage!==undefined||base.codexHostedSearch!==undefined))
        base={...base,usage:undefined,codexHostedSearch:undefined}
      if(base.role!=='assistant'||!Array.isArray(base.content))return base
      if(model?.provider&&model?.id&&base.provider&&base.model&&(base.provider!==model.provider||base.model!==model.id))
        return {...base,content:base.content.filter(b=>b?.type!=='thinking')}
      if(!index)return base
      const content=base.content.map(block=>{
        let spec=index.blocks.get(block)
        if(!spec&&block?.type==='thinking'&&typeof block.thinkingSignature==='string'){
          try{
            const parsed=JSON.parse(block.thinkingSignature)
            const candidate=parsed?.type==='reasoning'?index.ids.get(parsed.id):null
            if(candidate&&isDeepStrictEqual(parsed,candidate.item))spec=candidate
          }catch{}
        }
        return matched(spec)?{...block,thinking:'',thinkingSignature:JSON.stringify({...spec.item,encrypted_content:'',summary:[]})}:block
      })
      return {...base,content}
    })
  }else if(index&&Array.isArray(value?.input)){
    counted={...value,input:value.input.map(item=>{
      const spec=item?.type==='reasoning'?index.ids.get(item.id):null
      return spec&&isDeepStrictEqual(item,spec.item)&&matched(spec)?{...item,encrypted_content:'',summary:[]}:item
    })}
  }
  let images = 0
  const text = JSON.stringify(counted, (_key, item) => {
    if (['image', 'image_url', 'input_image'].includes(item?.type) || item?.inlineData?.mimeType?.startsWith('image/')) {
      images++; return { type: 'image', mimeType: item.mimeType }
    }
    return item
  })
  return estimateSummaryTokens(text || '') + images * 8192 + [...groups].reduce((sum,group)=>sum+group.tokens,0)
}

export function fixedPiRequestTokens(payload) {
  if(!payload||typeof payload!=='object')return 0
  const fixed={...payload}
  for(const key of ['messages','input'])if(Array.isArray(fixed[key]))fixed[key]=fixed[key].filter(m=>['system','developer'].includes(m.role))
  if(Array.isArray(fixed.contents))fixed.contents=[]
  if(Array.isArray(fixed.context?.messages))fixed.context={...fixed.context,messages:fixed.context.messages.filter(m=>['system','developer'].includes(m.role))}
  return estimatePiRequest(fixed)
}

function validReceiptMessage(message,model) {
  const u=message?.usage
  if(message?.role!=='assistant'||['error','aborted'].includes(message.stopReason)||!u)return null
  if(model?.provider&&message.provider&&message.provider!==model.provider)return null
  if(model?.id&&message.model&&message.model!==model.id)return null
  const parts=['input','output','cacheRead','cacheWrite'].map(k=>u[k]??0)
  if(parts.some(n=>!Number.isSafeInteger(n)||n<0)||parts[0]+parts[2]+parts[3]<=0||parts[1]<=0)return null
  const paidInput=parts[0]+parts[2]+parts[3]
  const total=Math.max(Number.isSafeInteger(u.totalTokens)?u.totalTokens:0,paidInput+parts[1])
  return {paidInput,output:parts[1],total}
}

function invalidatedAfterAnchor(entries,anchor,branch) {
  const prefixIds=new Set(entries.slice(0,anchor+1).map(e=>e?.sourceEntry?.id).filter(Boolean))
  const anchorId=entries[anchor]?.sourceEntry?.id
  const branchAnchor=Array.isArray(branch)&&anchorId?branch.findIndex(e=>e?.id===anchorId):-1
  for(const entry of entries.slice(anchor+1)){
    const src=entry?.sourceEntry
    if(src?.type==='compaction')return true
    if(src?.type==='context_edit'){
      if(entry.messages?.length>0||prefixIds.has(src.targetId))return true
      if(branchAnchor>=0){
        const targetIdx=branch.findIndex(e=>e?.id===src.targetId)
        if(targetIdx<0||targetIdx<=branchAnchor)return true
      }else if(!src.targetId||src.targetId!==src.parentId||src.parentId===anchorId)return true
    }
  }
  return false
}

// Recover the last valid assistant usage receipt even when a later failed turn
// was removed by a context_edit. Edits to the prefix itself still invalidate it.
export function measuredPiContextTokens(entries,model,hostTokens,branch) {
  if(!Array.isArray(entries))return Number.isFinite(hostTokens)&&hostTokens>0?hostTokens:null
  let anchor=-1,message=null,messageIndex=-1,receipt=null
  for(let i=entries.length-1;i>=0;i--){
    const msgs=entries[i]?.messages||[]
    for(let j=msgs.length-1;j>=0;j--){
      const r=validReceiptMessage(msgs[j],model)
      if(r){anchor=i;message=msgs[j];messageIndex=j;receipt=r;break}
    }
    if(anchor>=0)break
  }
  if(anchor<0)return Number.isFinite(hostTokens)&&hostTokens>0?hostTokens:null
  if(invalidatedAfterAnchor(entries,anchor,branch))return null
  const allMessages=entries.flatMap(e=>e?.messages||[])
  const trailing=[
    ...(entries[anchor]?.messages||[]).slice(messageIndex+1),
    ...entries.slice(anchor+1).flatMap(e=>e?.messages||[]),
  ].filter(m=>m&&m.role!=='system')
  const measured=receipt.total+(trailing.length?estimatePiRequest(trailing,{history:allMessages,model}):0)
  return Number.isFinite(hostTokens)&&hostTokens>=measured?hostTokens:measured
}

// These SDK configuration items change request effort, not dialogue history.
export const isPiEffortUpdate=item=>typeof item?.reasoning?.effort==='string'&&isDeepStrictEqual(item,{type:'configuration_update',reasoning:{effort:item.reasoning.effort}})||typeof item?.output_config?.effort==='string'&&isDeepStrictEqual(item,{role:'system',content:[],output_config:{effort:item.output_config.effort}})

// A completed foreground receipt can calibrate the old prefix, but only when
// the current wire request still contains that exact prefix. Estimate all new
// items and changed request fields conservatively; uncertain history falls back
// to the full wire estimate.
export function estimatePiWireWithReceipt(payload,previous,entries,observed,model) {
  if(!previous?.payload||!previous.leafId||!Array.isArray(entries)||!Number.isFinite(observed)||observed<=0)return null
  if(['provider','id','api','contextWindow','maxTokens','baseUrl'].some(key=>previous.model?.[key]!==model?.[key]))return null
  const anchor=entries.findIndex(entry=>entry.sourceEntry?.id===previous.leafId)
  if(anchor<0)return null
  const later=entries.slice(anchor+1)
  const assistants=later.flatMap(entry=>entry.messages.filter(message=>message.role==='assistant').map(message=>({entry:entry.sourceEntry,message})))
  if(assistants.length!==1)return null
  const {entry,message}=assistants[0],usage=message.usage
  const replyIndex=entries.findIndex(e=>e.sourceEntry?.id===entry?.id)
  if(replyIndex<=anchor||entries.slice(anchor+1,replyIndex+1).some(e=>['compaction','context_edit'].includes(e.sourceEntry?.type))||invalidatedAfterAnchor(entries,replyIndex))return null
  if(entry.parentId!==previous.leafId||message.provider!==model.provider||message.model!==model.id||['error','aborted'].includes(message.stopReason)||!usage)return null
  const values=['input','output','cacheRead','cacheWrite'].map(key=>usage[key]??0)
  if(values.some(value=>!Number.isFinite(value)||value<0)||values[0]+values[2]+values[3]<=0||observed<values.reduce((a,b)=>a+b,0))return null
  const field=value=>['messages','input','contents'].find(key=>Array.isArray(value?.[key]))||(Array.isArray(value?.context?.messages)?'context.messages':null)
  const name=field(previous.payload)
  if(!name||field(payload)!==name)return null
  const get=value=>name==='context.messages'?value.context.messages:value[name]
  const source=get(previous.payload),after=get(payload)
  let end=source.length
  while(end>0&&isPiEffortUpdate(source[end-1]))end--
  const before=source.slice(0,end)
  if(!before.length||before.length>after.length||before.some((item,i)=>!isDeepStrictEqual(item,after[i])))return null
  const fixed=value=>name==='context.messages'?{...value,context:{...value.context,messages:undefined}}:{...value,[name]:undefined}
  const oldFixed=fixed(previous.payload),newFixed=fixed(payload),changed={}
  for(const key of Object.keys(newFixed))if(!isDeepStrictEqual(oldFixed[key],newFixed[key]))changed[key]=newFixed[key]
  // observed already includes the completed response and appended tool input.
  // Start the wire delta at its paid input, not at input+output a second time.
  const priorInput=values[0]+values[2]+values[3]
  const history=entries.flatMap(entry=>entry.messages)
  const suffix=estimatePiRequest({input:after.slice(before.length)},{history,model})
  return Math.max(observed,priorInput+suffix)+estimatePiRequest(changed)
}

const outputPaths = [['max_tokens'], ['max_completion_tokens'], ['max_output_tokens'], ['maxOutputTokens'], ['maxTokens'], ['generationConfig', 'maxOutputTokens'], ['config', 'maxOutputTokens'], ['inferenceConfig', 'maxTokens'], ['options', 'maxTokens']]
export function piOutputReserve(payload, model) {
  // Extensions may leave more than one provider alias. Budget for the largest
  // one and validate all of them, irrespective of the provider's precedence.
  const values = outputPaths.flatMap(path => {
    const parent = path.length === 1 ? payload : payload?.[path[0]], key = path.at(-1)
    return parent && Object.hasOwn(parent, key) && parent[key] !== undefined ? [parent[key]] : []
  })
  if (!values.length) values.push(model?.maxTokens ?? Math.floor(Math.min(16384, (model?.contextWindow || 163840) * .1)))
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw Object.assign(Error('Pi 模型输出预留无效，原文保留'),{code:'SUPERLCM_PI_INVALID_BUDGET'})
  return Math.max(...values)
}

export function piWindowSafety(model,ratio=.8) {
  const remaining=model.contextWindow-Math.floor(model.contextWindow*ratio)
  return Math.min(Math.max(1024,model.contextWindow*.02),Math.max(1,Math.floor(remaining/2)))
}
export function piCompletionBudget(model,ratio,requested=piOutputReserve(null,model)) {
  return Math.min(requested,Math.max(1,model.contextWindow-Math.floor(model.contextWindow*ratio)-piWindowSafety(model,ratio)))
}
// Budget-based Claude thinking shares the output ceiling and needs at least
// 1024 thinking tokens, strictly fewer than the effective provider maximum.
function limitClaudeThinking(payload,model,cap,reduced) {
  const bedrock=model.api?.includes('bedrock'),anthropic=model.api?.includes('anthropic')
  const thinking=bedrock?payload.additionalModelRequestFields?.thinking:anthropic?payload.thinking:undefined
  if(thinking?.type!=='enabled')return payload
  const budget=thinking.budget_tokens,max=bedrock?(payload.inferenceConfig?.maxTokens??cap):(payload.max_tokens??cap)
  if(!Number.isSafeInteger(budget)||budget<1024||!Number.isSafeInteger(max))throw Object.assign(Error('Pi 思考预算无效，原文保留'),{code:'SUPERLCM_PI_INVALID_BUDGET'})
  if(max<=1024)throw Object.assign(Error('Pi 输出空间不足以保留有效思考预算，原文保留'),{code:reduced?'SUPERLCM_PI_OUTPUT_CAPACITY':'SUPERLCM_PI_INVALID_BUDGET'})
  const allowed=Math.max(1024,max-1024)
  if(budget<max&&(!reduced||budget<=allowed))return payload
  const replacement={...thinking,budget_tokens:Math.min(budget,allowed)}
  return bedrock?{...payload,additionalModelRequestFields:{...payload.additionalModelRequestFields,thinking:replacement}}:{...payload,thinking:replacement}
}
function limitThinking(payload,model,cap,reduced) {
  let result=limitClaudeThinking(payload,model,cap,reduced)
  if(model.api?.includes('google')||Array.isArray(result.contents))for(const key of ['config','generationConfig']){
    const settings=result[key],thinking=settings?.thinkingConfig,budget=thinking?.thinkingBudget
    if(budget===undefined||budget===0||budget===-1)continue // -1 is Google's dynamic budget.
    if(!Number.isSafeInteger(budget)||budget<0)throw Object.assign(Error('Pi 思考预算无效，原文保留'),{code:'SUPERLCM_PI_INVALID_BUDGET'})
    const max=Math.min(cap,settings.maxOutputTokens??cap),allowed=Math.max(1024,max-1024)
    if(budget<max&&(!reduced||budget<=allowed))continue
    if(max<=1024)throw Object.assign(Error('Pi 输出空间不足以保留有效思考预算，原文保留'),{code:reduced?'SUPERLCM_PI_OUTPUT_CAPACITY':'SUPERLCM_PI_INVALID_BUDGET'})
    result={...result,[key]:{...settings,thinkingConfig:{...thinking,thinkingBudget:Math.min(budget,allowed)}}}
  }
  if(model.api?.includes('completions'))for(const key of ['thinking_token_budget','thinking_budget','thinking_budget_tokens']){
    const budget=result[key]
    if(budget===undefined||budget===0)continue
    if(!Number.isSafeInteger(budget)||budget<0)throw Object.assign(Error('Pi 思考预算无效，原文保留'),{code:'SUPERLCM_PI_INVALID_BUDGET'})
    const max=Math.min(cap,...[result.max_tokens,result.max_completion_tokens].filter(Number.isFinite)),allowed=Math.max(0,max-1024)
    if(budget<max&&(!reduced||budget<=allowed))continue
    if(allowed<1)throw Object.assign(Error('Pi 输出空间不足以保留有效思考预算，原文保留'),{code:reduced?'SUPERLCM_PI_OUTPUT_CAPACITY':'SUPERLCM_PI_INVALID_BUDGET'})
    result={...result,[key]:Math.min(budget,allowed)}
  }
  return result
}
// The public Pi hook accepts the replacement wire payload. Leave the model
// configuration intact and change only output fields actually sent upstream.
export function limitPiOutput(payload,model,ceiling) {
  const requested=piOutputReserve(payload,model)
  if(!Number.isFinite(ceiling)||ceiling<1)throw Object.assign(Error('Pi 请求没有足够输出空间，原文保留'),{code:'SUPERLCM_PI_OUTPUT_CAPACITY'})
  const cap=Math.min(requested,Math.floor(ceiling))
  if(cap===requested)return limitThinking(payload,model,cap,false)
  limitThinking(payload,model,requested,false) // Reject invalid original settings before attributing a reduced cap to capacity.
  // Copy only the fields we modify. SDK payloads may hold an AbortSignal,
  // which structuredClone converts to an unusable plain object.
  const result={...payload},copied=new Set()
  let found=false
  for(const path of outputPaths){
    let parent=path.length===1?result:result[path[0]],key=path.at(-1)
    if(parent&&Object.hasOwn(parent,key)&&parent[key]!==undefined){
      if(!Number.isSafeInteger(parent[key])||parent[key]<0)throw Error('Pi 模型输出预留无效，原文保留')
      if(path.length>1&&!copied.has(path[0])){result[path[0]]={...parent};copied.add(path[0]);parent=result[path[0]]}
      parent[key]=Math.min(parent[key],cap);found=true
    }
  }
  if(!found){
    if(model.api?.includes('responses')||Array.isArray(result.input))result.max_output_tokens=cap
    else if(model.api?.includes('google')||Array.isArray(result.contents)){
      const key=result.config||!result.generationConfig?'config':'generationConfig'
      result[key]={...result[key],maxOutputTokens:cap}
    }
    else if(model.api==='pi-messages'||Array.isArray(result.context?.messages))result.options={...result.options,maxTokens:cap}
    else if(model.api?.includes('bedrock')||result.inferenceConfig)result.inferenceConfig={...result.inferenceConfig,maxTokens:cap}
    else if(model.api?.includes('anthropic')||model.api?.includes('completions'))result.max_tokens=cap
    else throw Object.assign(Error('Pi 供应商未声明可限制的输出字段，原文保留'),{code:'SUPERLCM_PI_UNSUPPORTED_REQUEST'})
  }
  return limitThinking(result,model,cap,true)
}
