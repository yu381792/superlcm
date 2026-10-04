import { isDeepStrictEqual } from 'node:util'
import { markerFromSummary, contentBlocksToText, stripRecallMetadata } from './marker.js'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { semanticFrontier, isTransparentAssembly } from './tree-semantics.js'

// A model's markers are never authority. Only engine-produced, committed tree
// metadata whose leaves match the verified surface range can enter the index.
export function preparedTreeNodes(session, event, root, store) {
  const data = event.data
  if (!Array.isArray(data.preparedTree)) return [root]
  const declared = [...data.preparedTree, { ...root, kind: data.summaryTreeKind,
    childIds: markerFromSummary(root.summary)?.children ?? [] }]
  const nodes = new Map(), checkpoints = new Map(), physicalCheckpoints = new Map()
  const witnesses = new Map(), required = new Set(), represented = new Set()
  const rootSources = new Set(root.sourceSeqs)
  const eventMap = session.eventAt ? null : new Map(session.snapshotEvents().map(e => [e.seq, e]))
  for (const seq of root.sourceSeqs) {
    const source = session.eventAt ? session.eventAt(seq) : eventMap.get(seq)
    if (source?.type !== 'user/message' || !source.data?.source || !isCompactCheckpointSource(source.data.source)) continue
    const marker = markerFromSummary(source.data.content)
    if (marker) {
      checkpoints.set(marker.id, [seq]); physicalCheckpoints.set(marker.id, [seq])
      const members = store?.getNode(root.sessionId, marker.id)
        ? semanticFrontier(store, root.sessionId, marker.id) : [marker.id]
      const keys = members.map(id => `${seq}:${id}`)
      for (const key of keys) required.add(key)
      witnesses.set(marker.id, keys)
      for (const [index, id] of members.entries()) {
        checkpoints.set(id, [seq]); witnesses.set(id, [keys[index]])
      }
    }
  }
  for (const item of declared) {
    const marker = markerFromSummary(item.summary)
    if (!marker || marker.id !== item.nodeId || nodes.has(item.nodeId) || checkpoints.has(item.nodeId)
      || !['leaf', 'condensed', 'assembled'].includes(item.kind) || !Array.isArray(item.sourceSeqs) || !item.sourceSeqs.length
      || !Array.isArray(item.childIds) || !isDeepStrictEqual(marker.children, item.childIds)
      || new Set(item.sourceSeqs).size !== item.sourceSeqs.length
      || !item.sourceSeqs.every(seq => rootSources.has(seq))) throw Error('invalid prepared summary tree')
    nodes.set(item.nodeId, { ...root, ...item, sessionId: root.sessionId, summarySeq: root.summarySeq,
      createdAt: root.createdAt, compactionId: root.compactionId, status: 'ready',
      summaryText: stripRecallMetadata(contentBlocksToText(item.summary)) })
  }
  const ordered = [], visited = new Set(), visiting = new Set()
  const visit = id => {
    if (checkpoints.has(id)) {
      for (const key of witnesses.get(id) ?? []) {
        if (represented.has(key)) throw Error('prepared summary overlaps a checkpoint forest member')
        represented.add(key)
      }
      return checkpoints.get(id)
    }
    if (visited.has(id)) throw Error('prepared summary overlaps a declared forest member')
    const node = nodes.get(id)
    if (!node || visiting.has(id)) throw Error('prepared summary tree has a missing child or cycle')
    visiting.add(id)
    if (node.kind === 'leaf') {
      const expected = [...physicalCheckpoints].filter(([, seqs]) => node.sourceSeqs.includes(seqs[0])).map(([key]) => key)
      if (!isDeepStrictEqual(node.childIds, expected)) throw Error('prepared leaf has untrusted children')
      for (const child of node.childIds) visit(child)
    } else {
      const sources = node.childIds.flatMap(visit)
      // Duplicate physical checkpoint seqs are legitimate only when its
      // individually proven logical members are reassembled or summarized.
      const seen = new Set()
      for (const seq of sources) {
        if (seen.has(seq) && ![...physicalCheckpoints.values()].some(list => list[0] === seq)) throw Error('prepared summary coverage overlaps raw records')
        seen.add(seq)
      }
      if (!isDeepStrictEqual([...seen], node.sourceSeqs)) throw Error('prepared summary coverage has a gap or overlap')
      if (node.kind === 'assembled') {
        const children = node.childIds.map(child => nodes.get(child) ?? store?.getNode(root.sessionId, child))
        if (!children.every(Boolean) || !isTransparentAssembly(node.summary, children.map(child => child.summary))) throw Error('assembled summary does not match its members')
      }
    }
    visiting.delete(id); visited.add(id); ordered.push(node)
    return node.sourceSeqs
  }
  visit(root.nodeId)
  if ([...required].some(key => !represented.has(key))) throw Error('prepared summary omitted a checkpoint forest member')
  if (visited.size !== nodes.size) throw Error('prepared summary tree contains unreachable nodes')
  return ordered
}
