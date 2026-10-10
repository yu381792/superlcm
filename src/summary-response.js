import {upstreamSummaryCause} from './summary-errors.js'
const MAX_RESPONSE_BYTES = 1024 * 1024
// A parsed JSON response cannot forge this local completion proof.
export const STREAM_COMPLETE = Symbol('verified summary stream completion')
const safe = value => String(value ?? 'none').replace(/[^a-zA-Z0-9._:/-]/g, '?').slice(0, 120)
const REASONS = new Set(['stop', 'end_turn', 'stop_sequence', 'length', 'max_tokens', 'maxtokens', 'max_output_tokens', 'incomplete', 'content_filter', 'error', 'aborted', 'tool_calls', 'tool_use', 'function_call', 'in_progress', 'queued', 'pending', 'cancelled', 'failed'])
export function summaryFailure(message, model, finishReason, evidence = {}, kind = 'unknown') {
  const raw = typeof finishReason === 'object' ? finishReason?.kind ?? finishReason?.type ?? finishReason?.reason : finishReason
  const normalized = typeof raw === 'string' ? raw.toLowerCase().replace(/-/g, '_') : raw
  const reason = normalized == null ? 'none' : REASONS.has(normalized) ? normalized : 'unsupported'
  // Only the configured model is trusted. Routers can echo credentials or
  // source fragments into either model or finish_reason response metadata.
  const numeric = key => Number.isSafeInteger(evidence[key]) && evidence[key] >= 0 ? Math.min(10000000, evidence[key]) : 'unknown'
  return Object.assign(Error(`${message} (model ${safe(model)}, finish_reason ${reason}, reasoning_tokens ${numeric('reasoning_tokens')}, completion_tokens ${numeric('completion_tokens')})`), { summaryDiagnostic: true,summaryKind:kind })
}
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : ''

export async function readSummaryText(response,signal) {
  signal?.throwIfAborted()
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw Error('Summary response exceeds the size limit')
    signal?.throwIfAborted();return text
  }
  const reader = response.body.getReader(), parts = []
  const cancel=()=>{void reader.cancel().catch(()=>{})}
  signal?.addEventListener('abort',cancel,{once:true})
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw Error('Summary response exceeds the size limit') }
      parts.push(Buffer.from(value))
    }
    return Buffer.concat(parts).toString('utf8')
  } finally { signal?.removeEventListener('abort',cancel);reader.releaseLock() }
}
export async function readSummaryJson(response,signal) {
  // Keep compatibility with injected test transports exposing only json().
  if(!response.body?.getReader&&typeof response.text!=='function'){
    signal?.throwIfAborted();const result=await response.json();signal?.throwIfAborted()
    if(Buffer.byteLength(JSON.stringify(result))>MAX_RESPONSE_BYTES)throw Error('Summary response exceeds the size limit')
    return result
  }
  return JSON.parse(await readSummaryText(response,signal))
}

export async function readOpenAICompletion(response, requestedModel,{signal}={}) {
  if (!/text\/event-stream/i.test(response.headers?.get?.('content-type') || '')) return readSummaryJson(response,signal)
  let content = '', finish = null, done = false, received = false, reasoningSeen = false, usage = {}
  const fail = (reason,kind='response_invalid') => summaryFailure(reason, requestedModel, finish,{reasoning_tokens:usage.completion_tokens_details?.reasoning_tokens,completion_tokens:usage.completion_tokens},kind)
  const upstream = value => {const cause=upstreamSummaryCause(value);return fail('Summary stream reported an '+cause.message,cause.kind)}
  let raw
  try { raw = (await readSummaryText(response,signal)).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') }
  catch { signal?.throwIfAborted();throw fail('Summary stream could not be read completely or exceeded the size limit') }
  // Some gateways label a normal JSON completion as SSE. It still needs an
  // explicit terminal finish_reason; never grant the local stream proof.
  if(raw.trimStart().startsWith('{')){
    let result
    try{result=JSON.parse(raw)}catch{throw fail('Malformed JSON completion under stream content type')}
    if(result?.error)throw upstream(result)
    if(!result||typeof result!=='object'||!Array.isArray(result.choices))throw fail('Malformed JSON completion under stream content type')
    return result
  }
  // SSE events end at a blank line; data fields within an event join with LF.
  for (const frame of raw.split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (frame.split('\n').some(line => /^event:\s*error\s*$/i.test(line))) {
      let detail
      try{detail=JSON.parse(data)}catch{detail=data}
      throw upstream(detail)
    }
    if (!data) continue
    if (done) throw fail('Summary stream contains data after completion')
    if (data.trim() === '[DONE]') { done = true; continue }
    let chunk
    try { chunk = JSON.parse(data) } catch { throw fail('Malformed summary stream event') }
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw fail('Malformed summary stream event')
    if (chunk.error) throw upstream(chunk)
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage
    if (!Array.isArray(chunk.choices)) throw fail('Summary stream event has no choices')
    const choice = chunk.choices?.find(c => c.index === 0) ?? chunk.choices?.find(c => c.index === undefined)
    if (!choice) continue // usage-only frames, or another choice
    if (choice.delta?.reasoning_content || choice.delta?.reasoning || choice.message?.reasoning_content || choice.message?.reasoning) reasoningSeen = true
    const text = contentText(choice.delta?.content ?? choice.message?.content)
    if (finish !== null && (text || choice.finish_reason != null)) throw fail('Summary stream continues after its final choice')
    content += text
    received = true
    if (choice.finish_reason != null) finish = choice.finish_reason
  }
  if (!received) throw fail('Summary stream contained no completion data','stream_empty')
  if (!done && finish === null) throw fail('Summary stream was cut off before its final event','stream_cutoff')
  if (finish !== null && !['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(finish)) throw fail('Summary stream has a nonterminal or unsupported finish reason')
  // A DONE marker alone is accepted by OpenAI-compatible gateways; explicit
  // incomplete reasons are still checked by the shared summary validator.
  return { model: requestedModel, reasoningSeen, usage, [STREAM_COMPLETE]: true, choices: [{ message: { content }, finish_reason: finish }] }
}
