import { createHash } from 'node:crypto'

export function summarySessionId(sessionId, route) {
  return 'superlcm-summary-' + createHash('sha256')
    .update(JSON.stringify([sessionId, route?.provider ?? '', route?.model ?? '']))
    .digest('hex').slice(0, 32)
}

// Only the auxiliary wire identity changes. Original Session methods, content,
// events, and recall ownership stay on the real conversation.
export function summaryCallContext(ctx, sessionId, route) {
  const llm = ctx.llm
  const wire = Object.create(llm)
  Object.defineProperty(wire, 'stream', { value: options => llm.stream({
    ...options, sessionId: summarySessionId(sessionId, route),
  }) })
  const context = Object.create(ctx)
  Object.defineProperty(context, 'llm', { value: wire })
  return context
}
