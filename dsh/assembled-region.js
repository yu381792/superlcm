import { orderedSummaryBlocks } from './assembly-blocks.js'
import { randomUUID } from 'node:crypto'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendRecallEnvelope, markerFromSummary } from './marker.js'

export function assembledCheckpointMessage(parts) {
  if (parts.length === 1) return { summary: parts[0].summary, checkpointMessage: parts[0].checkpointMessage, compactionId: parts[0].compactionId }
  const first = parts[0]
  const compactionId = randomUUID()
  const blocks = orderedSummaryBlocks(parts.map(part=>part.summary))
  const summary = appendRecallEnvelope(blocks, {
    id: randomUUID(), children: [...new Set(parts.map(part => markerFromSummary(part.summary)?.id).filter(Boolean))],
  })
  const checkpointMessage = createUserMessage({
    content: [first.checkpointMessage.content[0], ...summary, first.checkpointMessage.content.at(-1)],
    source: compactCheckpointSource(compactionId),
  })
  return { summary, checkpointMessage, compactionId }
}

// Batches are drafts only. Publish one checkpoint covering their contiguous
// original ranges, with one recall node and no dangling draft node references.
export function assembleRegions(engine, parts) {
  if (parts.length === 1) return parts[0]
  const first = parts[0], last = parts.at(-1)
  const { summary, checkpointMessage, compactionId } = assembledCheckpointMessage(parts)
  // Several logical members can live inside one physical checkpoint. Count
  // that surface node once, regardless of how many members enter the forest.
  const selectedNodes = [...new Map(parts.flatMap(part => part.selectedNodes).map(node => [node.seq, node])).values()]
  const shadowedRouteTokenCount = selectedNodes.reduce((n, node) => n + node.tokens, 0)
  if (engine.ctx.tokenMeter.estimateMessage(checkpointMessage) >= shadowedRouteTokenCount) {
    throw Error('assembled summary is not smaller than its original ranges')
  }
  const usage = {}
  for (const part of parts) for (const [key, value] of Object.entries(part.usage ?? {})) {
    if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value
  }
  return {
    ...first, end: last.end, compactionId, summary, checkpointMessage, usage,
    rawOutput: parts.flatMap(part => part.rawOutput ?? []),
    selectedNodes,
    shadowedSeqs: selectedNodes.map(node => node.seq),
    shadowedTokenCount: selectedNodes.reduce((n, node) => n + (node.heuristicTokens ?? node.tokens ?? 0), 0),
    shadowedRouteTokenCount, preparedBatchCount: parts.length,
  }
}
