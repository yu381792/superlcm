// 接管压缩 (compaction takeover), the lossless-claw way: summaries are written in the background as the
// conversation goes; when Claude Code compacts (its own threshold, or /compact), the summaries already
// written replace the part they cover, everything newer stays word for word, and no model is called.
// When the summaries do not cover enough, the caller hands the compaction back to Claude Code.
export const PACKET_TAG = 'superlcm-context'
export const takeoverDefaults = { enabled: false, window: 300000, keep: 40000 } // keep: newest tokens left word for word
export const takeoverLimits = { window: [100000, 950000], keep: [5000, 200000] }
// Where the plugin starts the compaction: the console's size, but on a model whose window leaves no room
// above it (Claude Code compacts about 30K before its window) somewhat below that window instead.
export const triggerAt = (window, live = 0) => live > 0 ? Math.min(window, Math.max(live - 50000, Math.round(live / 2))) : window
const MAX_PACKET_CHARS = 120000
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
export function cutIndex(messages, events, through) {
  const visible = events.filter(e => e.preview.trim())
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
  if (covered.length) for (let i = keys.length - 1; i >= 0; i--) if (matches(covered, covered.length - 1, i)) return i + 1
  // The last covered record is no longer in context (an earlier compaction removed it): everything
  // still in context starts after it, so the cut is at the first later record found.
  if (later.length) for (let i = 0; i < keys.length; i++) if (keys[i] === later[0]) return i
  return null
}
// Move the cut back to the start of a turn and keep the newest turns whole.
export function tailStart(messages, cut) {
  const prompts = messages.map((m, i) => isPrompt(m) ? i : -1).filter(i => i >= 0)
  let start = Math.min(cut, prompts.length >= KEEP_TURNS ? prompts.at(-KEEP_TURNS) : prompts[0] ?? cut)
  while (start > 0 && start < messages.length && !isPrompt(messages[start])) start--
  if (start === 0 && messages.length && !isPrompt(messages[0])) start = prompts.find(i => i > 0) ?? messages.length
  return start
}
export function renderPacket({ meta, summaries, through, keep, instructions }) {
  const code = meta.code
  const head = `<${PACKET_TAG} conversation="#${code}" keep="${keep}" through="${through}">\n` +
    `This session is being continued from a previous conversation that ran out of context. The summaries below cover the earlier portion of the conversation (records 0-${through}), written by SuperLcm, the user's conversation-memory plugin, as the conversation went; the messages after this one continue it word for word. ` +
    `The complete original of the earlier portion is preserved: summaries are navigation, not proof, so before relying on a detail call lcm_read {"conversation":"#${code}","from":<first>,"to":<last>} with a summary's record range (or lcm_find / lcm_outline) and quote the original.\n` +
    (instructions ? `The person asked this compaction to keep in mind: ${instructions.slice(0, 2000)}\n` : '')
  let body = '', omitted = 0
  for (const n of summaries) {
    const block = `<summary id="${escapeAttr(n.id)}" level="${n.level}" records="${n.first}-${n.last}">\n${String(n.summary).trim()}\n</summary>\n`
    if (head.length + body.length + block.length > MAX_PACKET_CHARS) { omitted++; continue }
    body += block
  }
  if (omitted) body += `(${omitted} more summaries did not fit; lcm_outline {"conversation":"#${code}"} lists them.)\n`
  return head + body + `</${PACKET_TAG}>`
}
// tokens: Claude Code's own count of the context now; window: the auto-compact window in tokens.
// Returns { use:true, packet, start } or { use:false, reason }.
export function planCompaction({ meta, events, nodes, messages, instructions = '', tokens = 0, window = takeoverDefaults.window, keepTokens = takeoverDefaults.keep }) {
  const through = coveredThrough(nodes)
  if (through < 0) return { use: false, reason: 'no summaries written yet' }
  const cut = cutIndex(messages, events, through)
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
  while (wide > 0 && !isPrompt(messages[wide])) wide--
  if (wide > 0) start = Math.min(start, wide)
  const keep = messages.length - start
  const packet = renderPacket({ meta, summaries: frontier(nodes, through), through, keep, instructions })
  // Size check: the kept part's share of Claude Code's own count, plus the packet at ~2 characters a token
  // (Chinese is denser than English). Past 60% of the window the compaction would barely help.
  const kept = messages.slice(start).reduce((s, m) => s + size(m), 0)
  const after = Math.round(tokens * kept / total + packet.length / 2)
  if (after > window * 0.6) return { use: false, reason: `the summaries lag behind: about ${after} tokens would remain` }
  return { use: true, packet, start, keep, through, after }
}
