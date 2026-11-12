import { CHECKPOINT_PREAMBLE } from './checkpoint-frame.js'
import {forkScope} from './fork-scope.js'
export {forkScope} from './fork-scope.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { compactCheckpointSource, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { prepareAsyncRegion } from './async-region.js'
import { appendRecallEnvelope } from './marker.js'
import { completeSummaryStream } from './summary-session.js'
import { summaryAttempt } from './summary-attempt.js'
import {forkRoute} from './fork-route.js'
import {abortable} from './summary-attempt.js'
import { currentPolicy } from './ratio-runtime.js'
import { selectionPricing } from './selection-pricing.js'
import { draftNode, assembleTree } from './draft-tree.js'
import { forkDirective, forkAnchors, forkHash, parseForkTree } from './fork-summary.js'
import { estimateSummaryTokens } from '../src/summary-tokens.js'
import { reindexSession, nodeLevel } from './core.js'
import {publishForkArchive,withForkLease,forkArchiveSnapshot} from './archive-fork.js'
import {assembleRegions} from './assembled-region.js'
import {markerFromSummary} from './marker.js'
import { dshSummaryLanguage } from './dsh-summary-language.js'
import {stripRecallMetadata,contentBlocksToText} from './marker.js'
import {reusableGranularFrontier,originalNodeSources} from './tree-semantics.js'

export function captureMainRequest(engine, agent, options) {
  engine.mainRequests ??= new WeakMap()
  const {signal, ...request} = options
  let originalMaxTokens=request.maxTokens
  try {
    const row=engine.outputBudgetState?.read(agent.session.id)
    if(row?.active===1&&row.provider===request.provider&&row.model===request.model&&row.effective===request.maxTokens
      &&row.option_max===(agent.options?.maxTokens??null)&&Number.isSafeInteger(row.requested)&&row.requested>=row.effective)originalMaxTokens=row.requested
  } catch { engine.ctx?.logger?.warn?.('无法读取原始输出额度，后台摘要使用当前请求上限') }
  engine.mainRequests.set(agent, {request: structuredClone(request), originalMaxTokens, generation: engine.runtimeGeneration})
}
export async function summarizeMainFork(engine, agent, prepared, signal, capture=engine.mainRequests?.get(agent), retry={}) {
  const policy=currentPolicy(engine,agent)
  if(!policy)throw Error('后台摘要的压缩策略已变化')
  return summaryAttempt((attempt,progress)=>runMainFork(engine,agent,prepared,attempt,capture,policy,retry,progress),signal,policy.summaryTimeoutMs)
}
async function runMainFork(engine,agent,prepared,signal,capture,policy,retry,progress) {
  if (!capture || capture.generation !== engine.runtimeGeneration) throw Error('DSH 尚未捕获当前模型的原始请求')
  if (!Number.isFinite(policy?.inputBudget)) throw Error('主模型分支需要按模型容量管理压缩')
  const indexed = reindexSession(engine.superLcmStore,agent.session)
  if (indexed.errors.length) throw Error('DSH 原文归档未完成')
  const route=await summaryAttempt(async abort=>{
    if(engine.rollingConfig.forkModelOverride)await abortable(engine.summaryModelReady,abort)
    return forkRoute(engine.rollingConfig.forkModelOverride?(engine.summaryContext||engine.ctx):engine.ctx,capture.request,{enabled:engine.rollingConfig.forkModelOverride,provider:engine.config.summarizationProvider,model:engine.config.summarizationModel},abort)
  },signal,15000)
  const request = route.request, byId = new Map(request.messages.map((message,index)=>[message.id,{message,index}]))
  const requested = !engine.rollingConfig.forkModelOverride && Number.isSafeInteger(capture.originalMaxTokens)
    ? capture.originalMaxTokens : request.maxTokens ?? 16384
  const measurement = engine.ctx.tokenMeter.measure(agent.session)
  const priced = selectionPricing(measurement, agent.session.requestHeader(), agent.session)
  const windowLimit = Math.min(policy.contextWindow, route.contextWindow ?? Infinity)
  const target = Math.max(256,Math.min(Math.floor(policy.summaryPrefixTargetTokens*.7),Math.floor(requested*.65)))
  const treeOptions={fanout:policy.condensedMinFanout||4,targetTokens:target,incremental:true}
  const language=dshSummaryLanguage(agent.session)
  const correction=['invalid_json','invalid_summary'].includes(retry.previousFailure)
    ? '\nThe previous attempt failed output validation. Return only the required JSON object, escape every double quote (\\") and newline (\\n) inside summary strings, separate array elements with commas, include every planned leaf and parent exactly once in index order, start each summary with a heading in the requested language, and respect the single shared output budget. Do not call tools or continue the task.' : ''
  const buildPlan = () => {
    const builtParts = []; let from = 0, tokens = 0
    const addPart=(start,end,carried=null,snapshot=false)=>{
      const part=prepareAsyncRegion(engine,agent,{start:prepared.shadowedSeqs[start],end:prepared.shadowedSeqs[end]})
      const originals=part.shadowedSeqs.map(seq=>agent.session.deriveEventMessage(agent.session.eventAt(seq))).filter(Boolean)
      const positions=originals.map(message=>{const found=byId.get(message.id);if(!found||!isDeepStrictEqual(found.message,message))throw Error('DSH 原始请求与归档选区不同，无法原样分支');return found.index})
      if(!positions.length||positions.some((n,index)=>index&&n!==positions[index-1]+1))throw Error('DSH 后台分块缺少连续原文')
      builtParts.push({...part,carried,snapshot,...(carried?{treeSourceSeqs:originalNodeSources(engine.superLcmStore,agent.session.id,carried.nodeId,seq=>agent.session.eventAt(seq))}:{}),range:{index:builtParts.length,firstMessage:positions[0],lastMessage:positions.at(-1),...forkAnchors(originals),...(carried?{frozenSummary:carried.summaryText,frozenLevel:snapshot?0:nodeLevel(engine.superLcmStore,agent.session.id,carried.nodeId)-1}:{})}})
    }
    for(let i=0;i<prepared.shadowedSeqs.length;i++){
      const event=agent.session.eventAt(prepared.shadowedSeqs[i]),marker=event.data?.source?.kind==='compact-checkpoint'&&markerFromSummary(event.data.content)
      if(marker){
        if(i>from)addPart(from,i-1)
        const old=engine.superLcmStore.getNode(agent.session.id,marker.id)
        if(!old)throw Error('DSH 已有摘要祖先缺失，保留原文')
        for(const member of reusableGranularFrontier(engine.superLcmStore,agent.session.id,old.nodeId,seq=>agent.session.eventAt(seq)))addPart(i,i,engine.superLcmStore.getNode(agent.session.id,member.id),member.snapshot)
        from=i+1;tokens=0;continue
      }
      tokens+=Math.ceil(prepared.selectedNodes[i].tokens*priced.factor)
      if((tokens<policy.foldBatchTokens||!toolPairingBalancedAfter(agent.session,prepared.shadowedSeqs[i]))&&i<prepared.shadowedSeqs.length-1)continue
      addPart(from,i);from=i+1;tokens=0
    }
    const builtPlan = builtParts.map(part=>part.range)
    const builtDirective = forkDirective(builtPlan,target,language.name,treeOptions)+correction
    const builtDirectiveTokens = engine.ctx.tokenMeter.estimateMessage(createUserMessage({content:[{type:'text',text:builtDirective}]}))
    return { parts: builtParts, plan: builtPlan, directive: builtDirective, directiveTokens: builtDirectiveTokens }
  }
  const shrinkPrepared = (ratio = 1, directiveOverhead = 2048) => {
    const surfaceNodes = agent.session.surface.nodes
    const currentShadowed = priced.nodes.slice(prepared.startIdx, prepared.endIdx + 1).reduce((sum, node) => sum + node.tokens, 0)
    const maxShadowed = ratio < 1 ? Math.floor(currentShadowed * ratio) : Infinity
    const minOutputReserve = Math.max(1024, Math.min(4096, policy.summaryPrefixTargetTokens))
    let chosenIdx = -1, fallbackIdx = -1
    for (let idx = prepared.endIdx - 1; idx >= prepared.startIdx; idx--) {
      if (!toolPairingBalancedAfter(agent.session, surfaceNodes[idx])) continue
      const dropped = priced.nodes.slice(idx + 1).reduce((sum, node) => sum + node.tokens, 0)
      const candidateActive = Math.max(0, prepared.activeTokens - dropped)
      if (windowLimit - candidateActive - directiveOverhead - 1024 < minOutputReserve) continue
      if (fallbackIdx < 0) fallbackIdx = idx
      const candidateShadowed = priced.nodes.slice(prepared.startIdx, idx + 1).reduce((sum, node) => sum + node.tokens, 0)
      if (candidateShadowed <= maxShadowed) { chosenIdx = idx; break }
    }
    const targetIdx = chosenIdx >= 0 ? chosenIdx : fallbackIdx
    if (targetIdx < 0) return false
    const shrunk = prepareAsyncRegion(engine, agent, { ...prepared, end: surfaceNodes[targetIdx] })
    Object.assign(prepared, shrunk)
    const fold = engine.backgroundFolds?.get(agent)
    if (fold) {
      fold.forcePrefix = true
      if (fold.cutoffEnd === undefined || surfaceNodes.indexOf(fold.cutoffEnd) > targetIdx) fold.cutoffEnd = prepared.end
      if (fold.selection) fold.selection = { ...fold.selection, end: prepared.end }
    }
    return true
  }
  let prefixOnly = false
  if (['length', 'context_window_exceeded'].includes(retry.previousFailure)) {
    if (!shrinkPrepared(0.8)) throw Object.assign(Error('后台摘要的完整消息组无法继续缩小，原文和当前请求已保留。'), { code: 'SUPERLCM_FORK_CAPACITY' })
    prefixOnly = true
  }
  let { parts, plan, directive, directiveTokens } = buildPlan()
  let remaining = windowLimit - prepared.activeTokens - directiveTokens - 1024
  if (remaining < 1024 || prefixOnly) {
    if (engine.rollingConfig.forkModelOverride && (route.contextWindow ?? Infinity) < policy.contextWindow && remaining < 1024) {
      throw Object.assign(Error('DSH 后台分支没有足够输入空间，原文保留'), { code: 'SUPERLCM_FORK_CAPACITY' })
    }
    prefixOnly = true
    const currentTailTokens = priced.nodes.slice(prepared.endIdx + 1).reduce((sum, node) => sum + node.tokens, 0)
    remaining = windowLimit - Math.max(0, prepared.activeTokens - currentTailTokens) - directiveTokens - 1024
    if (remaining < 1024 && shrinkPrepared(1, directiveTokens)) {
      ;({ parts, plan, directive, directiveTokens } = buildPlan())
      const shrunkTailTokens = priced.nodes.slice(prepared.endIdx + 1).reduce((sum, node) => sum + node.tokens, 0)
      remaining = windowLimit - Math.max(0, prepared.activeTokens - shrunkTailTokens) - directiveTokens - 1024
    }
  }
  if(remaining<1024)throw Object.assign(Error('DSH 后台分支没有足够输入空间，原文保留'),{code:'SUPERLCM_FORK_CAPACITY'})
  // A late start/restart can already be past the normal preparation point.
  // Keep the entire frozen prefix; only limit auxiliary output to make room
  // for the appended directive instead of retrying an impossible reservation.
  const maxTokens=Math.min(requested,Math.floor(remaining))
  const branchMessages = prefixOnly ? request.messages.slice(0, plan.at(-1).lastMessage + 1) : request.messages
  const options = {...request,maxTokens,messages:[...branchMessages,createUserMessage({content:[{type:'text',text:directive}]})]}
  const archiveSnapshot=forkArchiveSnapshot(engine.superLcmStore.path)
  const raw = [], usage = {}; let text = ''
  await withForkLease(engine.superLcmStore.path,agent.session.id,policy.signature||'main-fork',signal,leasedSignal=>forkScope.run(true,async()=>{
    for await (const chunk of completeSummaryStream(route.ctx.llm.stream({...options,signal:leasedSignal}),leasedSignal)) {
      if (['text-delta','reasoning-delta'].includes(chunk.type) && typeof chunk.text==='string' && chunk.text.trim()) progress()
      raw.push(chunk)
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'usage') Object.assign(usage,chunk.usage)
    }
  }))
  signal?.throwIfAborted()
  // The whole archival tree uses the branch's output allowance. Only the root
  // installed in the foreground must fit summaryPrefixTargetTokens below.
  const inputUsage = ['inputTokens','cacheReadTokens','cacheWriteTokens'].map(key => usage[key] ?? 0)
  const output = usage.outputTokens
  const reported = Number.isSafeInteger(output) && output > 0
  const receiptFits = reported && output <= requested && inputUsage.every(n => Number.isSafeInteger(n) && n >= 0)
    && inputUsage.some(n => n > 0) && inputUsage.reduce((sum,n) => sum+n,0) + output + 1024 < windowLimit
  if (reported && output > requested) throw Object.assign(Error('后台摘要输出超过原始请求上限，原文和当前请求已保留。'), { code:'SUPERLCM_FORK_INVALID_OUTPUT' })
  if (reported && output > maxTokens && !receiptFits) throw Object.assign(Error('后台摘要的输出回执无法确认窗口安全，原文已保留。'), { code:'SUPERLCM_FORK_SUMMARY_BUDGET' })
  const verified = reported && (output <= maxTokens || receiptFits)
  const hardTreeBudget = verified ? Math.max(maxTokens, estimateSummaryTokens(text)) : maxTokens
  let blocks
  try { blocks = parseForkTree(text,plan,language,{...treeOptions,targetTokens:hardTreeBudget}) }
  catch (error) { if (error.message === '后台分支摘要超过总输出预算') error.code = 'SUPERLCM_FORK_SUMMARY_BUDGET'; throw error }
  const built=[]
  for(const block of blocks){
    const children=block.children.map(i=>built[i])
    if(block.level===0&&parts[block.index].carried&&!parts[block.index].snapshot){
      const part=parts[block.index],old=part.carried
      built.push({...part,summary:old.summary,checkpointMessage:agent.session.eventAt(part.start).data,compactionId:old.compactionId,provider:old.provider,model:old.model,trustedChildNodeIds:old.childIds,treeKind:old.kind||'leaf',depth:nodeLevel(engine.superLcmStore,agent.session.id,old.nodeId)})
      continue
    }
    // Granular archive blocks can be larger than the old rolling checkpoint.
    // Only the final continuation checkpoint is installed; its hard limit and
    // stable surface selection are checked independently below and at commit.
    const part=block.level===0?parts[block.index]:assembleRegions(engine,children,{checkSize:false})
    const snapshot=block.level===0&&part.snapshot
    const childIds=block.level===0?part.trustedChildNodeIds:children.map(p=>markerFromSummary(p.summary).id)
    const treeSourceSeqs=block.level===0?(part.snapshot?part.treeSourceSeqs:part.shadowedSeqs):[...new Set(children.flatMap(p=>p.treeSourceSeqs??p.shadowedSeqs))].sort((a,b)=>a-b)
    const compactionId=randomUUID()
    // A model-written parent can contain facts absent from its children.
    // Keep the actual parent even when child checkpoints have different depths.
    const summary=appendRecallEnvelope([{type:'text',text:block.summary}],{id:randomUUID(),children:childIds})
    const checkpointMessage=createUserMessage({content:[{type:'text',text:CHECKPOINT_PREAMBLE+'\n\n<compacted-summary>'},...summary,{type:'text',text:'</compacted-summary>'}],source:compactCheckpointSource(compactionId)})
    built.push({...part,carried:null,snapshot,summary,checkpointMessage,compactionId,provider:request.provider,model:request.model,
      trustedChildNodeIds:childIds,treeKind:snapshot?'snapshot':block.kind,treeSourceSeqs,
      usage:block.index===0?usage:{},depth:snapshot?1:block.level===0?1+Math.max(0,...childIds.map(id=>nodeLevel(engine.superLcmStore,agent.session.id,id))):1+Math.max(...children.map(p=>p.depth)),rawOutput:block.index===0?raw:undefined})
  }
  built.at(-1).usage=usage;built.at(-1).rawOutput=raw;built.at(-1).summaryTreeFormat='incremental-v1'
  const allTree=built.map(draftNode),tree=allTree.filter((n,i)=>!built[i].carried),frontier=[built.at(-1)]
  const summarized=assembleTree(engine,frontier,tree,parts.length)
  const archiveTree=blocks.map((block,index)=>({id:'native:'+allTree[index].nodeId,nativeId:allTree[index].nodeId,kind:built[index].treeKind,level:built[index].depth-1,summary:stripRecallMetadata(contentBlocksToText(built[index].summary)),modelSummary:block.modelSummary,
    sources:built[index].treeSourceSeqs??built[index].shadowedSeqs,children:built[index].trustedChildNodeIds.map(id=>'native:'+id)}))
  if (engine.ctx.tokenMeter.estimateMessage(summarized.checkpointMessage)>policy.summaryPrefixTargetTokens) throw Object.assign(Error('DSH 后台分支最终摘要超过预算，原文保留。'), { code:'SUPERLCM_FORK_SUMMARY_BUDGET' })
  try{await publishForkArchive(engine.superLcmStore.path,agent.session.id,archiveTree,{provider:request.provider,model:request.model,usage},archiveSnapshot)}catch(error){engine.ctx.logger?.warn?.('后台摘要归档待重试：'+error.message)}
  return {...summarized,summaryTreeFormat:'incremental-v1',forkParts:frontier,forkLeafCount:parts.length,rawOutput:raw,usage,prefixHash:forkHash(request.messages),mainFork:true}
}
