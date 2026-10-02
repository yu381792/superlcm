// 接管压缩: a Claude Code module (2.1.287+). When the main conversation compacts, SuperLcm answers with
// its own summaries plus the newest messages word for word (see src/compaction.js). Anything unexpected,
// the setting being off, a subagent, or summaries that lag behind, hands the compaction back to Claude Code.
export function register(on) {
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
