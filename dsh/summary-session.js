import { createHash } from 'node:crypto'

export function summarySessionId(sessionId, route) {
  return 'superlcm-summary-' + createHash('sha256')
    .update(JSON.stringify([sessionId, route?.provider ?? '', route?.model ?? '']))
    .digest('hex').slice(0, 32)
}

// Only the auxiliary wire identity changes. Original Session methods, content,
// events, and recall ownership stay on the real conversation.
export function summaryCallContext(ctx, sessionId, route, { input, directive } = {}) {
  const llm = ctx.llm
  const wire = Object.create(llm)
  Object.defineProperty(wire, 'stream', { value: async function* (options) {
    let messages = options.messages
    if (directive) {
      // The host must append exactly one compaction directive after our input.
      // Keep the replayed prefix byte-for-byte; never append two competing policies.
      if (options.purpose !== 'compaction' || !Array.isArray(messages)
        || messages.length !== input.messages.length + 1
        || !input.messages.every((message, index) => messages[index] === message)
        || messages.at(-1)?.role !== 'user') {
        throw new Error('Unsupported host summarization envelope; refusing to rewrite conversation input')
      }
      messages = [...input.messages, { role:'user', content:[{type:'text',text:directive}] }]
    }
    for await (const chunk of llm.stream({ ...options, messages, sessionId:summarySessionId(sessionId,route) })) {
      if (chunk.type === 'finish' && ['max-tokens','tool-calls'].includes(chunk.reason?.kind)) {
        throw new Error('Summary generation was incomplete; original content retained')
      }
      yield chunk
    }
  } })
  const context = Object.create(ctx)
  Object.defineProperty(context, 'llm', { value: wire })
  return context
}
