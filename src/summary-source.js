import { dshRecordCategory } from './dsh-summaries.js'
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
    if (['tool_use','toolCall','tool-call','function_call','custom_tool_call'].includes(block?.type)) return `[tool call ${block.name || ''}; id=${block.id || block.call_id || ''}; requested, not proof of completion]\n${textOf(block.input ?? block.arguments)}`
    if (block?.type === 'tool_result') return `[tool result id=${block.tool_use_id || ''}; ${block.is_error === true ? 'ERROR / failed' : 'outcome must be read from result'}]\n${blocks(block.content)}`
    return '' // private reasoning, binary images and administrative fields
  }).filter(Boolean).join('\n')
}
export function summarySource(raw, kind = 'jsonl') {
  if (kind === 'text') return String(raw)
  let record
  try { record = JSON.parse(raw) } catch { return '' }
  if (!record || typeof record!=='object' || Array.isArray(record)) return ''
  if (record.dsh_session && record.event) {
    const event=record.event
    if (dshRecordCategory(event)!=='original') return ''
    const role=event.type==='user/message'?'user':event.type==='tool/result'?'tool-result':'assistant'
    const data=event.data||{},message=data.message??data,content=blocks(message.content ?? message.text ?? '')
    const calls=Array.isArray(data.toolCalls)?data.toolCalls:[]
    const requested=calls.map(call=>`[tool call ${call.name||''}; id=${call.id||''}; requested, not proof of completion]\n${textOf(call.arguments??call.input)}`).join('\n')
    const text=[role==='tool-result'?`[tool result ${message.name||message.toolName||''}; id=${message.callId||message.toolCallId||''}; ${message.isError||data.error?'ERROR / failed':'outcome must be read from result'}]`:'',content,requested].filter(Boolean).join('\n')
    return text.trim()?`${role} [source time: ${textOf(event.time)}]:\n${text}`:''
  }
  let item=record, role=record.role ?? record.type
  if (record.type === 'response_item') {
    item=record.payload
    if (item?.type === 'message') role=item.role
    else if (['function_call','custom_tool_call'].includes(item?.type)) role='tool-call'
    else if (['function_call_output','custom_tool_call_output'].includes(item?.type)) role='tool-result'
    else return ''
  } else if (record.type === 'event_msg') {
    item=record.payload
    role=item?.type === 'user_message' ? 'user' : item?.type === 'agent_message' ? 'assistant' : null
  } else if (record.message?.role || ['user','assistant'].includes(role) && record.message) {
    item=record.message;role=item.role || role
  }
  let content=''
  if (role === 'tool-call') content=`[tool call ${item.name || ''}; id=${item.call_id || ''}; requested, not proof of completion]\n${textOf(item.arguments ?? item.input)}`
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
  const dsh=store.metadata(session).harness==='dsh'
  const indexed=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='dsh_node_sources'").get()
  const covered=dsh&&indexed?new Set(store.db.prepare("SELECT DISTINCT s.seq FROM dsh_node_sources s JOIN nodes n ON n.session=s.session AND n.id=s.id WHERE s.session=? AND s.id LIKE 'dsh-native-%' AND NOT EXISTS (SELECT 1 FROM dsh_shared_nodes v WHERE v.session=s.session AND v.id=s.id AND v.visible=0)").all(session).map(r=>r.seq)):new Set()
  return store.eventRowsFrom(session,start).map(event=>{
    let projected
    return { ...event, get summaryText() { return covered.has(event.ordinal)?'':projected ??= summarySource(store.exact(session,event.ordinal),kind) } }
  })
}
