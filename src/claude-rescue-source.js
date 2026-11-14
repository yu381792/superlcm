import {coveredThrough,frontier,tailStart,turnTail,safeAssistantStarts,renderPacket} from './compaction.js'
import {verifiedCompactionInput} from './claude-compaction-input.js'
import {claudeCompactionNodes,rescueHash,rescueSourceHash} from './claude-checkpoints.js'
import {summarySource,summaryToolPairing,recentUserTexts} from './summary-source.js'
import {detectSummaryLanguage} from './summary-language.js'
import {buildSummaryPrompt,SUMMARY_SYSTEM} from './summary-policy.js'
import {estimateSummaryTokens} from './summary-tokens.js'
import {isReducedSummary} from './summary-fitting.js'
import {isRequestCopy} from './claude-records.js'
import {hasUnrepresentedContent} from './source-completeness.js'

import {ids,canonical,bodies,liveMessage} from './claude-live-messages.js'
export {liveMessage} from './claude-live-messages.js'

// Whitespace can carry meaning (for example in a code block). An archive
// that differs only at a text boundary is still not proof of the live input.
export const messageKey=m=>rescueHash([m.role,m.text,ids(m.toolUses),ids(m.toolResultIds)])
export function archivedMessages(store,session) {
  const segments=[]
  const list=store.eventRows(session).flatMap(e=>{
    const raw=store.exact(session,e.ordinal),record=JSON.parse(raw),role=record.message?.role||record.role||record.type
    const kept=record.type==='system'&&record.subtype==='compact_boundary'&&record.compactMetadata?.preservedSegment
    if(kept&&kept.headUuid&&kept.tailUuid&&kept.anchorUuid)segments.push({head:kept.headUuid,tail:kept.tailUuid,anchor:kept.anchorUuid})
    if(isRequestCopy(record))return []
    if(!['user','assistant'].includes(role))return []
    const content=record.message?.content??record.content
    const text=typeof content==='string'?content:Array.isArray(content)?content.filter(b=>b.type==='text').map(b=>b.text||'').join('\n'):''
    const pairing=summaryToolPairing(raw)
    const blocks=Array.isArray(content)?content:[],toolBodies=bodies({toolUses:blocks.filter(b=>b.type==='tool_use'),toolResults:blocks.filter(b=>b.type==='tool_result')})
    const message={role,text,toolUses:pairing.opened,toolResultIds:pairing.closed}
    // The caveat Claude Code writes before a slash command is transcript-only; the context does not hold it.
    const transcriptOnly=role==='user'&&record.isMeta===true&&text.trimStart().startsWith('<local-command-caveat>')
    return [{ordinal:e.ordinal,uuid:record.uuid??null,transcriptOnly,digest:e.digest,key:messageKey(message),shape:message,native:record.isCompactSummary===true,nonText:hasUnrepresentedContent(raw,'jsonl',{strictRecords:true}),
      endsTurn:pairing.endsTurn===true,
      toolBodies:toolBodies.map(body=>Object.fromEntries(Object.entries(body).map(([name,value])=>[name,rescueHash(canonical(value))])))}]
  })
  list.segments=segments
  return list
}
// After a native compaction that keeps recent messages, Claude Code's context is the summary followed by that
// preserved segment, which the transcript holds before the summary. The boundary record names it
// (compactMetadata.preservedSegment: headUuid..tailUuid, shown after anchorUuid, the summary). Build the archive
// in that order; a segment that cannot be found whole is left where it is.
export function inContextOrder(list){
  let out=[...list]
  for(const seg of list.segments||[]){
    const head=out.findIndex(m=>m.uuid===seg.head),tail=out.findIndex(m=>m.uuid===seg.tail)
    if(head<0||tail<head)continue
    const part=out.slice(head,tail+1),rest=[...out.slice(0,head),...out.slice(tail+1)]
    const anchor=rest.findIndex(m=>m.uuid===seg.anchor)
    if(anchor<0)continue
    out=[...rest.slice(0,anchor+1),...part,...rest.slice(anchor+1)]
  }
  return out
}
// Compare the actual active sequence, including tool payloads, with one exact
// archived sequence. An id without its body is not proof of the live content.
// Parallel tool calls from one response reach the transcript and Claude Code's context in different orders
// (call A, result A, call B, result B in one; calls first, then results in the other), and which one varies.
// Both sides are compared in one canonical order: within each run of text-less tool calls and result-only
// messages, the calls in order, then the results in order. Every message still matches exactly one record.
const toolCallOnly=m=>m.role==='assistant'&&!m.text.trim()&&m.toolUses.length>0&&!m.toolResultIds.length
const resultOnly=m=>m.role==='user'&&!m.text.trim()&&m.toolResultIds.length>0&&!m.toolUses.length
export function canonicalOrder(list){
  const order=[]
  for(let i=0;i<list.length;){
    if(!toolCallOnly(list[i])&&!resultOnly(list[i])){order.push(i++);continue}
    let j=i;while(j<list.length&&(toolCallOnly(list[j])||resultOnly(list[j])))j++
    for(let k=i;k<j;k++)if(toolCallOnly(list[k]))order.push(k)
    for(let k=i;k<j;k++)if(resultOnly(list[k]))order.push(k)
    i=j
  }
  return order
}
const bodiesMatch=(live,stored)=>live.toolBodies.every(body=>{
  const original=stored.toolBodies.find(b=>b.id===rescueHash(body.id)&&b.kind===rescueHash(body.kind))
  if(body.kind==='result'&&(original?.error??rescueHash(false))!==rescueHash(body.error??false))return false
  return !!original&&Object.entries(body).every(([name,value])=>{
    const storedHash=original[name]??(name==='error'?rescueHash(false):undefined)
    return storedHash!==undefined&&storedHash===rescueHash(canonical(value))
  })
})
// Compare the actual active sequence, including tool payloads, with one exact
// archived sequence. An id without its body is not proof of the live content.
export function verifiedActiveMessages(store,session,input,{requireLatest=true}={}) {
  const messages=input.map(liveMessage)
  const complete=messages.every(m=>m.toolUses.every(id=>m.toolBodies.some(b=>b.id===id&&b.kind==='use'&&'name' in b&&'value' in b))&&
    m.toolResultIds.every(id=>m.toolBodies.some(b=>b.id===id&&b.kind==='result'&&'value' in b)))
  if(!complete)return null
  const all=archivedMessages(store,session),archived=inContextOrder(all).filter(m=>!m.transcriptOnly)
  const liveOrder=canonicalOrder(messages),live=liveOrder.map(i=>messages[i]),keys=live.map(messageKey),candidates=[]
  const first=messageKey(messages[0])
  // Each candidate window is put in canonical order on its own, so a run cut by the window's edge still lines up.
  for(let at=0;at+keys.length<=archived.length;at++){
    if(archived[at].key!==first)continue
    const slice=archived.slice(at,at+keys.length),canon=canonicalOrder(slice.map(m=>m.shape)).map(i=>slice[i])
    if(keys.every((key,i)=>canon[i].key===key&&bodiesMatch(live[i],canon[i])))candidates.push(canon)
  }
  if(candidates.length!==1)return null
  // Back in live order: active[i] is the record that live message i matched.
  const active=new Array(messages.length)
  liveOrder.forEach((orig,pos)=>{active[orig]=candidates[0][pos]})
  const latest=Math.max(...all.map(a=>a.ordinal))
  return active.length&&(!requireLatest||Math.max(...active.map(a=>a.ordinal))===latest)?active:null
}
export function explainActiveMismatch(store,session,input) {
  const messages=(l=>canonicalOrder(l).map(i=>l[i]))(input.map(liveMessage))
  const incomplete=messages.findIndex(m=>!(m.toolUses.every(id=>m.toolBodies.some(b=>b.id===id&&b.kind==='use'&&'name' in b&&'value' in b))&&
    m.toolResultIds.every(id=>m.toolBodies.some(b=>b.id===id&&b.kind==='result'&&'value' in b))))
  const describe=(i,why)=>({index:i,why,role:messages[i]?.role,text:String(messages[i]?.text||'').slice(0,160),toolUses:messages[i]?.toolUses.length||0,toolResults:messages[i]?.toolResultIds.length||0})
  if(incomplete>=0)return {live:messages.length,first:describe(incomplete,'tool bodies missing from the live message')}
  const raw=inContextOrder(archivedMessages(store,session)).filter(m=>!m.transcriptOnly),archived=canonicalOrder(raw.map(a=>a.shape)).map(i=>raw[i])
  const keys=messages.map(messageKey),byKey=new Map()
  archived.forEach((m,i)=>{const list=byKey.get(m.key)||[];list.push(i);byKey.set(m.key,list)})
  const unmatched=keys.map((k,i)=>byKey.has(k)?null:i).filter(i=>i!==null)
  // Best alignment: the archived start that matches the longest run of live keys.
  let best={at:-1,run:0}
  for(const at of new Set((byKey.get(keys[0])||[]).concat(byKey.get(keys.at(-1))?.map(i=>i-keys.length+1)||[]))){
    let run=0;while(run<keys.length&&archived[at+run]?.key===keys[run])run++
    if(run>best.run)best={at,run}
  }
  return {live:messages.length,archived:archived.length,unmatchedCount:unmatched.length,unmatchedRoles:[...new Set(unmatched.map(i=>messages[i].role))],
    alignedFrom:best.at,alignedRun:best.run,...(best.run<keys.length?{first:describe(best.run,unmatched.includes(best.run)?'no archived record has this text and tool ids':'text matches but tool bodies or order differ')}:{}),
    unmatchedSample:unmatched.slice(0,5).map(i=>describe(i,'no archived match'))}
}
export function verifiedCompactionCut(active,plan) {
  return !!active?.length&&Number.isSafeInteger(plan.start)&&plan.start>0&&plan.start<active.length&&
    Number.isSafeInteger(plan.through)&&plan.through<=active.at(-1).ordinal&&
    active.slice(0,plan.start).every(message=>message.ordinal<=plan.through&&!message.nonText)
}
export function rescuePacket(store,session,p,summary) {
  const node={id:p.nodeId,level:p.level,first:0,last:p.through,summary,rescueRequest:p.request}
  const packet=renderPacket({meta:store.metadata(session),summaries:[node],through:p.through,keep:p.keep,instructions:p.instructions,request:p.request})
  if(!packet)return null
  const after=p.keptTokens+estimateSummaryTokens(packet)
  if(after>p.window*.35)return null
  return {use:true,packet,start:p.start,keep:p.keep,through:p.through,after:Math.ceil(after),rescue:true}
}
export function prepareRescueSource(store,session,input) {
  const setting=store.takeover(),messages=(input.messages||[]).map(liveMessage)
  const context=verifiedCompactionInput(store,session,messages),events=context.events
  if(messages.some(m=>!Number.isFinite(m.size)||m.size<=0))return null
  const active=verifiedActiveMessages(store,session,messages)
  if(!active)return null
  // Full sequence and tool-body matching above identify the exact source turn,
  // even when separate notifications happen to repeat the same prompt text.
  context.messages=context.messages.map((m,i)=>({...m,verifiedTurnBoundary:active[i].endsTurn}))
  if(active[0].native)context.messages[0].nativeSummary=true
  const window=Math.min(input.window||setting.window,setting.window),tokens=input.tokens
  if(!Number.isFinite(tokens)||tokens<=0||!Number.isFinite(window)||window<1000||messages.length<2||typeof input.model!=='string'||!input.model)return null
  const size=m=>m.size,total=messages.reduce((s,m)=>s+size(m),0)||1
  let start=tailStart(context.messages,messages.length),request=null
  const want=Math.min(setting.keep,tokens/2)
  let wide=start,newest=messages.slice(start).reduce((s,m)=>s+size(m),0)*tokens/total
  while(wide>0&&newest<want)newest+=size(messages[--wide])*tokens/total
  const safe=new Set(safeAssistantStarts(context.messages))
  // Ordinary suffixes start at human prompts; a long single turn needs the
  // existing verified request carry plus a tool-complete assistant boundary.
  if(start===0||start===messages.length||messages.slice(start).reduce((s,m)=>s+size(m),0)*tokens/total>window*.3){
    const within=turnTail({messages:context.messages,events,cut:messages.length,tokens,total,size,keepTokens:setting.keep,window})
    if(!within)return null
    start=within.start;request=within.request
  }else if(wide>0&&newest<=want*2){
    while(wide>0&&context.messages[wide].role!=='user')wide--
    if(wide>0)start=Math.min(start,wide)
  }
  if(start<=0||start>=messages.length)return null
  if(active.slice(0,start).some(m=>m.nonText))return null
  const pending=new Set()
  for(const m of context.messages.slice(0,start)){if(m.verifiedTurnBoundary)pending.clear();for(const id of m.toolUses)pending.add(id);for(const id of m.toolResultIds)pending.delete(id)}
  if(context.messages[start].verifiedTurnBoundary)pending.clear()
  if(pending.size||messages[start].toolResultIds.length||request&&!safe.has(start))return null
  const matched=active.slice(0,start),through=matched.at(-1).ordinal
  const nodes=claudeCompactionNodes(store,session).filter(n=>n.last<=through)
  const covered=coveredThrough(nodes),prefix=frontier(nodes,covered)
  if(covered>=0&&!prefix.length||prefix.some(n=>isReducedSummary(n.summary)))return null
  let from=covered+1,content=prefix.map(n=>`[summary ${n.id}; records ${n.first}-${n.last}]\n${n.summary}`).join('\n')
  const opening=matched[0]
  // A real native checkpoint is usable historical context; a person pasting
  // the same prose cannot supply this proof.
  if(opening.native&&opening.ordinal>=from){
    // The host's checkpoint is already a summary. It does not prove that a
    // new SuperLcm rescue saw every older original that it would claim to cover.
    for(const event of store.eventRows(session).filter(e=>e.ordinal>=from&&e.ordinal<opening.ordinal)){
      const raw=store.exact(session,event.ordinal)
      if(hasUnrepresentedContent(raw,'jsonl',{strictRecords:true})||summarySource(raw))return null
    }
    const original=JSON.parse(store.exact(session,opening.ordinal)),blocks=original.message?.content??original.content
    const native=typeof blocks==='string'?blocks:blocks.filter(b=>b.type==='text').map(b=>b.text||'').join('\n')
    content+=`\n[verified native checkpoint record ${opening.ordinal}]\n${native}`
    from=opening.ordinal+1
  }
  for(const e of store.eventRows(session).filter(e=>e.ordinal>=from&&e.ordinal<=through)){
    const raw=store.exact(session,e.ordinal)
    // Text projection does not include images, files or audio. A rescue cannot
    // claim to cover those records unless an earlier complete node already did.
    if(hasUnrepresentedContent(raw,'jsonl',{strictRecords:true}))return null
    if(request?.ordinal===e.ordinal)continue // carried verbatim, never rewritten
    const source=summarySource(raw)
    if(source)content+=`\n[record ${e.ordinal}]\n${source}`
    if(content.length>32e6)return null
  }
  if(!content.trim())return null
  const language=detectSummaryLanguage(recentUserTexts(store,session)),level=1+Math.max(0,...prefix.map(n=>n.level))
  const outputTokens=Math.max(1024,Math.min(12000,Math.floor(window*.12)))
  const task={level,kind:'checkpoint',first:0,last:through,language,requireHeading:true,maxChars:60000,targetTokens:outputTokens}
  const prompt=buildSummaryPrompt(content,task),inputTokens=estimateSummaryTokens(SUMMARY_SYSTEM+prompt)
  if(inputTokens+outputTokens+2048>window||prompt.length>32e6)return null
  const p={evidenceVersion:3,start,keep:messages.length-start,through,request,window,tokens,keptTokens:messages.slice(start).reduce((s,m)=>s+size(m),0)*tokens/total,
    instructions:input.instructions||'',model:input.model,level,language,outputTokens,sourceHash:rescueSourceHash(store,session,through),
    children:prefix.map(n=>n.id),childHashes:prefix.map(n=>[n.id,rescueHash(n.summary)]),inputHash:rescueHash(messages),settingHash:rescueHash(setting),cancelId:input.cancel_id||null,surfaceHash:rescueSourceHash(store,session,Number.MAX_SAFE_INTEGER)}
  p.nodeId='claude-rescue-'+rescueHash([p.evidenceVersion,session,p.sourceHash,p.inputHash,p.settingHash,p.model,p.childHashes,p.instructions,p.window,p.keptTokens]).slice(0,40)
  return {preparation:p,system:SUMMARY_SYSTEM,prompt,task,maxTokens:outputTokens}
}
