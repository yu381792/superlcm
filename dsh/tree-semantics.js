import { isDeepStrictEqual } from 'node:util'
import { plainSummaryBlocks, orderedSummaryBlocks } from './assembly-blocks.js'

export function isTransparentAssembly(summary, childSummaries) {
  const plain=plainSummaryBlocks(summary)
  if (isDeepStrictEqual(plain, childSummaries.flatMap(plainSummaryBlocks))) return true // legacy exact concatenation
  try { return isDeepStrictEqual(plain, orderedSummaryBlocks(childSummaries)) } catch { return false }
}

// An envelope is not another summarization. Older releases labelled envelopes
// as condensed; recognize them only by reproducing their exact concatenation.
function topology(store,sessionId){
 const memo=new Map(),active=new Set()
 const visit=id=>{
  if(memo.has(id))return memo.get(id)
  if(active.has(id))throw Error('summary tree cycle')
  active.add(id)
  const node = store.getNode(sessionId, id)
  if (!node) throw Error('missing summary tree node: ' + id)
  const children=node.childIds.map(visit),members=node.childIds.map(child=>store.getNode(sessionId,child))
  const transparent=members.length>1&&isTransparentAssembly(node.summary,members.map(child=>child.summary))
  if(node.kind==='assembled'&&!transparent)throw Error('assembled summary does not match its members')
  const kind=node.kind==='snapshot'?'snapshot':transparent?'assembled':!children.length?'leaf':node.kind==='overview'||children.length===1||children.some(child=>child.kind==='overview')||new Set(children.map(child=>child.level)).size>1?'overview':'condensed'
  const frontier=kind==='assembled'||kind==='overview'?children.flatMap(child=>child.frontier):[id]
  const lower=Math.max(0,...children.flatMap(child=>child.kind==='overview'||child.kind==='assembled'?child.frontier.map(key=>memo.get(key).level):[child.level]))
  const value={kind,level:kind==='snapshot'?1:kind==='assembled'?lower:lower+1,frontier}
  active.delete(id);memo.set(id,value);return value
 }
 return visit
}
export function semanticKind(store, sessionId, id) {
  return topology(store,sessionId)(id).kind
}

// Only granular blocks are reused for the next merge. The previous rolling
// overview stays in the visible branch input and in the searchable archive.
export function granularFrontier(store,sessionId,id){return topology(store,sessionId)(id).frontier}
export function originalNodeSources(store,sessionId,id,eventAt,active=new Set()){
 if(active.has(id))throw Error('summary tree cycle')
 const node=store.getNode(sessionId,id);if(!node)throw Error('missing summary tree node: '+id)
 const next=new Set([...active,id])
 return [...new Set([...node.sourceSeqs.filter(seq=>eventAt(seq)?.data?.source?.kind!=='compact-checkpoint'),...node.childIds.flatMap(child=>originalNodeSources(store,sessionId,child,eventAt,next))])].sort((a,b)=>a-b)
}
export function reusableGranularFrontier(store,sessionId,id,eventAt){
 const members=granularFrontier(store,sessionId,id),covered=new Set(members.flatMap(key=>originalNodeSources(store,sessionId,key,eventAt)))
 const originals=originalNodeSources(store,sessionId,id,eventAt)
 // A legacy coarse checkpoint can contain direct originals absent from its
 // navigation children. Preserve that complete checkpoint as one immutable
 // historical block, rather than falsely certifying only its descendants.
 return originals.every(seq=>covered.has(seq))?members.map(id=>({id,snapshot:false})):[{id,snapshot:true}]
}

export function semanticFrontier(store, sessionId, id, seen = new Set()) {
  if (seen.has(id)) throw Error('summary tree cycle')
  if (semanticKind(store, sessionId, id) !== 'assembled') return [id]
  const next = new Set([...seen, id])
  return store.getNode(sessionId, id).childIds.flatMap(child => semanticFrontier(store, sessionId, child, next))
}

export function semanticLevel(store, sessionId, id) {
  return topology(store,sessionId)(id).level
}
