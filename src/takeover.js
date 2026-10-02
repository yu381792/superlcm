// Turning 接管压缩 on or off. On: Claude Code's autoCompactWindow (when its automatic compaction starts)
// is set to the chosen size, and whatever it was before is remembered. Off: that earlier value comes back.
// Claude Code reads CLAUDE_CODE_AUTO_COMPACT_WINDOW before autoCompactWindow, so an env value set
// there would override the takeover's size: the same size is also set under env in settings.json. Only these two keys are touched, with an
// atomic rewrite.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { paths } from './runtime.js'
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
const ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
// What to restore later: Claude Code's own values of both keys (older versions stored only the first).
function remembered(previous) {
  const v = previous ? JSON.parse(previous) : null
  return v && typeof v === 'object' && 'window' in v ? v : { window: v, env: null }
}
function withWindow(settings, window, envValue) {
  const next = { ...settings }, env = { ...(settings.env && typeof settings.env === 'object' ? settings.env : {}) }
  if (window === null || window === undefined) delete next.autoCompactWindow; else next.autoCompactWindow = window
  if (envValue === null || envValue === undefined) delete env[ENV_KEY]; else env[ENV_KEY] = String(envValue)
  if (Object.keys(env).length) next.env = env; else delete next.env
  return next
}
export function applyTakeover(store, { enabled, window, keep }, env = process.env) {
  const current = store.takeover(), file = settingsFile(env), settings = readSettings(file)
  window = window ?? current.window; keep = keep ?? current.keep
  if (enabled) {
    // Remember Claude Code's own values only when turning on, so changing the size keeps the originals.
    // (Older versions remembered only the window: the env value is taken now, before it is changed.)
    const own = { window: settings.autoCompactWindow ?? null, env: settings.env?.[ENV_KEY] ?? null }
    const kept = current.enabled ? remembered(current.previous) : own
    const previous = JSON.stringify(current.enabled && !String(current.previous || '').includes('"env"') ? { window: kept.window, env: own.env } : kept)
    store.setTakeover({ enabled: true, window, keep, previous })
    // If Claude's settings cannot be written, the takeover stays as it was rather than on in name only.
    try {
      const now = readSettings(file), next = withWindow(now, window, window)
      if (JSON.stringify(next) !== JSON.stringify(now)) writeSettings(file, next)
    } catch (error) { store.setTakeover(current); throw error }
  } else {
    if (current.enabled) {
      const before = remembered(current.previous), now = readSettings(file), next = withWindow(now, before.window, before.env)
      if (JSON.stringify(next) !== JSON.stringify(now)) writeSettings(file, next)
    }
    store.setTakeover({ enabled: false, window, keep, previous: null })
  }
  return { ...store.takeover(), claude_window: claudeCompactWindow(env) }
}
