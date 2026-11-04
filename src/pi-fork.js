import { dirname, join } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { findCli } from './runtime.js'
import { forkHash, forkAnchors, forkDirective, parseForkTree } from './fork-summary.js'
import {summaryToolPairing} from './summary-source.js'
import { estimateSummaryTokens } from './summary-tokens.js'
import { dialogueMessage, serializePiMessages } from './pi-snapshot.js'
import { summaryAttempt } from './summary-attempt.js'
import { piAuxiliaryRequest } from './pi-provider-boundary.js'
import { estimatePiRequest, piOutputReserve,limitPiOutput,isPiEffortUpdate,clonePiPayload } from './pi-request.js'
let converter
async function convert(messages,{blockImages=false}={}) {
  if (!converter) {
    let root = dirname(realpathSync(findCli('pi')))
    while (!existsSync(join(root, 'package.json'))) { const parent = dirname(root); if (parent === root) throw Error('未找到 Pi 公共接口'); root = parent }
    converter = (await import(pathToFileURL(join(root, 'dist/index.js')))).convertToLlm
  }
  const converted=converter(messages)
  if(!blockImages)return converted
  // Match Pi's SDK conversion: images in user/tool results never reach the provider when blocked.
  return converted.map(message=>{
    if(!['user','toolResult'].includes(message.role)||!Array.isArray(message.content)||!message.content.some(part=>part.type==='image'))return message
    const content=message.content.map(part=>part.type==='image'?{type:'text',text:'Image reading is disabled.'}:part)
      .filter((part,i,all)=>!(part.type==='text'&&part.text==='Image reading is disabled.'&&i>0&&all[i-1].type==='text'&&all[i-1].text==='Image reading is disabled.'))
    return {...message,content}
  })
}
export const normalizePiReasoning=level=>level==='off'?undefined:level
// Convert through the configured provider without dispatching an HTTP request.
// Cold sessions can prepare before permitting their first foreground request.
export async function capturePiContext(ctx,messages,reasoning,signal,{timeoutMs=30000,blockImages=false}={}){
  reasoning=normalizePiReasoning(reasoning)
  return piAuxiliaryRequest(()=>summaryAttempt(async abort=>{
    const selected=await convert(messages,{blockImages})
    abort.throwIfAborted()
    const controller=new AbortController()
    return new Promise((resolve,reject)=>{
      let settled=false
      const fail=error=>{if(!settled){settled=true;reject(error)}}
      const stream=ctx.modelRegistry.streamSimple(ctx.model,{messages:selected},{sessionId:ctx.sessionManager.getSessionId(),reasoning,
        signal:AbortSignal.any([abort,controller.signal]),
        onPayload(value){
          abort.throwIfAborted()
          if(settled)throw Error('Pi 请求捕获已结束')
          const payload=clonePiPayload(value),model=structuredClone(ctx.model)
          settled=true;controller.abort();resolve({payload,messages:selected,model,reasoning,blockImages})
          throw Error('SuperLcm local request capture complete')
        }})
      Promise.resolve(stream.result()).then(result=>fail(Error('Pi 请求格式转换失败：'+String(result?.errorMessage||result?.stopReason))),fail)
    })
  },signal,timeoutMs))
}
export async function piCompactedContext(snapshot,compaction,messages,{converted=false,blockImages=false}={}){
  const selected=converted?await convert(snapshot.sourceMessages,{blockImages}):snapshot.sourceMessages,indices=messages.flatMap((m,i)=>dialogueMessage(m)?[i]:[])
  if(!selected.length||selected.length>indices.length||selected.some((m,i)=>!isDeepStrictEqual(m,messages[indices[i]])))throw Error('Pi 待替换请求与已核验原文不一致，原文保留')
  const summary=await convert([{role:'compactionSummary',summary:compaction.summary,tokensBefore:compaction.tokensBefore,timestamp:Date.now()}])
  const boundary=indices[selected.length-1]+1
  return [...messages.slice(0,boundary).filter(m=>m.role==='system'),...summary,...messages.slice(boundary)]
}
export async function piForkPlan(snapshot, capture, options={}) {
  // A cold capture is already converted; a live request capture still contains AgentMessages.
  const blockImages=!!capture.blockImages
  return piForkPlanConverted(snapshot,await convert(capture.messages,{blockImages}),{...options,blockImages})
}
async function piForkPlanConverted(snapshot, visible, {checkpoints=[],blockImages=false}={}) {
  const selected = await convert(snapshot.sourceMessages,{blockImages})
  // Every selected message must be the exact beginning of the captured main
  // transcript after system messages. Changed context extensions are blocked.
  const indices = visible.flatMap((message, index) => message.role === 'system' ? [] : [index])
  if (selected.length > indices.length || selected.some((message, i) => !isDeepStrictEqual(message,visible[indices[i]]))) throw Error('Pi 原始请求与归档选区不同，无法原样分支')
  const mapped=[],humanIndices=new Set(),checkpointAt=new Map()
  if(snapshot.sourceEntryIds){
    const individual=[]
    for(let i=0;i<snapshot.sourceMessages.length;i++){
      const part=await convert([snapshot.sourceMessages[i]],{blockImages})
      if(snapshot.sourceMessages[i].role==='compactionSummary'){
        const checkpoint=checkpoints.find(c=>c.entryId===snapshot.sourceEntryIds[i])
        if(!checkpoint||part.length!==1||checkpoint.summaryDigest!==forkHash(snapshot.sourceMessages[i].summary))throw Error('Pi 旧摘要尚未完成归档核验')
        checkpointAt.set(individual.length,checkpoint)
      }
      if(snapshot.sourceMessages[i].role==='user')humanIndices.add(individual.length)
      individual.push(...part);mapped.push(...part.map(()=>snapshot.sourceEntryIds[i]))
    }
    if(serializePiMessages(individual)!==serializePiMessages(selected))throw Error('Pi 消息映射不兼容，原文保留')
  }
  const plan = []; let first = 0, tokens = 0;const pending=new Set()
  const add=(from,to)=>plan.push({index:plan.length,firstMessage:indices[from],lastMessage:indices[to],...forkAnchors(selected.slice(from,to+1)),...(mapped.length?{entryIds:[...new Set(mapped.slice(from,to+1))]}:{})})
  for (let i = 0; i < selected.length; i++) {
    const checkpoint=checkpointAt.get(i)
    if(checkpoint){
      if(pending.size)throw Error('Pi 旧摘要边界存在未闭合工具组')
      if(i>first)add(first,i-1)
      for(const block of checkpoint.blocks)plan.push({...block,index:plan.length,firstMessage:indices[i],lastMessage:indices[i],frozenEntryId:checkpoint.entryId})
      first=i+1;tokens=0;continue
    }
    tokens += estimateSummaryTokens(serializePiMessages([selected[i]]))
    const pairing=summaryToolPairing(JSON.stringify({type:'message',message:selected[i]}))
    if(pairing.endsTurn||humanIndices.has(i))pending.clear()
    for(const id of pairing.opened)pending.add(id);for(const id of pairing.closed)pending.delete(id)
    if(pending.size)continue
    if (tokens < (snapshot.summaryTuning?.targetTokens||20000) && i < selected.length - 1) continue
    add(first,i); first = i + 1; tokens = 0
  }
  if(first!==selected.length)throw Error('Pi 选区存在未闭合工具组，保留原文')
  return plan
}
export async function summarizePiFork(ctx,snapshot,capture,{signal,stage,timeoutMs=600000,progress,isCurrent,forcePrefix=false}={}) {
  return piAuxiliaryRequest(()=>summaryAttempt((abort,renew)=>runPiFork(ctx,snapshot,capture,{signal:abort,stage,timeoutMs,isCurrent,forcePrefix,progress:()=>{renew();progress?.()}}),signal,timeoutMs))
}
async function runPiFork(ctx, snapshot, capture, { signal, stage, timeoutMs, progress, isCurrent,forcePrefix } = {}) {
  if (!capture?.payload || capture.model.provider !== ctx.model?.provider || capture.model.id !== ctx.model?.id) throw Object.assign(Error('Pi 尚未捕获当前模型的原始请求'),{code:'SUPERLCM_PI_CAPTURE_INVALID'})
  let model=capture.model
  if(snapshot.summaryModel){
    const separator=snapshot.summaryModel.indexOf('/')
    model=ctx.modelRegistry.find(snapshot.summaryModel.slice(0,separator),snapshot.summaryModel.slice(separator+1))
    if(separator<1||!model)throw Error('所选 Pi 摘要模型不可用，请重新选择')
  }
  const override=model.provider!==capture.model.provider||model.id!==capture.model.id
  const staged=await stage() // Exact originals and old blocks must be durably archived before model work.
  const stale=()=>Object.assign(Error('Pi 后台分支来源或设置已变化，原文保留'),{code:'SUPERLCM_PI_CAPTURE_INVALID'})
  if(isCurrent&&!isCurrent())throw stale()
  const blockImages=!!capture.blockImages,convertedMessages=await convert(capture.messages,{blockImages})
  const plan = await piForkPlanConverted(snapshot, convertedMessages,{...staged,blockImages}).catch(error=>{error.code='SUPERLCM_PI_CAPTURE_INVALID';throw error})
  signal?.throwIfAborted()
  const target = Math.min(20000, Math.max(2048, snapshot.tokensBefore * .15))
  const nativeReserve=Math.min(piOutputReserve(null,model),override?piOutputReserve(null,model):piOutputReserve(capture.payload,model))
  const planningOptions={fanout:snapshot.summaryTuning?.fanout||4,incremental:true,targetTokens:Math.max(256,Math.min(target,12000,Math.floor(nativeReserve*.65)))}
  const directive = forkDirective(plan, planningOptions.targetTokens,undefined,planningOptions)
  let images = 0
  const encoded = JSON.stringify(convertedMessages, (_key,value) => { if(value?.type === 'image'){images++;return {type:'image'}};return value })
  const limit = model.contextWindow - 1024 - Math.max(1024,model.contextWindow*.02)
  const prefixOnly=forcePrefix||Number.isFinite(limit)&&Math.max(snapshot.tokensBefore,estimatePiRequest(capture.payload),estimateSummaryTokens(encoded)+images*8192)+estimateSummaryTokens(directive)>=limit
  // A resumed near-full session may not fit the retained tail plus a directive.
  // Branch at the already selected history boundary instead. Every summarized
  // message stays intact; the unsummarized tail remains in the foreground.
  const boundary=plan.at(-1).lastMessage+1
  // SDKs that fold system updates into the leading prompt must see the full
  // system state, even when the retained dialogue tail is omitted. Providers
  // with in-place system messages keep their original chronological prefix.
  const inPlaceSystem=model.api==='pi-messages'||(['openai-completions','openai-responses','anthropic-messages'].includes(model.api)&&model.compat?.supportsMidConvoSystemMessages===true)
  const branchMessages=prefixOnly?[...convertedMessages.slice(0,boundary),...(!inPlaceSystem?convertedMessages.slice(boundary).filter(m=>m.role==='system'):[])]:convertedMessages
  const fixed=prefixOnly?Math.max(0,snapshot.tokensBefore-estimatePiRequest(capture.payload)):0
  const requestField=value=>['messages','input','contents'].find(key=>Array.isArray(value?.[key]))||(Array.isArray(value?.context?.messages)?'context.messages':null)
  const requestMessages=(value,field)=>field==='context.messages'?value?.context?.messages:value?.[field]
  const withMessages=(value,field,messages)=>field==='context.messages'?{...value,context:{...value.context,messages}}:{...value,[field]:messages}
  const field = requestField(capture.payload)
  if (!field) throw Object.assign(Error('当前 Pi 供应商没有可原样分支的请求数组'),{code:'SUPERLCM_PI_UNSUPPORTED_REQUEST'})
  let sent = false, wirePrefix, wireSettings, unsupported, invalidated, capacityError
  // summarizePiFork owns one idle deadline for staging, payload conversion and
  // stream consumption; nested timers used to obscure which attempt expired.
  let result
  try {
    const stream=ctx.modelRegistry.streamSimple(model, { messages: [...branchMessages, { role: 'user', content: directive, timestamp: Date.now() }] }, {
    sessionId: snapshot.session_id, reasoning: normalizePiReasoning(capture.reasoning), signal,
    ...(!override&&capture.requestHeaders?{headers:capture.requestHeaders}:{}),
    onPayload(payload) {
      signal?.throwIfAborted()
      if(isCurrent&&!isCurrent()){invalidated=stale();throw invalidated}
      const targetField=override?requestField(payload):field
      const generated=requestMessages(payload,targetField),original=requestMessages(capture.payload,field)
      const instructionAt=Array.isArray(generated)?generated.findLastIndex(item=>item?.role==='user'):-1
      const trailers=instructionAt>=0?generated.slice(instructionAt+1):[]
      // Some SDKs append effort configuration after the final user message.
      // Preserve only their exact, known metadata forms; never skip dialogue.
      if (!targetField||instructionAt<0||!trailers.every(isPiEffortUpdate)) {
        unsupported=Object.assign(Error('Pi 后台摘要请求格式不兼容'),{code:'SUPERLCM_PI_UNSUPPORTED_REQUEST'})
        throw unsupported
      }
      sent = true
      // Replay all native settings, tools, cache controls and original wire
      // messages. Only append the provider-converted final user instruction.
      const generatedPrefix=generated.slice(0,instructionAt)
      let leading=0
      if(prefixOnly&&!['system','developer'].includes(generatedPrefix[0]?.role))while(['system','developer'].includes(original[leading]?.role))leading++
      const nativePrefix=prefixOnly?original.slice(0,leading+generatedPrefix.length):original
      if(!override&&(prefixOnly||field==='contents')&&!isDeepStrictEqual(nativePrefix.slice(leading),generatedPrefix))throw Error('Pi 较早分支与原始请求前缀不一致，原文保留')
      let instruction=generated[instructionAt]
      if(!override&&['anthropic-messages','openai-completions'].includes(model.api)){
        instruction={...instruction};delete instruction.cache_control
        if(Array.isArray(instruction.content))instruction.content=instruction.content.map(block=>{
          if(!block||typeof block!=='object'||!Object.hasOwn(block,'cache_control'))return block
          const copy={...block};delete copy.cache_control;return copy
        })
      }
      let replay = override ? payload : withMessages(clonePiPayload(capture.payload),field,[...structuredClone(nativePrefix),instruction,...trailers])
      // Google SDK requests carry a live AbortSignal in config. The captured
      // request's signal belongs to the old call and cannot be replayed.
      if(!override&&field==='contents'&&(replay.config||payload.config)){
        replay.config={...replay.config}
        if(payload.config&&Object.hasOwn(payload.config,'abortSignal'))replay.config.abortSignal=payload.config.abortSignal
        else delete replay.config.abortSignal
      }
      const finalize=replay=>{
      signal?.throwIfAborted()
      if(isCurrent&&!isCurrent()){invalidated=stale();throw invalidated}
      const transformedField=requestField(replay)
      if(transformedField!==targetField){unsupported=Object.assign(Error('Pi 请求处理链改变了摘要请求结构，原文保留'),{code:'SUPERLCM_PI_UNSUPPORTED_REQUEST'});throw unsupported}
      const input=prefixOnly?estimatePiRequest(replay)+fixed:Math.max(snapshot.tokensBefore,estimatePiRequest(replay))
      const available=model.contextWindow-input-Math.max(1024,model.contextWindow*.02)-1
      if(available<1){capacityError=Object.assign(Error('Pi 后台分支最终请求没有足够输入空间，原文保留'),{code:'SUPERLCM_PI_PREFIX_CAPACITY'});throw capacityError}
      try{replay=limitPiOutput(replay,model,Math.min(available,nativeReserve))}catch(error){
        if(error.code==='SUPERLCM_PI_OUTPUT_CAPACITY')capacityError=Object.assign(error,{code:'SUPERLCM_PI_PREFIX_CAPACITY'})
        else if(['SUPERLCM_PI_UNSUPPORTED_REQUEST','SUPERLCM_PI_INVALID_BUDGET'].includes(error.code))unsupported=error
        throw error
      }
      const finalLimit=model.contextWindow-piOutputReserve(replay,model)-Math.max(1024,model.contextWindow*.02)
      if(!Number.isFinite(finalLimit)||finalLimit<=0)throw Error('Pi 摘要模型缺少有效输入容量，原文保留')
      wirePrefix=requestMessages(replay,targetField).slice(0,override?generatedPrefix.length:nativePrefix.length)
      wireSettings=targetField==='context.messages'?withMessages(replay,targetField,undefined):Object.fromEntries(Object.entries(replay).filter(([key])=>key!==targetField))
      if (input >= finalLimit) {capacityError=Object.assign(Error('Pi 后台分支最终请求没有足够输入空间，原文保留'),{code:'SUPERLCM_PI_PREFIX_CAPACITY'});throw capacityError}
      return replay
      }
      // Apply the same complete extension chain to every branch byte, including
      // summary instructions/anchors. Later redactors must never be bypassed.
      return capture.transformPayload?Promise.resolve(capture.transformPayload(replay)).then(finalize):finalize(replay)
    }
    })
    if(typeof stream?.[Symbol.asyncIterator]==='function')for await(const event of stream){
      signal?.throwIfAborted()
      if(['text_delta','thinking_delta'].includes(event.type)&&typeof event.delta==='string'&&event.delta.trim())progress?.()
    }
    result=await stream.result()
  }catch(error){if(invalidated)throw invalidated;if(capacityError)throw capacityError;if(unsupported)throw unsupported;throw error}
  signal?.throwIfAborted()
  if(invalidated)throw invalidated
  if(capacityError)throw capacityError
  if(unsupported)throw unsupported
  if(!result||typeof result.stopReason!=='string'||!Array.isArray(result.content)||result.content.some(block=>!block||typeof block.type!=='string'))throw Object.assign(Error('Pi 供应商没有返回有效的完成结果，原文保留'),{code:'SUPERLCM_PI_UNSUPPORTED_REQUEST'})
  if (!sent || result.stopReason !== 'stop' || result.content.some(block => block.type === 'toolCall')) {
    const message=String(result.errorMessage||result.stopReason||'缺少完成回执')
    const code=message.includes('upstream_reset_replay_refused')?'SUPERLCM_PI_REPLAY_REFUSED':result.stopReason==='length'?'SUPERLCM_PI_PREFIX_CAPACITY':result.content.some(block=>block.type==='toolCall')?'SUPERLCM_PI_INVALID_SUMMARY':null
    throw Object.assign(Error('Pi 后台分支未完整结束，原文保留：'+message.slice(0,1000)),code?{code}:{})
  }
  // Planning allocates space across levels; it is not an exact tokenizer limit.
  // Persist the sent output limit so the archive worker revalidates the same
  // tree without imposing the smaller prompt goal a second time. The installed
  // root still has its independent compaction and request-capacity checks.
  const text=result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  const sentLimit=piOutputReserve(wireSettings,model),actual=result.usage?.output
  const countedInput=['input','cacheRead','cacheWrite'].map(key=>result.usage?.[key]??0)
  // Subscription gateways may remove an unsupported output cap. A complete
  // reply is still usable when its full receipt (including cached input and
  // reasoning output) fits both the original output allowance and the window.
  const receiptFits=Number.isSafeInteger(actual)&&actual>0&&actual<=nativeReserve&&countedInput.every(n=>Number.isSafeInteger(n)&&n>=0)&&countedInput.some(n=>n>0)&&countedInput.reduce((a,b)=>a+b,0)+actual+Math.max(1024,model.contextWindow*.02)<model.contextWindow
  if(Number.isFinite(actual)&&actual>sentLimit){
    if(actual>nativeReserve)throw Object.assign(Error('Pi 供应商返回的输出用量超过原始额度，原文保留'),{code:'SUPERLCM_PI_UNSUPPORTED_REQUEST'})
    if(!receiptFits)throw Object.assign(Error('Pi 后台分支输出回执无法确认窗口安全，需缩小完整前缀。原文保留'),{code:'SUPERLCM_PI_PREFIX_CAPACITY'})
  }
  // The continuation root is checked independently before installation. Never
  // discard a usable, completed reply just because a gateway ignored our cap.
  const verified=Number.isSafeInteger(actual)&&actual>0&&(actual<=sentLimit||receiptFits)
  const treeOptions={fanout:planningOptions.fanout,incremental:true,targetTokens:verified?Math.max(sentLimit,estimateSummaryTokens(text)):sentLimit}
  let tree
  try{tree=parseForkTree(text,plan,undefined,treeOptions)}
  catch(error){throw Object.assign(error,{code:'SUPERLCM_PI_INVALID_SUMMARY'})}
  const blocks=tree.filter(n=>n.level===0)
  return { blocks, tree, treeOptions, model: model.id, provider: model.provider, usage: result.usage,
    sourceDigest: forkHash(snapshot.source), prefixHash: forkHash(wirePrefix), requestSettingsHash: forkHash(wireSettings) }
}
