import { dirname, join } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { findCli } from './runtime.js'
import { forkHash, forkAnchors, forkDirective, parseForkTree } from './fork-summary.js'
import {summaryToolPairing} from './summary-source.js'
import { estimateSummaryTokens } from './summary-tokens.js'
import { serializePiMessages } from './pi-snapshot.js'
import { summaryAttempt } from './summary-attempt.js'
import { estimatePiRequest, piOutputReserve,limitPiOutput } from './pi-request.js'
let converter
async function convert(messages) {
  if (!converter) {
    let root = dirname(realpathSync(findCli('pi')))
    while (!existsSync(join(root, 'package.json'))) { const parent = dirname(root); if (parent === root) throw Error('未找到 Pi 公共接口'); root = parent }
    converter = (await import(pathToFileURL(join(root, 'dist/index.js')))).convertToLlm
  }
  return converter(messages)
}
// Convert through the configured provider without dispatching an HTTP request.
// Cold sessions can prepare before permitting their first foreground request.
export async function capturePiContext(ctx,messages,reasoning,signal){
  const controller=new AbortController(),selected=await convert(messages)
  let payload
  const stream=ctx.modelRegistry.streamSimple(ctx.model,{messages:selected},{sessionId:ctx.sessionManager.getSessionId(),reasoning,
    signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,
    onPayload(value){payload=structuredClone(value);controller.abort();throw Error('SuperLcm local request capture complete')}})
  const result=await stream.result()
  signal?.throwIfAborted()
  if(!payload)throw Error('Pi 请求格式转换失败：'+String(result.errorMessage||result.stopReason))
  return {payload,messages:selected,model:structuredClone(ctx.model),reasoning}
}
export async function piCompactedContext(snapshot,compaction,messages){
  const selected=await convert(snapshot.sourceMessages),indices=messages.flatMap((m,i)=>m.role==='system'?[]:[i])
  if(!selected.length||selected.length>indices.length||selected.some((m,i)=>!isDeepStrictEqual(m,messages[indices[i]])))throw Error('Pi 待替换请求与已核验原文不一致，原文保留')
  const summary=await convert([{role:'compactionSummary',summary:compaction.summary,tokensBefore:compaction.tokensBefore,timestamp:Date.now()}])
  return [...messages.filter(m=>m.role==='system'),...summary,...messages.slice(indices[selected.length-1]+1).filter(m=>m.role!=='system')]
}
export async function piForkPlan(snapshot, capture, {checkpoints=[]}={}) {
  const selected = await convert(snapshot.sourceMessages)
  const visible = capture.messages
  // Every selected message must be the exact beginning of the captured main
  // transcript after system messages. Changed context extensions are blocked.
  const indices = visible.flatMap((message, index) => message.role === 'system' ? [] : [index])
  if (selected.length > indices.length || selected.some((message, i) => !isDeepStrictEqual(message,visible[indices[i]]))) throw Error('Pi 原始请求与归档选区不同，无法原样分支')
  const mapped=[],humanIndices=new Set(),checkpointAt=new Map()
  if(snapshot.sourceEntryIds){
    const individual=[]
    for(let i=0;i<snapshot.sourceMessages.length;i++){
      const part=await convert([snapshot.sourceMessages[i]])
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
export async function summarizePiFork(ctx,snapshot,capture,{signal,stage,timeoutMs=600000,progress}={}) {
  return summaryAttempt((abort,renew)=>runPiFork(ctx,snapshot,capture,{signal:abort,stage,timeoutMs,progress:()=>{renew();progress?.()}}),signal,timeoutMs)
}
async function runPiFork(ctx, snapshot, capture, { signal, stage, timeoutMs, progress } = {}) {
  if (!capture?.payload || capture.model.provider !== ctx.model?.provider || capture.model.id !== ctx.model?.id) throw Object.assign(Error('Pi 尚未捕获当前模型的原始请求'),{code:'SUPERLCM_PI_CAPTURE_INVALID'})
  let model=capture.model
  if(snapshot.summaryModel){
    const separator=snapshot.summaryModel.indexOf('/')
    model=ctx.modelRegistry.find(snapshot.summaryModel.slice(0,separator),snapshot.summaryModel.slice(separator+1))
    if(separator<1||!model)throw Error('所选 Pi 摘要模型不可用，请重新选择')
  }
  const override=model.provider!==capture.model.provider||model.id!==capture.model.id
  const staged=await stage() // Exact originals and old blocks must be durably archived before model work.
  const plan = await piForkPlan(snapshot, capture,staged).catch(error=>{error.code='SUPERLCM_PI_CAPTURE_INVALID';throw error})
  signal?.throwIfAborted()
  const target = Math.min(20000, Math.max(2048, snapshot.tokensBefore * .15))
  const nativeReserve=override?piOutputReserve(null,model):piOutputReserve(capture.payload,model)
  const planningOptions={fanout:snapshot.summaryTuning?.fanout||4,incremental:true,targetTokens:Math.max(256,Math.min(target,12000,Math.floor(nativeReserve*.65)))}
  const directive = forkDirective(plan, planningOptions.targetTokens,undefined,planningOptions)
  let images = 0
  const encoded = JSON.stringify(capture.messages, (_key,value) => { if(value?.type === 'image'){images++;return {type:'image'}};return value })
  const limit = model.contextWindow - 1024 - Math.max(1024,model.contextWindow*.02)
  const prefixOnly=Number.isFinite(limit)&&Math.max(snapshot.tokensBefore,estimateSummaryTokens(encoded)+images*8192)+estimateSummaryTokens(directive)>=limit
  // A resumed near-full session may not fit the retained tail plus a directive.
  // Branch at the already selected history boundary instead. Every summarized
  // message stays intact; the unsummarized tail remains in the foreground.
  const branchMessages=prefixOnly?capture.messages.slice(0,plan.at(-1).lastMessage+1):capture.messages
  const fixed=prefixOnly?Math.max(0,snapshot.tokensBefore-estimatePiRequest(capture.payload)):0
  const field = Array.isArray(capture.payload.messages) ? 'messages' : Array.isArray(capture.payload.input) ? 'input' : null
  if (!field) throw Error('当前 Pi 供应商没有可原样分支的请求数组')
  let sent = false, wirePrefix, wireSettings
  const result = await summaryAttempt(async (abort,renew) => {
    const stream=ctx.modelRegistry.streamSimple(model, { messages: [...branchMessages, { role: 'user', content: directive, timestamp: Date.now() }] }, {
    sessionId: snapshot.session_id, reasoning: capture.reasoning, signal: abort,
    onPayload(payload) {
      abort.throwIfAborted()
      const targetField=override?(Array.isArray(payload.messages)?'messages':Array.isArray(payload.input)?'input':null):field
      if (!targetField||!Array.isArray(payload[targetField]) || payload[targetField].at(-1)?.role !== 'user') throw Error('Pi 后台摘要请求格式不兼容')
      sent = true
      // Replay all native settings, tools, cache controls and original wire
      // messages. Only append the provider-converted final user instruction.
      const generatedPrefix=payload[targetField].slice(0,-1)
      let leading=0
      if(prefixOnly&&!['system','developer'].includes(generatedPrefix[0]?.role))while(['system','developer'].includes(capture.payload[field][leading]?.role))leading++
      const nativePrefix=prefixOnly?capture.payload[field].slice(0,leading+generatedPrefix.length):capture.payload[field]
      if(prefixOnly&&!override&&!isDeepStrictEqual(nativePrefix.slice(leading),generatedPrefix))throw Error('Pi 较早分支与原始请求前缀不一致，原文保留')
      let replay = override ? payload : { ...structuredClone(capture.payload), [field]: [...structuredClone(nativePrefix), payload[field].at(-1)] }
      const input=prefixOnly?estimatePiRequest(replay)+fixed:Math.max(snapshot.tokensBefore,estimatePiRequest(replay))
      const available=model.contextWindow-input-Math.max(1024,model.contextWindow*.02)-1
      if(available<1)throw Error('Pi 后台分支最终请求没有足够输入空间，原文保留')
      replay=limitPiOutput(replay,model,available)
      const finalLimit=model.contextWindow-piOutputReserve(replay,model)-Math.max(1024,model.contextWindow*.02)
      if(!Number.isFinite(finalLimit)||finalLimit<=0)throw Error('Pi 摘要模型缺少有效输入容量，原文保留')
      wirePrefix=replay[targetField].slice(0,-1);wireSettings=Object.fromEntries(Object.entries(replay).filter(([key])=>key!==targetField))
      if (input >= finalLimit) throw Error('Pi 后台分支最终请求没有足够输入空间，原文保留')
      return replay
    }
    })
    if(typeof stream?.[Symbol.asyncIterator]==='function')for await(const event of stream){
      abort.throwIfAborted()
      if(['text_delta','thinking_delta'].includes(event.type)&&typeof event.delta==='string'&&event.delta.trim()){renew();progress?.()}
    }
    return stream.result()
  }, signal, timeoutMs)
  signal?.throwIfAborted()
  if (!sent || result.stopReason !== 'stop' || result.content.some(block => block.type === 'toolCall')) throw Error('Pi 后台分支未完整结束，原文保留：'+String(result.errorMessage||result.stopReason||'缺少完成回执').slice(0,1000))
  // Planning allocates space across levels; it is not an exact tokenizer limit.
  // Persist the sent output limit so the archive worker revalidates the same
  // tree without imposing the smaller prompt goal a second time. The installed
  // root still has its independent compaction and request-capacity checks.
  const text=result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  const sentLimit=piOutputReserve(wireSettings,model),actual=result.usage?.output
  if(Number.isFinite(actual)&&actual>sentLimit)throw Error('Pi 后台分支实际输出超过发送额度，原文保留')
  // A tokenizer estimate cannot overrule a complete provider receipt within
  // its sent limit. The continuation root is checked independently at install.
  const verified=Number.isSafeInteger(actual)&&actual>0&&actual<=sentLimit
  const treeOptions={fanout:planningOptions.fanout,incremental:true,targetTokens:verified?Math.max(sentLimit,estimateSummaryTokens(text)):sentLimit}
  const tree = parseForkTree(text, plan,undefined,treeOptions)
  const blocks=tree.filter(n=>n.level===0)
  return { blocks, tree, treeOptions, model: model.id, provider: model.provider, usage: result.usage,
    sourceDigest: forkHash(snapshot.source), prefixHash: forkHash(wirePrefix), requestSettingsHash: forkHash(wireSettings) }
}
