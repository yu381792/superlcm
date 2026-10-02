// A Claude Code module (2.1.286+), two jobs:
// 接管压缩: when the main conversation compacts, SuperLcm answers with its own summaries plus the newest
// messages word for word (see src/compaction.js). Anything unexpected, the setting being off, a subagent, or
// summaries that lag behind, hands the compaction back to Claude Code.
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
      if (!saved.saved || !saved.more) return
    }
  } catch { try { await cli($, 'summary-handoff', id) } catch {} }
  finally { writing.delete(id) }
}
export function register(on) {
  on('session.start', async ($, e, next) => {
    try { if (!e.agentId) await cli($, 'summary-host', await $.session.id()) } catch {}
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) $.session.id().then(id => writeSummaries($, id)).catch(() => {})
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    try { await cli($, 'summary-handoff', await $.session.id()) } catch {}
    return next(e)
  })
  on('session.compact', async ($, e, next) => {
    // Precompute (Claude Code's own background preparation) and subagents stay with Claude Code.
    if (e.trigger === 'precompute' || e.agentId) return next(e)
    let plan
    try {
      const [id, usage] = await Promise.all([$.session.id(), $.session.usage()])
      const messages = e.messages.map(m => ({ role: m.role, text: m.text.slice(0, 2000), toolResults: m.toolResults?.length ? 1 : 0, size: m.text.length + JSON.stringify(m.toolUses || []).length + JSON.stringify(m.toolResults || []).length + 200 }))
      const input = JSON.stringify({ messages, instructions: e.instructions || '', tokens: usage.context.tokens || 0, window: usage.context.window || 0 })
      const run = await $.process.run(['node', `${$.plugin.root}/src/launch.js`, 'compact-packet', id], { stdin: input, timeoutMs: 60000 })
      plan = JSON.parse(run.stdout.trim().split('\n').at(-1) || '{}')
    } catch { plan = null }
    if (!plan?.use || !(plan.start > 0) || plan.start >= e.messages.length) return next(e)
    return { messages: [{ role: 'user', text: plan.packet, toolUses: [] }, ...e.messages.slice(plan.start)] }
  })
}
