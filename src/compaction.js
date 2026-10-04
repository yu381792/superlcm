// 接管压缩 (compaction takeover), the lossless-claw way: summaries are written in the background as the
// conversation goes; when Claude Code compacts (its own threshold, or /compact), the summaries already
// written replace the part they cover, everything newer stays word for word, and no model is called.
// When the summaries do not cover enough, the caller hands the compaction back to Claude Code.
export const PACKET_TAG = 'superlcm-context'
import { RECALL_POLICY } from './summary-policy.js'
export const takeoverDefaults = { enabled: false, window: 300000, keep: 40000 } // keep: newest tokens left word for word
export const takeoverLimits = { window: [100000, 950000], keep: [5000, 200000] }
const MAX_PACKET_CHARS = 120000
// A stretch of mostly tool calls can fill the window while its dialogue is still too short to close a
// summary segment. Dialogue up to this size goes into the packet word for word instead (tool output stays
// readable through lcm_read), so such a stretch does not hand the compaction back to Claude Code.
const RECENT_CHARS = 40000, RECENT_RECORD = 3000
const KEEP_TURNS = 2 // the newest user prompts are always kept word for word
const key = text => String(text || '').replace(/\s+/g, '').slice(0, 600)
const isPacket = m => m.role === 'user' && m.text.trimStart().startsWith(`<${PACKET_TAG} `)
// A prompt the person typed: a user message with text and no tool results.
const isPrompt = m => m.role === 'user' && m.text.trim() && !m.toolResults && !isPacket(m)
const escapeAttr = s => String(s).replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c])

// Records 0..through are covered when level-0 summaries chain from record 0 without a gap.
export function coveredThrough(nodes) {
  let through = -1
  for (const n of nodes.filter(n => n.level === 0).sort((a, b) => a.first - b.first)) {
    if (n.first > through + 1) break
    through = Math.max(through, n.last)
  }
  return through
}
// The fewest summaries that tile records 0..through: at each point the highest level that starts there.
export function frontier(nodes, through) {
  const out = []
  for (let at = 0; at <= through;) {
    const n = nodes.filter(x => x.first === at && x.last <= through).sort((a, b) => b.level - a.level)[0]
    if (!n) break
    out.push(n); at = n.last + 1
  }
  return out
}
// Where the covered part ends inside the live transcript: the index just after the last covered record
// that is still in context. Each candidate is checked against its predecessors, and against the first
// uncovered record after it, so a repeated short message ("继续") or a repeated run of messages cannot be
// mistaken for an earlier copy and drop what came between.
function cutCandidates(messages, events, through) {
  // Only messages can be found in context; title records (written every turn by the desktop app) cannot.
  const visible = events.filter(e => /^(user|assistant): /.test(e.preview))
  const covered = visible.filter(e => e.ordinal <= through).map(e => key(e.preview))
  const later = visible.filter(e => e.ordinal > through).map(e => key(e.preview))
  const keys = messages.map(m => m.text.trim() ? key(`${m.role}: ${m.text.trim()}`) : null)
  const matches = (list, at, index) => { // list[at] matches keys[index]; up to 3 earlier ones agree
    if (keys[index] !== list[at]) return false
    for (let back = 1, i = index - 1, j = at - 1; back <= 3 && j >= 0 && i >= 0; i--) {
      if (keys[i] === null || isPacket(messages[i])) continue
      if (keys[i] !== list[j]) return false
      back++; j--
    }
    if (!later.length) return true
    for (let i = index + 1; i < keys.length; i++) if (keys[i] !== null && !isPacket(messages[i])) return keys[i] === later[0]
    return true
  }
  const candidates = []
  if (covered.length) for (let i = 0; i < keys.length; i++) if (matches(covered, covered.length - 1, i)) candidates.push(i + 1)
  // The last covered record is no longer in context (an earlier compaction removed it): everything
  // still in context starts after it, so the cut is at the first later record found, where up to 3 of the
  // records after it agree too (a repeated message such as a heartbeat prompt has earlier copies).
  const follows = index => {
    for (let n = 1, i = index + 1; n <= 3 && n < later.length && i < keys.length; i++) {
      if (keys[i] === null || isPacket(messages[i])) continue
      if (keys[i] !== later[n]) return false
      n++
    }
    return true
  }
  if (later.length) for (let i = 0; i < keys.length; i++) if (keys[i] === later[0] && follows(i)) candidates.push(i)
  return [...new Set(candidates)]
}
export function cutIndex(messages, events, through) {
  const candidates = cutCandidates(messages, events, through)
  return candidates.length === 1 ? candidates[0] : null
}
// Move the cut back to the start of a turn and keep the newest turns whole.
export function tailStart(messages, cut) {
  const prompts = messages.map((m, i) => isPrompt(m) ? i : -1).filter(i => i >= 0)
  let start = Math.min(cut, prompts.length >= KEEP_TURNS ? prompts.at(-KEEP_TURNS) : prompts[0] ?? cut)
  while (start > 0 && start < messages.length && !isPrompt(messages[start])) start--
  if (start === 0 && messages.length && !isPrompt(messages[0])) start = prompts.find(i => i > 0) ?? messages.length
  return start
}
// The dialogue after the summaries, one line per record; a long record keeps its head and tail.
function recentText(events, through) {
  return events.filter(e => e.ordinal > through && /^(user|assistant): /.test(e.preview)).map(e => {
    const t = e.preview.replace(/\s+/g, ' ').trim(), h = Math.ceil(RECENT_RECORD * 0.6)
    return `[record ${e.ordinal}] ` + (t.length <= RECENT_RECORD ? t : t.slice(0, h) + ` …[${t.length - RECENT_RECORD} characters omitted; lcm_read record ${e.ordinal}]… ` + t.slice(t.length - (RECENT_RECORD - h)))
  }).join('\n')
}
export function renderPacket({ meta, summaries, through, keep, instructions, recent = null }) {
  const code = meta.code
  const head = `<${PACKET_TAG} conversation="#${code}" keep="${keep}" through="${through}">\n` +
    `This session is being continued from a previous conversation that ran out of context. The summaries below cover the earlier portion of the conversation (records 0-${through}), written by SuperLcm, the user's conversation-memory plugin, as the conversation went; the messages after this one continue it word for word. ` +
    `The complete original of the earlier portion is preserved: summaries are navigation, not proof, so before relying on a detail call lcm_read {"conversation":"#${code}","from":<first>,"to":<last>} with a summary's record range (or lcm_find / lcm_outline) and quote the original.\n` +
    RECALL_POLICY+'\n'+
    (instructions ? `The person asked this compaction to keep in mind: ${instructions.slice(0, 2000)}\n` : '')
  let body = '', omitted = 0
  for (const n of summaries) {
    const block = `<summary id="${escapeAttr(n.id)}" level="${n.level}" records="${n.first}-${n.last}">\n${String(n.summary).trim()}\n</summary>\n`
    if (head.length + body.length + block.length > MAX_PACKET_CHARS) { omitted++; continue }
    body += block
  }
  if (omitted) body += `(${omitted} more summaries did not fit; lcm_outline {"conversation":"#${code}"} lists them.)\n`
  if (recent) body += `<recent records="${recent.first}-${recent.last}">\nNot summarized yet: the dialogue of records ${recent.first}-${recent.last} word for word, tool calls and their output left out (lcm_read has them).\n${recent.text}\n</recent>\n`
  return head + body + `</${PACKET_TAG}>`
}
// tokens: Claude Code's own count of the context now; window: the auto-compact window in tokens.
// Returns { use:true, packet, start } or { use:false, reason }.
export function planCompaction(input) {
  const plan = planWith(input, null)
  if (plan.use || plan.ambiguous) return plan
  // The summaries lag behind: carry the dialogue they do not cover yet, when it is short enough.
  const { events, nodes } = input, through = coveredThrough(nodes), last = events.at(-1)?.ordinal ?? -1
  const text = recentText(events, through)
  if (last <= through || !text || text.length > RECENT_CHARS) return plan
  const inline = planWith(input, { first: through + 1, last, text })
  return inline.use ? inline : plan
}
function planWith({ meta, events, nodes, messages, instructions = '', tokens = 0, window = takeoverDefaults.window, keepTokens = takeoverDefaults.keep }, recent) {
  const through = coveredThrough(nodes)
  if (through < 0 && !recent) return { use: false, reason: 'no summaries written yet' }
  // With the dialogue carried along, every message in context is covered: the cut is at the end.
  const candidates = recent ? [messages.length] : cutCandidates(messages, events, through)
  if (candidates.length > 1) return { use: false, ambiguous: true, reason: 'summary boundary matches more than one place; use native compaction' }
  const cut = candidates.length === 1 ? candidates[0] : null
  if (cut === null) return { use: false, reason: 'could not place the summaries in the live conversation' }
  // Each message's share of Claude Code's own token count, by its size in characters.
  const size = m => m.size ?? (m.text.length + 200)
  const total = messages.reduce((s, m) => s + size(m), 0) || 1
  let start = tailStart(messages, cut)
  // tailStart moves forward only when the context opens with an unfinished turn; if that turn is not
  // covered by the summaries, dropping it would lose it.
  if (start > cut) return { use: false, reason: 'the oldest messages in context are not summarized yet' }
  if (start >= messages.length) return { use: false, reason: 'nothing recent to keep' }
  // The newest keepTokens (at most half of the context) also stay word for word, from the start of a turn,
  // even where summaries already cover them, so the work in hand continues with its full detail.
  const want = Math.min(keepTokens, tokens / 2)
  let wide = start, newest = messages.slice(start).reduce((s, m) => s + size(m), 0) * tokens / total
  while (wide > 0 && newest < want) newest += size(messages[--wide]) * tokens / total
  while (wide > 0 && !isPrompt(messages[wide])) newest += size(messages[--wide]) * tokens / total
  // One very long turn (a big task run in one go) would pull its whole length in: then keep less instead.
  if (wide > 0 && newest <= want * 2) start = Math.min(start, wide)
  if (recent) { // the context must be this record: what is dropped, and the newest message, are all in it
    const known = new Set(events.filter(e => /^(user|assistant): /.test(e.preview)).map(e => key(e.preview)))
    const text = messages.map(m => m.text.trim() && !isPacket(m) ? key(`${m.role}: ${m.text.trim()}`) : null)
    const newest = text.findLast(k => k !== null)
    if (!newest || !known.has(newest) || text.slice(0, start).some(k => k !== null && !known.has(k))) return { use: false, reason: 'the conversation in context does not match the record' }
  }
  const keep = messages.length - start
  const packet = renderPacket({ meta, summaries: frontier(nodes, through), through: recent ? recent.last : through, keep, instructions, recent })
  // Size check: the kept part's share of Claude Code's own count, plus the packet at ~2 characters a token
  // (Chinese is denser than English). Past 60% of the window the compaction would barely help.
  const kept = messages.slice(start).reduce((s, m) => s + size(m), 0)
  const after = Math.round(tokens * kept / total + packet.length / 2)
  if (after > window * 0.6) return { use: false, reason: `the summaries lag behind: about ${after} tokens would remain` }
  return { use: true, packet, start, keep, through: recent ? recent.last : through, after, ...(recent ? { recent: true } : {}) }
}
