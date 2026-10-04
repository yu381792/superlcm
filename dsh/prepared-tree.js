import { isDeepStrictEqual } from 'node:util'
import { markerFromSummary, contentBlocksToText, stripRecallMetadata } from './marker.js'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'

// A model's markers are never authority. Only engine-produced, committed tree
// metadata whose leaves match the verified surface range can enter the index.
export function preparedTreeNodes(session, event, root) {
  const data = event.data
  if (!Array.isArray(data.preparedTree)) return [root]
  const declared = [...data.preparedTree, { ...root, kind: data.summaryTreeKind,
    childIds: markerFromSummary(root.summary)?.children ?? [] }]
  const nodes = new Map(), checkpoints = new Map()
  for (const seq of root.sourceSeqs) {
    const source = session.eventAt ? session.eventAt(seq) : session.snapshotEvents().find(e => e.seq === seq)
    if (source?.type !== 'user/message' || !source.data?.source || !isCompactCheckpointSource(source.data.source)) continue
    const marker = markerFromSummary(source.data.content)
    if (marker) checkpoints.set(marker.id, [seq])
  }
  for (const item of declared) {
    const marker = markerFromSummary(item.summary)
    if (!marker || marker.id !== item.nodeId || nodes.has(item.nodeId) || checkpoints.has(item.nodeId)
      || !['leaf', 'condensed'].includes(item.kind) || !Array.isArray(item.sourceSeqs) || !item.sourceSeqs.length
      || !Array.isArray(item.childIds) || !isDeepStrictEqual(marker.children, item.childIds)
      || new Set(item.sourceSeqs).size !== item.sourceSeqs.length
      || !item.sourceSeqs.every(seq => root.sourceSeqs.includes(seq))) throw Error('invalid prepared summary tree')
    nodes.set(item.nodeId, { ...root, ...item, sessionId: root.sessionId, summarySeq: root.summarySeq,
      createdAt: root.createdAt, compactionId: root.compactionId, status: 'ready',
      summaryText: stripRecallMetadata(contentBlocksToText(item.summary)) })
  }
  const ordered = [], visited = new Set(), visiting = new Set()
  const visit = id => {
    if (checkpoints.has(id)) return checkpoints.get(id)
    if (visited.has(id)) return nodes.get(id).sourceSeqs
    const node = nodes.get(id)
    if (!node || visiting.has(id)) throw Error('prepared summary tree has a missing child or cycle')
    visiting.add(id)
    if (node.kind === 'leaf') {
      const expected = [...checkpoints].filter(([, seqs]) => node.sourceSeqs.includes(seqs[0])).map(([key]) => key)
      if (!isDeepStrictEqual(node.childIds, expected)) throw Error('prepared leaf has untrusted children')
    } else {
      const sources = node.childIds.flatMap(visit)
      if (!isDeepStrictEqual(sources, node.sourceSeqs)) throw Error('prepared summary coverage has a gap or overlap')
    }
    visiting.delete(id); visited.add(id); ordered.push(node)
    return node.sourceSeqs
  }
  visit(root.nodeId)
  if (visited.size !== nodes.size) throw Error('prepared summary tree contains unreachable nodes')
  return ordered
}
