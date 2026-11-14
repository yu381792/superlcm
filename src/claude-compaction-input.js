// Text alone cannot distinguish a native summary from a person quoting one.
// Verify Claude's isCompactSummary flag in the exact archived record instead.
import { coveredThrough } from './compaction.js'
import {claudeCompactionNodes} from './claude-checkpoints.js'
import {summaryToolPairing} from './summary-source.js'
import {isRequestCopy} from './claude-records.js'
import {hasUnrepresentedContent} from './source-completeness.js'
const prefix = 'This session is being continued from a previous conversation'
const matchKey = text => String(text||'').replace(/\s+/g,'').slice(0,600)
const textOf = record => {
  const content = record?.message?.content??record?.content
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : ''
}
export function verifiedCompactionInput(store, session, messages) {
  const nativeTexts = [], promptTexts = [], packets=[], promptOrigins=new Map(),turnOrigins=new Map()
  // Use the same quality-checked frontier as replacement planning. An old,
  // uncertified node cannot prove that a native checkpoint was covered.
  const through = coveredThrough(claudeCompactionNodes(store,session)), all=store.eventRows(session)
  const liveUserTexts=new Map(messages.filter(m=>m.role==='user'&&m.text?.trim()).map(m=>[m.text.trim(),m.text.trim()]))
  const livePrompts=new Set([...liveUserTexts.keys()].map(text=>matchKey('user: '+text)))
  const opening=messages[0]?.text?.trim()||'',packetCandidate=opening.startsWith('<superlcm-context ')
  const events=all.map(original=>{
    const event={...original}
    if(!event.preview.startsWith('user: ') && !(packetCandidate&&!event.preview))return event
    // Claude Code writes this caveat before a local command (/compact among them) and never sends it to the model.
    if(event.preview.startsWith('user: <local-command-caveat>')){
      let record;try{record=JSON.parse(store.exact(session,event.ordinal))}catch{return event}
      return record?.type==='user'&&record.isMeta===true?{...event,transcriptOnly:true}:event
    }
    if(event.preview.startsWith('user: ')&&!livePrompts.has(matchKey(event.preview)))return event
    let record;try{record=JSON.parse(store.exact(session,event.ordinal))}catch{return {...event,humanPrompt:false}}
    if(isRequestCopy(record))return {...event,humanPrompt:false}
    if(record?.type!=='user'&&record?.role!=='user')return event
    const text=textOf(record),blocks=record.message?.content??record.content,toolResults=Array.isArray(blocks)&&blocks.some(b=>b.type==='tool_result')
    const keys=[...new Set([text.trim(),text.slice(0,2000).trim()])].filter(key=>key&&liveUserTexts.has(key))
    // Similar long prompts may share a preview. Only retain a reference to a
    // matching live string, never every full historical original.
    if(!keys.length)return event
    const matchedText=liveUserTexts.get(keys[0])
    const human=!record.isMeta&&!record.isCompactSummary&&!toolResults&&!!text.trim()
    const origin=record.origin?.kind??(record.promptSource==='system'?'system':null)
    const systemOrigin=['system','task-notification'].includes(origin)
    const knownOrigin=systemOrigin||origin==='human'
    const humanPrompt=human&&!systemOrigin
    const value={...event,text:matchedText,toolResults,humanPrompt,uuid:record.uuid,...(record.isCompactSummary===true?{continuation:true}:{})}
    const endsTurn=summaryToolPairing(JSON.stringify(record)).endsTurn===true
    for(const key of keys){
      const flags=promptOrigins.get(key)||[];flags.push(knownOrigin?humanPrompt:null);promptOrigins.set(key,flags)
      const turns=turnOrigins.get(key)||[];turns.push(endsTurn);turnOrigins.set(key,turns)
    }
    if(text.trimStart().startsWith('<superlcm-context ')&&!event.preview){packets.push({text:matchedText,ordinal:event.ordinal});return {...value,humanPrompt:false}}
    if(!event.preview.startsWith(`user: ${prefix}`))return value
    if(record.isCompactSummary!==true){promptTexts.push(matchedText);return value}
    if(through<event.ordinal)return value
    nativeTexts.push(matchedText);return {...value,nativeSummary:true}
  }).map(event=>{
    // Inline fallback alone needs exact records beyond the covered prefix.
    // Do not retain every previously summarized record in memory.
    if(event.preview.startsWith('user: '))Object.defineProperty(event,'verifiedRequest',{get:()=>{
      const raw=store.exact(session,event.ordinal)
      let record;try{record=JSON.parse(raw)}catch{return null}
      const content=record?.message?.content??record?.content
      const text=textOf(record),origin=record.origin?.kind??(record.promptSource==='system'?'system':null)
      if(isRequestCopy(record)||(record?.type!=='user'&&record?.role!=='user')||record.isMeta||record.isCompactSummary||
        ['system','task-notification'].includes(origin)||Array.isArray(content)&&content.some(b=>b?.type==='tool_result')||
        !text.trim()||hasUnrepresentedContent(raw,'jsonl',{strictRecords:true}))return null
      return {ordinal:event.ordinal,text}
    }})
    if(event.ordinal>through)Object.defineProperties(event,{
      exactRaw:{get:()=>store.exact(session,event.ordinal)},
      sourceHasNonText:{get:()=>hasUnrepresentedContent(store.exact(session,event.ordinal),'jsonl',{strictRecords:true})}
    })
    return event
  })
  return { events, messages: messages.map((message, index) => {
    // The module sends at most 2000 characters. Only the opening synthetic
    // summary may be replaced; later real prompts retain their turn protection.
    const text = message.text.trim()
    const matches = original => original.trim() === text || original.slice(0, 2000).trim() === text
    const nativeSummary = index === 0 && message.role === 'user' && text.startsWith(prefix) && nativeTexts.some(matches) && !promptTexts.some(matches)
    const packet= index===0 && message.role==='user' && packetCandidate && packets.some(p=>matches(p.text)) && !events.some(e=>e.humanPrompt&&matches(e.text||''))
    const flags=message.role==='user'&&text&&!message.toolResults
      ? [...new Set([text,text.slice(0,2000).trim()].flatMap(key=>promptOrigins.get(key)||[]))] : []
    // Ambiguous human/system matches retain human protection. Untagged older
    // records keep the existing conservative prompt classification.
    const prompt=flags.length&&!flags.includes(null)?(flags.some(Boolean)?'human':'system'):undefined
    // Every matching archived origin must prove the boundary. Neither caller
    // flags nor text shared by a human and a notification can authorize a reset.
    const turns=message.role==='user'&&text&&!message.toolResults&&!message.toolResultIds?.length&&!message.toolUses?.length
      ? [...new Set([text,text.slice(0,2000).trim()].flatMap(key=>turnOrigins.get(key)||[]))] : []
    const verifiedTurnBoundary=turns.length>0&&turns.every(Boolean)
    return { ...message, nativeSummary, packetSummary:packet, verifiedTurnBoundary, ...(prompt?{prompt}:{}) }
  }) }
}
