const MAX_RESPONSE_BYTES = 1024 * 1024
const safe = value => String(value ?? 'none').replace(/[^a-zA-Z0-9._:/-]/g, '?').slice(0, 120)
const REASONS = new Set(['stop', 'end_turn', 'stop_sequence', 'length', 'max_tokens', 'maxtokens', 'max_output_tokens', 'incomplete', 'content_filter', 'error', 'aborted', 'tool_calls', 'tool_use', 'function_call', 'in_progress', 'queued', 'pending', 'cancelled', 'failed'])
export function summaryFailure(message, model, finishReason) {
  const raw = typeof finishReason === 'object' ? finishReason?.kind ?? finishReason?.type ?? finishReason?.reason : finishReason
  const normalized = typeof raw === 'string' ? raw.toLowerCase().replace(/-/g, '_') : raw
  const reason = normalized == null ? 'none' : REASONS.has(normalized) ? normalized : 'unsupported'
  // Only the configured model is trusted. Routers can echo credentials or
  // source fragments into either model or finish_reason response metadata.
  return Object.assign(Error(`${message} (model ${safe(model)}, finish_reason ${reason})`), { summaryDiagnostic: true })
}
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : ''

async function responseText(response) {
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw Error('Summary response exceeds the size limit')
    return text
  }
  const reader = response.body.getReader(), parts = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw Error('Summary response exceeds the size limit') }
      parts.push(Buffer.from(value))
    }
    return Buffer.concat(parts).toString('utf8')
  } finally { reader.releaseLock() }
}

export async function readOpenAICompletion(response, requestedModel) {
  if (!/text\/event-stream/i.test(response.headers?.get?.('content-type') || '')) return response.json()
  let content = '', finish = null, done = false, received = false
  const fail = reason => summaryFailure(reason, requestedModel, finish)
  let raw
  try { raw = (await responseText(response)).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') }
  catch { throw fail('Summary stream could not be read completely or exceeded the size limit') }
  // SSE events end at a blank line; data fields within an event join with LF.
  for (const frame of raw.split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data) continue
    if (frame.split('\n').some(line => /^event:\s*error\s*$/i.test(line))) throw fail('Summary stream reported an upstream error')
    if (done) throw fail('Summary stream contains data after completion')
    if (data.trim() === '[DONE]') { done = true; continue }
    let chunk
    try { chunk = JSON.parse(data) } catch { throw fail('Malformed summary stream event') }
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw fail('Malformed summary stream event')
    if (chunk.error) throw fail('Summary stream reported an upstream error')
    if (!Array.isArray(chunk.choices)) throw fail('Summary stream event has no choices')
    const choice = chunk.choices?.find(c => c.index === 0) ?? chunk.choices?.find(c => c.index === undefined)
    if (!choice) continue // usage-only frames, or another choice
    const text = contentText(choice.delta?.content ?? choice.message?.content)
    if (finish !== null && (text || choice.finish_reason != null)) throw fail('Summary stream continues after its final choice')
    content += text
    received = true
    if (choice.finish_reason != null) finish = choice.finish_reason
  }
  if (!received || (!done && finish === null)) throw fail('Summary stream ended before completion')
  if (finish !== null && !['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(finish)) throw fail('Summary stream has a nonterminal or unsupported finish reason')
  // A DONE marker alone is accepted by OpenAI-compatible gateways; explicit
  // incomplete reasons are still checked by the shared summary validator.
  return { model: requestedModel, choices: [{ message: { content }, finish_reason: finish }] }
}
