// Turning 接管压缩 on or off. On: Claude Code's autoCompactWindow (when its automatic compaction starts)
// is set to the chosen size, and whatever it was before is remembered. Off: that earlier value comes back.
// Only this one key of Claude Code's settings.json is touched, with an atomic rewrite.
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
export function applyTakeover(store, { enabled, window }, env = process.env) {
  const current = store.takeover(), file = settingsFile(env), settings = readSettings(file)
  window = window ?? current.window
  if (enabled) {
    // Remember Claude Code's own value only when turning on, so changing the size keeps the original.
    const previous = current.enabled ? current.previous : JSON.stringify(settings.autoCompactWindow ?? null)
    store.setTakeover({ enabled: true, window, previous })
    if (settings.autoCompactWindow !== window) writeSettings(file, { ...settings, autoCompactWindow: window })
  } else {
    if (current.enabled) {
      const before = current.previous ? JSON.parse(current.previous) : null, next = { ...settings }
      if (before === null) delete next.autoCompactWindow; else next.autoCompactWindow = before
      if (JSON.stringify(next) !== JSON.stringify(settings)) writeSettings(file, next)
    }
    store.setTakeover({ enabled: false, window, previous: null })
  }
  return { ...store.takeover(), claude_window: claudeCompactWindow(env) }
}
