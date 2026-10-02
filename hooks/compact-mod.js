// A Claude Code module (2.1.286+), two jobs:
// 接管压缩: when the main conversation compacts, SuperLcm answers with its own summaries plus the newest
// messages word for word (see src/compaction.js). Anything unexpected, the setting being off, a subagent, or
// summaries that lag behind, hands the compaction back to Claude Code. The module also starts the
// compaction itself once the context reaches the window set in the console, so the size holds wherever
// the module runs (the Claude desktop app, for one, ignores autoCompactWindow); while the summaries lag it
// starts nothing and Claude Code's own threshold still applies.
// 本工具后台写: after each turn the waiting summary pieces are written with $.model.complete, on the
// session's own login and without starting another Claude Code; the turn does not wait for it. What is left
// when the session ends, or after a failed call, goes to the separate `claude -p` worker as before.
const cli = ($, command, id, stdin) => $.process.run(['node', `${$.plugin.root}/src/launch.js`, command, id], { stdin: stdin ?? '', timeoutMs: 60000 })
  .then(r => JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}'))
const MAX_PIECES = 8 // per turn; a long backlog continues after the next turn
const writing = new Set()
async function writeSummaries($, id) {
  if (writing.has(id)) return
  writing.add(id)
  try {
    for (let n = 0; n < MAX_PIECES; n++) {
      const claim = await cli($, 'summary-claim', id)
      if (!claim.work) return
      const { batch_id, system, prompt, model } = claim.work
      const use = model || await $.session.model()
      const r = await $.model.complete({ model: use, system, prompt, maxTokens: 2048, timeoutMs: 180000 })
      if (!r.isAnswered) return void await cli($, 'summary-handoff', id)
      const saved = await cli($, 'summary-save', id, JSON.stringify({ batch_id, summary: r.text, model: use }))
      if (!saved.saved) return void await cli($, 'summary-handoff', id) // refused: the separate worker takes over
      if (!saved.more) return
    }
  } catch { try { await cli($, 'summary-handoff', id) } catch {} }
  finally { writing.delete(id) }
}
const toInput = messages => messages.map(m => ({ role: m.role, text: m.text.slice(0, 2000), toolResults: m.toolResults?.length ? 1 : 0, size: m.text.length + JSON.stringify(m.toolUses || []).length + JSON.stringify(m.toolResults || []).length + 200 }))
async function packet($, id, messages, instructions, threshold = false) {
  const usage = await $.session.usage()
  const input = JSON.stringify({ messages: toInput(messages), instructions: instructions || '', tokens: usage.context.tokens || 0, window: usage.context.window || 0, threshold })
  const run = await $.process.run(['node', `${$.plugin.root}/src/launch.js`, 'compact-packet', id], { stdin: input, timeoutMs: 60000 })
  return JSON.parse(run.stdout.trim().split('\n').at(-1) || '{}')
}
// After a turn: past the console's window and with the summaries ready, compact now (between turns).
const starting = new Set()
async function compactAtWindow($, id) {
  if (starting.has(id)) return
  starting.add(id)
  try {
    // The cheap check first: below the window (or the takeover off) the transcript is not read at all.
    const early = await packet($, id, [], '', true)
    if (/below the compaction window|takeover is off/.test(early?.reason || '')) return
    const plan = await packet($, id, await $.session.messages(), '', true)
    if (plan?.use) await $.session.compact()
  } catch {} finally { starting.delete(id) }
}
export function register(on) {
  on('session.start', async ($, e, next) => {
    try { if (!e.agentId) await cli($, 'summary-host', await $.session.id()) } catch {}
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) $.session.id().then(id => {
      writeSummaries($, id)
      setTimeout(() => compactAtWindow($, id), 500) // once the turn has ended; a new turn makes it wait for the next
    }).catch(() => {})
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    try { await cli($, 'summary-handoff', await $.session.id()) } catch {}
    return next(e)
  })
  on('session.compact', async ($, e, next) => {
    // Subagents stay with Claude Code. Precompute (Claude Code preparing the compaction ahead of time,
    // kept and swapped in at the threshold without asking again) is answered too: when the summaries are
    // ready, ours is what gets kept; when they are not, Claude Code prepares its own as usual.
    if (e.agentId) return next(e)
    let id, plan
    try {
      id = await $.session.id()
      plan = await packet($, id, e.messages, e.instructions)
    } catch { plan = null }
    if (plan?.use && plan.start > 0 && plan.start < e.messages.length)
      return { messages: [{ role: 'user', text: plan.packet, toolUses: [] }, ...e.messages.slice(plan.start)] }
    // A compaction this module started is not handed to Claude Code's summarizer instead.
    if (e.trigger === 'plugin' && starting.has(id)) return { skip: 'SuperLcm: summaries not ready yet' }
    return next(e)
  })
}
