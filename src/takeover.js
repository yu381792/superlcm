// Turning 接管压缩 on or off. On: Claude Code's own compaction is made to start at the chosen size, where the
// plugin module answers it with SuperLcm's summaries (hooks/compact-mod.js). Claude Code reads its window
// from env CLAUDE_CODE_AUTO_COMPACT_WINDOW before settings autoCompactWindow (the desktop app passes on only
// the env), clamps it to [100K, 1M] and to the model's window, and starts compacting at
// min(E * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE / 100, E - 13K), E being the window less what is kept for output (20K, or less with a lower output cap). So the
// window is set 100K above the chosen size (the context it shows stays roomy) and the percentage puts the
// start at the size itself. Whatever these three were before is remembered and restored when it is turned
// off; only these keys are touched, with an atomic rewrite.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { paths } from './runtime.js'
import { takeoverLimits } from './compaction.js'
const settingsFile = env => join(paths(env).claude, 'settings.json')
function readSettings(file) {
  if (!existsSync(file)) return {}
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude settings.json is not a JSON object')
  return value
}
function writeSettings(file, value) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600
  const temp = file + '.superlcm-' + randomBytes(6).toString('hex')
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode })
  renameSync(temp, file)
}
export function claudeCompactWindow(env = process.env) {
  try { const v = readSettings(settingsFile(env)).autoCompactWindow; return Number.isFinite(v) ? v : null } catch { return null }
}
const ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', PCT_KEY = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
export const HEADROOM = 100000, OUTPUT_RESERVE = 20000
export const claudeWindowFor = window => Math.min(window + HEADROOM, 1000000)
// Claude Code keeps min(max output tokens, 20K) of the window for output; a lower CLAUDE_CODE_MAX_OUTPUT_TOKENS
// (in settings env or the environment) keeps less.
export function outputReserve(settings = {}, env = process.env) {
  const n = Number(settings.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? env.CLAUDE_CODE_MAX_OUTPUT_TOKENS)
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, OUTPUT_RESERVE) : OUTPUT_RESERVE
}
// The percentage (4 decimals, as Claude Code reads it) at which Claude Code starts compacting at `window`:
// rounded up, then raised a step at a time where floating point would still land a token short.
export function claudePctFor(window, reserve = OUTPUT_RESERVE) {
  const e = claudeWindowFor(window) - reserve
  let pct = Math.ceil(window * 1e6 / e) / 1e4
  while (Math.floor(e * pct / 100) < window) pct = Math.round(pct * 1e4 + 1) / 1e4
  return pct
}
// The context size at which Claude Code starts compacting, which every size SuperLcm plans against must use. In
// ratio mode the module reports the model's whole capacity (1M), while Claude Code also applies the window kept in
// env or autoCompactWindow: with 300K at 80% it compacts at 224K, not 800K, so a packet sized for 800K left the
// context at the threshold and Claude Code compacted again a few seconds later.
export function claudeCompactAt(takeover, modelWindow = 0, env = process.env) {
  const model = Number.isFinite(modelWindow) && modelWindow > 0 ? modelWindow : 0
  if (takeover.ratio == null) return Math.min(model || takeover.window, takeover.window)
  let settings = {}
  try { settings = readSettings(settingsFile(env)) } catch {}
  const set = [env[ENV_KEY], settings.env?.[ENV_KEY], settings.autoCompactWindow].map(Number).find(n => Number.isFinite(n) && n > 0)
  const window = Math.min(set ? clamp(set, [100000, 1000000]) : model || 1000000, model || Infinity)
  const e = window - outputReserve(settings, env)
  return Math.max(0, Math.min(e * takeover.ratio, e - 13000))
}
// What to restore later: Claude Code's own values of the keys this version sets. A key missing from a record
// written by an older version was not touched by it, so it is left as it is.
function remembered(previous) {
  const v = previous ? JSON.parse(previous) : null
  return v && typeof v === 'object' && 'window' in v ? v : { window: v }
}
const own = settings => ({ window: settings.autoCompactWindow ?? null, env: settings.env?.[ENV_KEY] ?? null, pct: settings.env?.[PCT_KEY] ?? null })
function withValues(settings, values) {
  const next = { ...settings }, env = { ...(settings.env && typeof settings.env === 'object' ? settings.env : {}) }
  const put = (target, key, value) => { if (value === null || value === undefined) delete target[key]; else target[key] = value }
  if ('window' in values) put(next, 'autoCompactWindow', values.window)
  if ('env' in values) put(env, ENV_KEY, values.env === null ? null : String(values.env))
  if ('pct' in values) put(env, PCT_KEY, values.pct === null ? null : String(values.pct))
  if (Object.keys(env).length) next.env = env; else delete next.env
  return next
}
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v))
export function applyTakeover(store, { enabled, window, keep, ratio }, env = process.env) {
  const explicitWindow=window!==undefined
  const current = store.takeover(), file = settingsFile(env), settings = readSettings(file)
  // Sizes an older version allowed are brought inside today's limits rather than refused, also when the
  // console sends the stored value back unchanged.
  const fit = (value, stored, limits) => value == null || value === stored ? clamp(stored, limits) : value
  window = fit(window, current.window, takeoverLimits.window); keep = fit(keep, current.keep, takeoverLimits.keep)
  ratio = ratio == null ? (explicitWindow ? undefined : current.ratio) : ratio
  if(ratio!=null&&(!Number.isFinite(ratio)||ratio<.11||ratio>.99))throw Error('压缩比例必须在 11% 到 99% 之间')
  const restore = () => store.setTakeover({ ...current, ratio:current.ratio??null,window: clamp(current.window, takeoverLimits.window), keep: clamp(current.keep, takeoverLimits.keep) })
  if (enabled) {
    // Claude Code's own values are remembered when turning on, so changing the size keeps the originals; a
    // key an older version did not remember is taken now, before this version changes it.
    const previous = JSON.stringify(current.enabled ? { ...own(settings), ...remembered(current.previous) } : own(settings))
    store.setTakeover({ enabled: true, window, keep, ratio:ratio??null, previous })
    // If Claude's settings cannot be written, the takeover stays as it was rather than on in name only.
    try {
      const now = readSettings(file), host = claudeWindowFor(window)
      // Ratio mode uses the native model capacity (and any original user cap),
      // rather than an artificial 1M window installed by older takeover code.
      const values=ratio==null?{window:host,env:host,pct:claudePctFor(window,outputReserve(now,env))}:{...remembered(previous),pct:Math.round(ratio*10000)/100}
      const next=withValues(now,values)
      if (JSON.stringify(next) !== JSON.stringify(now)) writeSettings(file, next)
    } catch (error) { restore(); throw error }
  } else {
    if (current.enabled) {
      const now = readSettings(file), next = withValues(now, remembered(current.previous))
      if (JSON.stringify(next) !== JSON.stringify(now)) writeSettings(file, next)
    }
    store.setTakeover({ enabled: false, window, keep, ratio:ratio??null, previous: null })
  }
  return { ...store.takeover(), claude_window: claudeCompactWindow(env) }
}
