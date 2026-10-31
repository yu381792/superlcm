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
import { draftNode, assembleTree } from './draft-tree.js'
import { forkDirective, forkAnchors, forkHash, parseForkTree } from './fork-summary.js'
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
  engine.mainRequests.set(agent, {request: structuredClone(request), generation: engine.runtimeGeneration})
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
  const parts = []; let from = 0, tokens = 0
  const addPart=(start,end,carried=null,snapshot=false)=>{
    const part=prepareAsyncRegion(engine,agent,{start:prepared.shadowedSeqs[start],end:prepared.shadowedSeqs[end]})
    const originals=part.shadowedSeqs.map(seq=>agent.session.deriveEventMessage(agent.session.eventAt(seq))).filter(Boolean)
    const positions=originals.map(message=>{const found=byId.get(message.id);if(!found||!isDeepStrictEqual(found.message,message))throw Error('DSH 原始请求与归档选区不同，无法原样分支');return found.index})
    if(!positions.length||positions.some((n,index)=>index&&n!==positions[index-1]+1))throw Error('DSH 后台分块缺少连续原文')
    parts.push({...part,carried,snapshot,...(carried?{treeSourceSeqs:originalNodeSources(engine.superLcmStore,agent.session.id,carried.nodeId,seq=>agent.session.eventAt(seq))}:{}),range:{index:parts.length,firstMessage:positions[0],lastMessage:positions.at(-1),...forkAnchors(originals),...(carried?{frozenSummary:carried.summaryText,frozenLevel:snapshot?0:nodeLevel(engine.superLcmStore,agent.session.id,carried.nodeId)-1}:{})}})
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
    tokens+=prepared.selectedNodes[i].tokens
    if((tokens<policy.foldBatchTokens||!toolPairingBalancedAfter(agent.session,prepared.shadowedSeqs[i]))&&i<prepared.shadowedSeqs.length-1)continue
    addPart(from,i);from=i+1;tokens=0
  }
  const plan = parts.map(part=>part.range), target = Math.max(256,Math.min(Math.floor(policy.summaryPrefixTargetTokens*.7),Math.floor((request.maxTokens||16384)*.65)))
  const treeOptions={fanout:policy.condensedMinFanout||4,targetTokens:target,incremental:true}
  const language=dshSummaryLanguage(agent.session)
  const correction=['invalid_json','invalid_summary'].includes(retry.previousFailure)
    ? '\nThe previous attempt failed output validation. Return only the required JSON object, include every planned leaf and parent exactly once in index order, start each summary with a heading in the requested language, and respect the single shared output budget. Do not call tools or continue the task.' : ''
  const directive = forkDirective(plan,target,language.name,treeOptions)+correction
  const directiveTokens = engine.ctx.tokenMeter.estimateMessage(createUserMessage({content:[{type:'text',text:directive}]}))
  const remaining=Math.min(policy.contextWindow,route.contextWindow??Infinity)-prepared.activeTokens-directiveTokens-1024
  if(remaining<1024)throw Object.assign(Error('DSH 后台分支没有足够输入空间，原文保留'),{code:'SUPERLCM_FORK_CAPACITY'})
  // A late start/restart can already be past the normal preparation point.
  // Keep the entire frozen prefix; only limit auxiliary output to make room
  // for the appended directive instead of retrying an impossible reservation.
  const maxTokens=Math.min(request.maxTokens??16384,Math.floor(remaining))
  const options = {...request,maxTokens,messages:[...request.messages,createUserMessage({content:[{type:'text',text:directive}]})]}
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
  // The prompt target is a planning goal, not an exact tokenizer result.
  // Keep a separate hard tree limit and still check the installed root below.
  const hardTreeBudget=Math.min(policy.summaryPrefixTargetTokens,maxTokens)
  const blocks = parseForkTree(text,plan,language,{...treeOptions,targetTokens:hardTreeBudget}),built=[]
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
  if (engine.ctx.tokenMeter.estimateMessage(summarized.checkpointMessage)>policy.summaryPrefixTargetTokens) throw Error('DSH 后台分支摘要超过预算，保留原文')
  try{await publishForkArchive(engine.superLcmStore.path,agent.session.id,archiveTree,{provider:request.provider,model:request.model,usage},archiveSnapshot)}catch(error){engine.ctx.logger?.warn?.('后台摘要归档待重试：'+error.message)}
  return {...summarized,summaryTreeFormat:'incremental-v1',forkParts:frontier,forkLeafCount:parts.length,rawOutput:raw,usage,prefixHash:forkHash(request.messages),mainFork:true}
}
