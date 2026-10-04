import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { markerFromSummary } from './marker.js'

const checkpointPreamble = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
export function checkpointMatches(summary, content) {
  if (!Array.isArray(summary) || !summary.length || !Array.isArray(content)) return false
  if (isDeepStrictEqual(summary, content)) return true
  // dsh-compaction-basic frames the exact summary blocks, without rewriting
  // their text or accepting an arbitrary prefix/suffix supplied by a model.
  return content.length === summary.length + 2
    && isDeepStrictEqual(content[0], { type: 'text', text: checkpointPreamble + '\n\n<compacted-summary>' })
    && isDeepStrictEqual(content.at(-1), { type: 'text', text: '</compacted-summary>' })
    && isDeepStrictEqual(content.slice(1, -1), summary)
}
export const summaryIdentity = (sessionId, event, identities) => markerFromSummary(event.data?.summary)?.id ?? identities?.get(event.seq)
  ?? 'lcm-native-' + createHash('sha256').update(JSON.stringify([sessionId, event.data?.compactionId, event.seq, event.data?.summary])).digest('hex').slice(0, 40)
export function legacyIdentities(store, sessionId, records) {
  const unmarked = new Map(records.filter(record => markerFromSummary(record.summary.data?.summary) === null).map(record => [record.summary.seq, record.summary]))
  const identities = new Map()
  if (!unmarked.size) return identities
  for (const id of store.listNodeIds(sessionId)) {
    const node = store.getNode(sessionId, id), event = unmarked.get(node.summarySeq)
    if (!event || node.compactionId !== event.data?.compactionId || !isDeepStrictEqual(node.summary, event.data?.summary)) continue
    if (identities.has(event.seq)) throw Error('Legacy compaction has more than one verified summary node')
    identities.set(event.seq, node.nodeId)
  }
  return identities
}

