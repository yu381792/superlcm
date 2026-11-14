// DTO helpers shared by the sandboxed hook and the archive process. No system imports.
export const ids=items=>(items||[]).map(x=>typeof x==='string'?x:x.tool_use_id||x.id||x.call_id).filter(Boolean).sort()
export const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x
const resultText=v=>Array.isArray(v)&&v.every(b=>b&&typeof b==='object'&&typeof b.type==='string')
  ? v.every(b=>b.type==='text') ? v.map(b=>String(b.text??'')).join('\n') : v
  : v
export function bodies(message) {
  if(message.toolBodies)return canonical(message.toolBodies)
  const out=[]
  for(const t of message.toolUses||[])if(typeof t==='object'){
    const id=t.tool_use_id||t.id||t.call_id,name=t.name??t.tool_name??t.tool
    let value=t.input??t.arguments
    if(typeof value==='string')try{value=JSON.parse(value)}catch{}
    if(id&&(name!==undefined||value!==undefined))out.push({id,kind:'use',...(name!==undefined?{name}:{}),...(value!==undefined?{value:canonical(value)}:{})})
  }
  for(const t of Array.isArray(message.toolResults)?message.toolResults:[])if(typeof t==='object'){
    // Claude Code's live result carries the model-visible text and, in `result`, the tool's raw toolUseResult
    // (stdout/stderr objects, an edited file's original); the transcript block carries only the content.
    // Compare what the model reads: content or text, with a list of text blocks read as its text.
    const id=t.tool_use_id||t.id||t.call_id,value=resultText(t.content??t.output??t.text??t.result),error=t.is_error??t.isError
    if(id&&(value!==undefined||error!==undefined))out.push({id,kind:'result',...(value!==undefined?{value:canonical(value)}:{}),...(error!==undefined?{error}: {})})
  }
  return out
}
export function liveMessage(message) {
  return {role:message.role,text:String(message.text||''),toolUses:ids(message.toolUses),toolResultIds:ids(message.toolResultIds||message.toolResults),toolBodies:bodies(message),size:message.size??String(message.text||'').length+JSON.stringify(message.toolUses||[]).length+JSON.stringify(message.toolResults||[]).length+200}
}
