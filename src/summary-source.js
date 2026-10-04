// Summarization reads verified originals, never the UI/search preview. Keep
// message roles, timestamps, tool outcomes and literal whitespace intact.
const textOf = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
function blocks(content) {
  if (typeof content === 'string' && content.startsWith('\0json:')) {
    try { const decoded=JSON.parse(content.slice(6)); if (decoded && typeof decoded==='object') content=decoded } catch {}
  }
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (!content || typeof content!=='object') return ''
    if (content.type) return blocks([content])
    return textOf(content)
  }
  return content.map(block => {
    if (['text','input_text','output_text'].includes(block?.type)) return block.text || ''
    if (['tool_use','toolCall','function_call'].includes(block?.type)) return `[tool call ${block.name || ''}; id=${block.id || block.call_id || ''}; requested, not proof of completion]\n${textOf(block.input ?? block.arguments)}`
    if (block?.type === 'tool_result') return `[tool result id=${block.tool_use_id || ''}; ${block.is_error === true ? 'ERROR / failed' : 'outcome must be read from result'}]\n${blocks(block.content)}`
    return '' // private reasoning, binary images and administrative fields
  }).filter(Boolean).join('\n')
}
export function summarySource(raw, kind = 'jsonl') {
  if (kind === 'text') return String(raw)
  let record
  try { record = JSON.parse(raw) } catch { return '' }
  if (!record || typeof record!=='object' || Array.isArray(record)) return ''
  let item=record, role=record.role ?? record.type
  if (record.type === 'response_item') {
    item=record.payload
    if (item?.type === 'message') role=item.role
    else if (item?.type === 'function_call') role='tool-call'
    else if (item?.type === 'function_call_output') role='tool-result'
    else return ''
  } else if (record.type === 'event_msg') {
    item=record.payload
    role=item?.type === 'user_message' ? 'user' : item?.type === 'agent_message' ? 'assistant' : null
  } else if (record.message?.role || ['user','assistant'].includes(role) && record.message) {
    item=record.message;role=item.role || role
  }
  let content=''
  if (role === 'tool-call') content=`[tool call ${item.name || ''}; id=${item.call_id || ''}; requested, not proof of completion]\n${textOf(item.arguments)}`
  else if (role === 'tool-result') content=`[tool result id=${item.call_id || ''}; outcome must be read from result]\n${textOf(item.output)}`
  else if (['user','assistant','tool','toolResult'].includes(role)) {
    content=blocks(item.content ?? item.message ?? '')
    if (['tool','toolResult'].includes(role)) content=`[tool result ${item.toolName || item.tool_name || item.name || ''}; id=${item.toolCallId || item.tool_call_id || ''}; ${item.isError === true || item.is_error === true ? 'ERROR / failed' : 'outcome must be read from result'}]\n${content}`
    let calls=item.tool_calls
    if (typeof calls==='string') { try { calls=JSON.parse(calls) } catch { content+='\n[tool_calls could not be parsed; recall this original for requested actions]\n'+calls } }
    if (role === 'assistant' && Array.isArray(calls)) content+='\n'+calls.map(call=>`[tool call ${call?.function?.name || ''}; id=${call?.id || ''}; requested, not proof of completion]\n${textOf(call?.function?.arguments ?? call)}`).join('\n')
  }
  if (!content.trim()) return ''
  const time=record.timestamp ?? item.timestamp ?? record.time ?? record.created_at
  return `${role}${time === undefined ? '' : ` [source time: ${textOf(time)}]`}:\n${content}`
}
export function summaryEvents(store, session, start) {
  const kind=store.source(session).kind
  return store.eventRowsFrom(session,start).map(event=>{
    let projected
    return { ...event, get summaryText() { return projected ??= summarySource(store.exact(session,event.ordinal),kind) } }
  })
}
