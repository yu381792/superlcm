// Text alone cannot distinguish a native summary from a person quoting one.
// Verify Claude's isCompactSummary flag in the exact archived record instead.
import { coveredThrough } from './compaction.js'
const prefix = 'This session is being continued from a previous conversation'
const textOf = record => {
  const content = record?.message?.content??record?.content
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : ''
}
export function verifiedCompactionInput(store, session, messages) {
  const nativeTexts = [], promptTexts = [], packets=[]
  const through = coveredThrough(store.nodeRows(session, 0)), all=store.eventRows(session)
  const opening=messages[0]?.text?.trim()||'',packetCandidate=opening.startsWith('<superlcm-context ')
  const events=all.map(event=>{
    if(!event.preview.startsWith('user: ') && !(packetCandidate&&!event.preview))return event
    let record;try{record=JSON.parse(store.exact(session,event.ordinal))}catch{return {...event,humanPrompt:false}}
    if(record?.type!=='user'&&record?.role!=='user')return event
    const text=textOf(record),blocks=record.message?.content??record.content,toolResults=Array.isArray(blocks)&&blocks.some(b=>b.type==='tool_result')
    const human=!record.isMeta&&!record.isCompactSummary&&!toolResults&&!!text.trim()
    const value={...event,text,toolResults,humanPrompt:human,uuid:record.uuid}
    if(text.trimStart().startsWith('<superlcm-context ')&&!event.preview){packets.push({text:text.trim(),ordinal:event.ordinal});return {...value,humanPrompt:false}}
    if(!event.preview.startsWith(`user: ${prefix}`))return value
    if(record.isCompactSummary!==true){promptTexts.push(text.trim());return value}
    if(through<event.ordinal)return value
    nativeTexts.push(text.trim());return {...value,nativeSummary:true}
  })
  return { events, messages: messages.map((message, index) => {
    // The module sends at most 2000 characters. Only the opening synthetic
    // summary may be replaced; later real prompts retain their turn protection.
    const text = message.text.trim()
    const matches = original => original.slice(0, 2000).trim() === text
    const nativeSummary = index === 0 && message.role === 'user' && text.startsWith(prefix) && nativeTexts.some(matches) && !promptTexts.some(matches)
    const packet= index===0 && message.role==='user' && packetCandidate && packets.some(p=>matches(p.text)) && !events.some(e=>e.humanPrompt&&matches(e.text||''))
    return { ...message, nativeSummary, packetSummary:packet }
  }) }
}
