import { randomUUID } from 'node:crypto'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendRecallEnvelope, stripRecallMetadata, markerFromSummary } from './marker.js'

// Batches are drafts only. Publish one checkpoint covering their contiguous
// original ranges, with one recall node and no dangling draft node references.
export function assembleRegions(engine, parts) {
  if (parts.length === 1) return parts[0]
  const first = parts[0], last = parts.at(-1)
  const compactionId = randomUUID()
  const blocks = parts.flatMap(part => part.summary.flatMap(block => {
    if (block.type !== 'text') return [block]
    const text = stripRecallMetadata(block.text)
    return text ? [{ ...block, text }] : []
  }))
  const summary = appendRecallEnvelope(blocks, {
    id: randomUUID(), children: [...new Set(parts.map(part => markerFromSummary(part.summary)?.id).filter(Boolean))],
  })
  const checkpointMessage = createUserMessage({
    content: [first.checkpointMessage.content[0], ...summary, first.checkpointMessage.content.at(-1)],
    source: compactCheckpointSource(compactionId),
  })
  const shadowedRouteTokenCount = parts.reduce((n, part) => n + part.shadowedRouteTokenCount, 0)
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
    selectedNodes: parts.flatMap(part => part.selectedNodes),
    shadowedSeqs: parts.flatMap(part => part.shadowedSeqs),
    shadowedTokenCount: parts.reduce((n, part) => n + part.shadowedTokenCount, 0),
    shadowedRouteTokenCount, preparedBatchCount: parts.length,
  }
}
