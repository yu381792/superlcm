import { SUMMARY_MAX_CHARS, SUMMARY_SYSTEM, summaryPromptParts, joinSummaryPrompt, checkedSummary } from './summary-policy.js'
export const CAPPED_TAG = '[SuperLcm reduced navigation]'
export const isReducedSummary = text => String(text).includes(CAPPED_TAG)
export function repairSummaryPrompt(draft, task = {}) {
  return SUMMARY_SYSTEM + '\n\n' + joinSummaryPrompt(repairSummaryPromptParts(draft, task))
}
export function repairSummaryPromptParts(draft, task = {}) {
  return summaryPromptParts(draft, { ...task, repairDraft: true })
}
export function reducedNotice(task = {}, originalLength = null) {
  const range = Number.isSafeInteger(task.first) && Number.isSafeInteger(task.last) ? `records #${task.first}–#${task.last}` : 'the cited source records'
  return `${CAPPED_TAG} ${originalLength === null ? 'A source summary was mechanically shortened.' : `A complete ${originalLength}-character draft was mechanically shortened.`} Navigation only; facts and constraints may be missing. Before using this for task continuation, read ${range} with lcm_read. Full originals are preserved.`
}
export function capNavigation(draft, task) {
  const note = reducedNotice(task, draft.length), room = SUMMARY_MAX_CHARS - note.length - 24
  let head = draft.slice(0, room)
  const end = head.lastIndexOf('\n')
  if (end >= room / 2) head = head.slice(0, end)
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
  return head + '\n\n' + note
}
export async function fitSummary(draft, repair, { task = {}, onQuality = () => {}, onOvershoot = () => {} } = {}) {
  let best = checkedSummary(draft, { ...task, maxChars: null })
  if (best.length > 64000) throw Error('Complete summary exceeds the repair input limit; original content retained')
  onOvershoot(best.length / (task.requestChars || task.maxChars || SUMMARY_MAX_CHARS))
  for (let round = 0; best.length > SUMMARY_MAX_CHARS && round < 2; round++) {
    const next = checkedSummary(await repair(best, round), { ...task, maxChars: null })
    if (next.length > 64000) throw Error('Complete summary exceeds the repair input limit; original content retained')
    const previous = best.length
    if (next.length < best.length) best = next
    if (best.length <= SUMMARY_MAX_CHARS) break
    if (best.length > previous * 0.9) break
  }
  const capped = best.length > SUMMARY_MAX_CHARS
  const summary = checkedSummary(capped ? capNavigation(best, task) : best, task)
  onQuality({ capped })
  return summary
}
