import { isDeepStrictEqual } from 'node:util'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { reindexSession, nodeLevel } from './core.js'
import { checkpointMatches } from './legacy-checkpoints.js'
import { markerFromSummary } from './marker.js'

export function checkpointChild(engine, session, event) {
  if (event?.type !== 'user/message' || !event.data?.source || !isCompactCheckpointSource(event.data.source)) return null
  const compactionId=event.data.source.compactionId
  const marker=markerFromSummary(event.data.content)
  const lookup=()=>marker ? engine.superLcmStore.getNode(session.id,marker.id) : engine.superLcmStore.getCompactionNode(session.id,compactionId)
  let node=lookup()
  if (!node) {
    const rebuilt=reindexSession(engine.superLcmStore,session)
    if (rebuilt.errors.length) throw new Error('Cannot verify source checkpoint ancestry')
    node=lookup()
  }
  if (!node || node.compactionId !== compactionId || marker && marker.id !== node.nodeId || !checkpointMatches(node.summary,event.data.content)) throw new Error('Source checkpoint has no verified archive node')
  return node.nodeId
}

// The host's manual/native compaction API does not pass plugin metadata. Infer
// it from durable message IDs and exact surface records, never model markers.
export function nativeSummaryTask(engine,input,agent) {
  const session=agent.session, surface=session.surface.nodes
  const byId=new Map(surface.map(seq=>{
    const event=session.eventAt(seq),message=session.deriveEventMessage(event)
    return [message?.id,{seq,event,message}]
  }).filter(([id])=>typeof id==='string'))
  const selected=[]
  for (const message of input.messages) {
    const original=byId.get(message.id)
    if (!original || !isDeepStrictEqual(message,original.message)) throw new Error('Native summary input is not a verified conversation surface')
    if (message.role !== 'system') selected.push(original)
  }
  if (!selected.length || new Set(selected.map(x=>x.seq)).size !== selected.length) throw new Error('Native summary has no unique source range')
  const firstIndex=surface.indexOf(selected[0].seq)
  if (!selected.every((record,index)=>surface[firstIndex+index]===record.seq)) throw new Error('Native summary source range is not consecutive')
  const children=[...new Set(selected.map(({event})=>checkpointChild(engine,session,event)).filter(Boolean))]
  return {trustedChildNodeIds:children,summaryTask:{
    level:Math.max(0,...children.map(id=>nodeLevel(engine.superLcmStore,session.id,id))),
    first:selected[0].seq,last:selected.at(-1).seq,
  }}
}
