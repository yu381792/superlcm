// Text alone cannot distinguish a native summary from a person quoting one.
// Verify Claude's isCompactSummary flag in the exact archived record instead.
import { coveredThrough } from './compaction.js'
const prefix = 'This session is being continued from a previous conversation'
const textOf = record => {
  const content = record?.message?.content
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : ''
}
export function verifiedCompactionInput(store, session, messages) {
  const nativeTexts = [], promptTexts = []
  const through = coveredThrough(store.nodeRows(session, 0))
  const events = store.eventRows(session).map(event => {
    if (!event.preview.startsWith(`user: ${prefix}`)) return event
    const record = JSON.parse(store.exact(session, event.ordinal))
    if (record?.type !== 'user') return event
    if (record.isCompactSummary !== true) { promptTexts.push(textOf(record).trim()); return event }
    // Imports may begin anywhere in a long conversation. Even apparently
    // complete preceding records cannot prove the older history is present.
    // Require coverage of the continuation itself before replacing it.
    if (through < event.ordinal) return event
    nativeTexts.push(textOf(record).trim())
    return { ...event, nativeSummary: true }
  })
  return { events, messages: messages.map((message, index) => {
    // The module sends at most 2000 characters. Only the opening synthetic
    // summary may be replaced; later real prompts retain their turn protection.
    const text = message.text.trim()
    const matches = original => original.slice(0, 2000).trim() === text
    const nativeSummary = index === 0 && message.role === 'user' && text.startsWith(prefix) && nativeTexts.some(matches) && !promptTexts.some(matches)
    return { ...message, nativeSummary }
  }) }
}
