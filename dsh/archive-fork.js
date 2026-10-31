import {forkRoute} from './fork-route.js'
import {summaryContext} from './summary-model.js'
import {abortable,summaryAttempt} from './summary-attempt.js'
import {ArchiveDatabase} from './archive-db.js'
// Passive archive summaries use the same one-response tree contract as takeover.
// This module never changes a session surface or invokes a compaction method.
import {isDeepStrictEqual} from 'node:util'
import {createUserMessage,isAgentLoopRequest} from '@deepseek-ai/dsh-llm'
import {forkScope} from './fork-scope.js'
import {forkHash,forkAnchors,forkDirective,parseForkTree} from './fork-summary.js'
import {completeSummaryStream} from './summary-session.js'
import {detectSummaryLanguage} from '../src/summary-language.js'
import {readSettings} from './settings.js'
import {archivePairing} from './archive-planner.js'
import {DSH_SUMMARY_TIMEOUT_MS} from './summary-timeout.js'
import {semanticKind,semanticLevel} from './tree-semantics.js'
const listeners=new Map()
export function registerForkArchive(path,callback,revision=()=>null){
  const callbacks=listeners.get(path)||new Map();callbacks.set(callback,revision);listeners.set(path,callbacks)
  return ()=>{callbacks.delete(callback);if(!callbacks.size)listeners.delete(path)}
}
export function forkArchiveSnapshot(path){return new Map([...(listeners.get(path)||[])].map(([callback,revision])=>[callback,revision()]))}
export async function publishForkArchive(path,id,tree,receipt,snapshot){
  for(const [callback,revision] of listeners.get(path)||[]){
    if(snapshot&&(!snapshot.has(callback)||snapshot.get(callback)!==revision()))throw Error('DSH 摘要配置已变化，旧结果未归档')
    await callback(id,tree,receipt)
  }
}
export function registerArchiveCapture(service){
  service.forkRequests=new Map()
  service.ctx.on('llm/stream',(request,next)=>{
    if(!forkScope.getStore()&&isAgentLoopRequest(request)){
      const {signal,...plain}=request
      service.forkRequests.set(request.sessionId,structuredClone(plain))
    }
    return next()
  })
}
export async function summarizeArchiveFork(service,id,doc,owner,signal,{force=false}={}){
  return summaryAttempt((attempt,progress)=>runArchiveFork(service,id,doc,owner,attempt,{force},progress),signal,DSH_SUMMARY_TIMEOUT_MS)
}
async function runArchiveFork(service,id,doc,owner,signal,{force},progress){
  const request=service.forkRequests.get(id),session=service.ctx.sessions.get(id)
  if(!request||!session)return 'awaiting-live-request'
  const info=await abortable(service.ctx.llm.resolveModelInfo(request.provider,request.model,signal),signal)
  const window=info.context?.contextWindow,reserve=request.maxTokens??info.defaultMaxTokens??0
  if(!Number.isSafeInteger(window)||window<=reserve)throw Error('聊天模型缺少上下文容量，原文保留')
  const inputBudget=window-reserve,measurement=service.ctx.tokenMeter.measure(session)
  if(!force&&measurement.totalTokens<window*(Math.round((doc.settings.compressionRatio-.1)*1e12)/1e12))return 'below-preparation-threshold'
  const byId=new Map(request.messages.map((message,index)=>[message.id,{message,index}]))
  const history=service.db.nodes(id),covered=new Set(history.filter(n=>n.level===0).flatMap(n=>n.sources))
  const selected=service.db.sourceRows(id).filter(row=>{
    if(covered.has(row.seq))return false
    const message=session.deriveEventMessage(session.eventAt(row.seq)),found=message&&byId.get(message.id)
    return found&&isDeepStrictEqual(found.message,message)
  })
  if(!selected.length)return 'no-visible-source'
  const leaves=[];let first=0,tokens=0;const pending=new Set()
  for(let i=0;i<selected.length;i++){
    const event=JSON.parse(selected[i].event);archivePairing(event,pending);tokens+=selected[i].tokens
    if(pending.size||tokens<doc.settings.chunkTokens&&i<selected.length-1)continue
    const group=selected.slice(first,i+1),messages=group.map(row=>session.deriveEventMessage(session.eventAt(row.seq)))
    const positions=messages.map(m=>byId.get(m.id).index)
    leaves.push({index:leaves.length,firstMessage:positions[0],lastMessage:positions.at(-1),sources:group.map(row=>row.seq),...forkAnchors(messages)})
    first=i+1;tokens=0
  }
  if(!leaves.length)return 'awaiting-tool-results'
  const byKey=new Map(history.map(n=>[n.id,n])),adapter={getNode:(_session,key)=>{const n=byKey.get(key);return n?{summary:[{type:'text',text:n.summary}],childIds:n.children,sourceSeqs:n.sources,kind:n.kind}:null}}
  const retired=new Set(),retire=key=>{if(retired.has(key))return;retired.add(key);for(const child of byKey.get(key)?.children||[])retire(child)}
  for(const node of history)if(node.kind==='snapshot')for(const child of node.children)retire(child)
  const granular=history.filter(n=>!retired.has(n.id)&&!['assembled','overview'].includes(semanticKind(adapter,id,n.id)))
  const owned=new Set(granular.flatMap(n=>n.children));let frontier=granular.filter(n=>!owned.has(n.id)).sort((a,b)=>a.first-b.first)
  const represented=new Set(frontier.flatMap(n=>n.sources)),historical=new Set(history.flatMap(n=>n.sources))
  if([...historical].some(seq=>!represented.has(seq))){
    const complete=history.find(n=>historical.size===new Set(n.sources).size&&n.sources.every(seq=>historical.has(seq)))
    if(!complete)throw Error('DSH 旧摘要缺少完整分块来源，原文保留')
    frontier=[{...complete,id:'snapshot-'+forkHash([id,complete.id,complete.summary]).slice(0,24),level:0,kind:'snapshot',children:[complete.id]}]
    byKey.set(frontier[0].id,frontier[0])
  }
  const seen=new Set()
  for(const node of frontier)for(const seq of node.sources){if(seen.has(seq))throw Error('DSH 已有分块范围重叠，原文保留');seen.add(seq)}
  const prior=frontier.map((n,index)=>({index,firstMessage:index-frontier.length,lastMessage:index-frontier.length,frozenSummary:n.summary,frozenLevel:semanticLevel(adapter,id,n.id)-1,frozenId:n.id,frozenChildren:n.children,sources:n.sources,kind:semanticKind(adapter,id,n.id)}))
  const plan=[...prior,...leaves].map((n,index)=>({...n,index}))
  const language=detectSummaryLanguage(selected.filter(row=>JSON.parse(row.event).type==='user/message').map(row=>row.text))
  const usage={};let text='',options,prompt
  let scoped,route
  try{
    if(doc.settings.forkModelOverride&&doc.settings.summaryAdapter)scoped=summaryContext(service.ctx,doc.settings.summaryAdapter)
    if(scoped)await abortable(scoped.ready,signal)
    route=await forkRoute(scoped?.ctx||service.ctx,request,{enabled:doc.settings.forkModelOverride,provider:doc.settings.summaryProvider,model:doc.settings.summaryModel},signal)
    const targetTokens=Math.max(256,Math.min(12000,Math.floor((route.request.maxTokens||reserve||16384)*.65),Math.floor(inputBudget*.1)))
    options={fanout:doc.settings.fanout,targetTokens,incremental:true};prompt=forkDirective(plan,targetTokens,language.name,options)
    if(measurement.totalTokens+Math.ceil(prompt.length/2)>=Math.min(inputBudget,route.inputBudget??Infinity)-1024)throw Error('所选后台模型放不下完整对话，原文保留')
    await forkScope.run(true,async()=>{
    const stream=route.ctx.llm.stream({...route.request,signal,messages:[...request.messages,createUserMessage({content:[{type:'text',text:prompt}]})]})
    for await(const chunk of completeSummaryStream(stream,signal)){
      signal.throwIfAborted()
      if(['text-delta','reasoning-delta'].includes(chunk.type)&&typeof chunk.text==='string'&&chunk.text.trim())progress()
      if(chunk.type==='text-delta')text+=chunk.text
      if(chunk.type==='usage')Object.assign(usage,chunk.usage)
    }
  })
  }finally{scoped?.dispose()}
  signal.throwIfAborted()
  const current=service.forkRequests.get(id)
  if(current!==request)throw Error('聊天请求已变化，摘要未保存')
  const tree=parseForkTree(text,plan,language,options),digest=forkHash([doc.revision,selected.map(r=>[r.seq,r.event])])
  const ids=tree.map(n=>n.frozenId||'fork-'+forkHash([id,digest,n.index]).slice(0,24)),nodes=[]
  for(const n of tree){
    const sources=n.sources??[...new Set(n.children.flatMap(i=>nodes[i].sources))].sort((a,b)=>a-b)
    nodes.push({id:ids[n.index],level:n.semanticLevel??n.level,kind:n.kind,modelSummary:n.modelSummary,first:sources[0],last:sources.at(-1),children:n.frozenChildren??n.children.map(i=>ids[i]),summary:n.summary,sources})
  }
  service.db.saveTree(id,nodes,owner,doc.revision,()=>readSettings(service.file).revision,selected,{provider:route.request.provider,model:route.request.model,usage})
  await service.onTreeSaved?.(id,nodes)
  return 'complete'
}

export async function withForkLease(path,id,revision,signal,run){
  const db=new ArchiveDatabase(path),owner=db.lease(id,revision)
  if(!owner){db.close();throw Error('DSH 已有后台摘要任务，原文保留')}
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal
  const timer=setInterval(()=>{try{if(!db.renew(id,owner))controller.abort(Error('DSH 后台摘要已失去归属'))}catch(error){controller.abort(error)}},10000);timer.unref()
  try{return await run(combined)}finally{clearInterval(timer);db.release(id,owner);db.close()}
}
