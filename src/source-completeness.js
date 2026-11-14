// A textual projection may only certify blocks it actually represents.
// Unknown content blocks fail closed; private reasoning is deliberately omitted.
const opaque=new Set(['image','image_url','input_image','file','input_file','document','audio','input_audio','video'])
const text=new Set(['text','input_text','output_text'])
const calls=new Set(['tool_use','toolCall','tool-call','function_call','custom_tool_call'])
const privateReasoning=new Set(['thinking','redacted_thinking'])
const recordTypes=new Set(['user','assistant','tool','toolResult','system','response_item','event_msg','session_meta','turn_context','progress','file-history-snapshot','queue-operation','custom-title','ai-title','summary','last-prompt','pr-link','metadata'])
function contentIncomplete(value){
  if(value==null)return false
  if(typeof value==='string'){
    if(!value.startsWith('\0json:'))return false
    try{return contentIncomplete(JSON.parse(value.slice(6)))}catch{return true}
  }
  if(Array.isArray(value))return value.some(blockIncomplete)
  if(typeof value!=='object')return true
  // Even a serialized wrapper may contain an image or an unknown typed block.
  return value.type?blockIncomplete(value):nestedContentIncomplete(value)
}
function nestedContentIncomplete(value){
  if(!value||typeof value!=='object')return false
  if(Array.isArray(value))return value.some(nestedContentIncomplete)
  if(value.type)return blockIncomplete(value)
  return Object.values(value).some(nestedContentIncomplete)
}
function blockIncomplete(block){
  if(!block||typeof block!=='object'||Array.isArray(block))return true
  if(opaque.has(block.type))return true
  if(text.has(block.type))return typeof block.text!=='string'
  if(calls.has(block.type))return false // input/arguments are serialized in full
  if(block.type==='tool_result')return contentIncomplete(block.content)
  if(privateReasoning.has(block.type))return false
  // A ToolSearch result names the tools it loaded; the harness reloads them, the dialogue does not depend on it.
  if(block.type==='tool_reference')return false
  return true
}
function visit(value){
  if(!value||typeof value!=='object')return false
  if(Array.isArray(value))return value.some(visit)
  if(opaque.has(value.type))return true
  if(calls.has(value.type))return false
  return Object.entries(value).some(([key,child])=>key==='content'?contentIncomplete(child):visit(child))
}
// Claude Code writes many bookkeeping records (bridge-session, relocated, agent-name, atis-latch, tools-used,
// file-history-delta, mode, frame-link, ...) and new kinds appear with every release. A record with neither a
// `message` nor `content` is not dialogue. Attachments are what the harness injects (hook output, listings,
// reminders, date, environment) and are rebuilt by it, not part of the conversation a summary must cover.
const claudeSystemNotes=new Set(['away_summary','compact_boundary','informational','local_command','turn_duration','api_error','stop_hook_summary'])
export function hasUnrepresentedContent(raw,kind='jsonl',{strictRecords=false}={}){
  if(kind==='text')return false
  let value;try{value=JSON.parse(raw)}catch{return true}
  if(!value||typeof value!=='object'||Array.isArray(value))return true
  if(strictRecords&&!value.dsh_session&&typeof value.type==='string'&&!recordTypes.has(value.type)&&!/^api-request(?:-|$)/.test(value.type)){
    if(value.type==='attachment'){
      // Attachments are what Claude Code injects and rebuilds itself (hook output, listings, reminders, token
      // counts, environment, date, re-read files); new kinds appear with every release. The one that is
      // dialogue, a prompt typed during a turn, is projected as user text and must be fully representable.
      const a=value.attachment
      if(a?.type==='queued_command'&&a.commandMode==='prompt')return typeof a.prompt==='string'?false:contentIncomplete(a.prompt)
      return false
    }
    // Any unknown payload with dialogue fields may hold information the textual projection does not represent.
    if('message' in value||'content' in value)return true
    return false
  }
  // Request copies are skipped by summaries and never replayed as dialogue.
  if(strictRecords&&/^api-request(?:-|$)/.test(value.type||''))return false
  if(strictRecords&&value.type==='system'&&(value.content!=null||value.message?.content!=null)&&!claudeSystemNotes.has(value.subtype))return true
  // toolUseResult is Claude Code's raw copy of a tool's output (search hits, an edited file's original); the
  // model reads the tool_result in message.content, which is checked.
  if(strictRecords&&value.toolUseResult!==undefined){const {toolUseResult,...rest}=value;value=rest}
  return visit(value)
}
