import { createHash } from 'node:crypto'
import { SUMMARY_MAX_CHARS, SUMMARY_OUTPUT_TOKENS } from './summary-policy.js'
import { estimateSummaryTokens } from './summary-tokens.js'
export { CAPPED_TAG, isReducedSummary, repairSummaryPrompt, reducedNotice, capNavigation, fitSummary } from './summary-fitting.js'
const profiles = new Map()
const bounded = (n, max) => Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : 0
export const profileKey = (endpoint, model, effort) => createHash('sha256').update(JSON.stringify([endpoint, model, effort || null])).digest('hex')
const ensure = store => store?.db.exec('CREATE TABLE IF NOT EXISTS summary_model_profiles(key TEXT PRIMARY KEY,reasoning_room INTEGER NOT NULL DEFAULT 0,overshoot REAL NOT NULL DEFAULT 1)')
export function readSummaryProfile(key, store) {
  ensure(store)
  const row = store?.db.prepare('SELECT reasoning_room,overshoot FROM summary_model_profiles WHERE key=?').get(key) || profiles.get(key) || {}
  return { reasoning_room: bounded(row.reasoning_room, 32768), overshoot: Math.max(1, Math.min(8, Number(row.overshoot) || 1)) }
}
export function updateSummaryProfile(key, change, store) {
  const old = readSummaryProfile(key, store)
  const sample = Number.isFinite(change.overshoot) && change.overshoot > 0 ? Math.max(1, Math.min(8, change.overshoot)) : null
  let next = { reasoning_room: Math.max(old.reasoning_room, bounded(change.reasoning_room, 32768)), overshoot: sample === null ? old.overshoot : sample >= old.overshoot ? sample : old.overshoot * 0.85 + sample * 0.15 }
  // Compute decay against the persisted value atomically, so concurrent models
  // cannot overwrite another worker's newer observation with a stale read.
  if (store) {
    store.db.prepare('INSERT INTO summary_model_profiles VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET reasoning_room=max(reasoning_room,excluded.reasoning_room),overshoot=CASE WHEN ? IS NULL THEN overshoot WHEN ?>=overshoot THEN ? ELSE overshoot*0.85+?*0.15 END').run(key, next.reasoning_room, sample ?? old.overshoot, sample, sample, sample, sample)
    next = readSummaryProfile(key, store)
  }
  if (profiles.size >= 256 && !profiles.has(key)) profiles.delete(profiles.keys().next().value)
  profiles.set(key, next)
  return next
}
// Reserve visible output using the source language's token density, separate
// from reasoning. These are estimates, not provider billing tokens.
export function visibleOutputRoom(text) {
  return Math.max(SUMMARY_OUTPUT_TOKENS, Math.min(9000, Math.ceil(estimateSummaryTokens(text) / Math.max(1, text.length) * Math.min(6000, text.length))))
}
export function adaptiveSummaryTask(task = {}, profile = {}) {
  const ratio = Math.max(1, Math.min(8, Number(profile.overshoot) || 1))
  return { ...task, maxChars: SUMMARY_MAX_CHARS, requestChars: Math.max(512, Math.floor(SUMMARY_MAX_CHARS / ratio)), targetTokens: Math.max(256, Math.floor((task.targetTokens || 1200) / ratio)) }
}
