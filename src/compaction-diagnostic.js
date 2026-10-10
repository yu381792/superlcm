import { coveredThrough } from './compaction.js'
// Only known local planner messages may be published. Exceptions can contain
// transcript fragments and credentials and never become diagnostic text.
export function compactionDiagnostic(plan, { nodes = [], records = 0, before = 0, trigger } = {}) {
  const common = { through: coveredThrough(nodes), records, before, trigger }
  if (plan.error) return { ...common, status: 'error', code: 'planner_exception', reason: '接管计算发生错误；保留原文并交给 Claude Code 原生压缩。' }
  if (plan.use) return { ...common, status: 'takeover', code: 'takeover', reason: 'SuperLcm 已提供后台摘要供本次压缩使用。' }
  const reasons = [
    [/takeover is off/, 'disabled', '接管未启用，使用 Claude Code 原生压缩。'],
    [/not recorded/, 'unrecorded', '会话尚未归档，使用 Claude Code 原生压缩。'],
    [/no summaries written yet/, 'no_summaries', '还没有已完成的后台摘要。'],
    [/compacted context is too large/, 'context_too_large', '替换后上下文仍过大，保留原生压缩。'],
    [/complete request and packet exceed/, 'request_too_large', '完整请求超出安全大小，保留原生压缩。'],
    [/summaries lag behind/, 'coverage_lag', '后台摘要覆盖不足，替换后上下文仍过大。'],
    [/more than one place/, 'ambiguous_boundary', '摘要边界有多个可能位置，无法安全替换。'],
    [/oldest messages.*not summarized/, 'uncovered_oldest', '上下文开头的消息尚未被摘要覆盖。'],
    [/does not match the record/, 'source_mismatch', '当前上下文与归档记录不匹配。'],
    [/could not place/, 'unplaced_boundary', '已覆盖记录与当前上下文之间没有可验证的边界。'],
    [/mechanically shortened/, 'reduced_navigation', '存在机械缩短的导航摘要，保留原生压缩以免遗漏约束。'],
    [/nothing recent/, 'no_recent_turn', '没有可以完整保留的近期用户轮次。'],
  ]
  const match = reasons.find(([pattern]) => pattern.test(plan.reason || ''))
  return { ...common, status: 'native', code: match?.[1] || 'planner_declined', reason: match?.[2] || '未满足安全接管条件，交给 Claude Code 原生压缩。' }
}
