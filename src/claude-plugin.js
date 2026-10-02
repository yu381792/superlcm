// SuperLcm as a Claude Code plugin: whether it is installed and current, which Claude Code builds can run
// its compaction module, and the three actions the Claude card offers (install, update, clean up the
// older MCP + settings.json hook connection). Every change goes through Claude Code's own `claude plugin`
// and `claude mcp` commands, except removing SuperLcm's own old hooks, which is backed up first.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCli, paths, runCommand as run, commandOptions } from './runtime.js'
import { configFiles, readJson, mcpRegistration, ownMcp, hookInspection, script } from './harness.js'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const MARKETPLACE = (() => { try { return JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8')).name } catch { return 'superlcm' } })()
export const MODULE_MIN = '2.1.287' // first Claude Code with plugin modules (session.compact)
const parts = v => String(v || '').match(/\d+(\.\d+)*/)?.[0].split('.').map(Number) || []
export function compareVersions(a, b) { const x = parts(a), y = parts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d) } return 0 }
export const runsModules = version => !!parts(version).length && compareVersions(version, MODULE_MIN) >= 0
const claude = env => findCli('claude', env) || 'claude'
const exec = (env, runCommand, args, timeout = 120000) => runCommand(claude(env), args, { ...commandOptions(env), timeout })

export async function claudePlugin({ env = process.env, runCommand = run } = {}) {
  try {
    const list = JSON.parse((await exec(env, runCommand, ['plugin', 'list', '--json'], 10000)).stdout)
    const x = Array.isArray(list) ? list.find(p => /^superlcm@/.test(p.id) && p.scope === 'user') || list.find(p => /^superlcm@/.test(p.id)) : null
    return x ? { id: x.id, version: x.version || null, enabled: x.enabled !== false, outdated: compareVersions(x.version, PACKAGE_VERSION) < 0, latest: PACKAGE_VERSION } : null
  } catch { return null }
}
// The Claude desktop app runs its own bundled Claude Code (newest folder wins), separate from the terminal's.
export function desktopClaudeVersion(env = process.env) {
  if (process.platform !== 'darwin') return null
  try { return readdirSync(join(paths(env).home, 'Library', 'Application Support', 'Claude', 'claude-code')).filter(n => /^\d+\.\d+\.\d+$/.test(n)).sort(compareVersions).at(-1) || null } catch { return null }
}
// What is left of the older connection: SuperLcm's own MCP entry in ~/.claude.json and hooks in settings.json.
export async function claudeLegacy(store, { env = process.env, runCommand = run } = {}) {
  const reg = await mcpRegistration('claude-code', { env, runCommand })
  return { mcp: ownMcp(reg, store), hooks: hookInspection('claude-code', env).events.length > 0 }
}
function backup(store, file) {
  if (!existsSync(file)) return null
  const dir = join(store.dir, 'config-backups'); mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'claude-code-' + createHash('sha256').update(file).digest('hex').slice(0, 10) + '-' + Date.now() + '-' + randomBytes(3).toString('hex') + '.bak')
  writeFileSync(path, readFileSync(file), { flag: 'wx', mode: 0o600 }); return path
}
const ourHook = h => h?.type === 'command' && typeof h.command === 'string' && h.command.includes(script) && /\bhook\b/.test(h.command)
export async function pluginAction(store, action, { env = process.env, runCommand = run } = {}) {
  if (!findCli('claude', env)) throw Error('未找到 Claude Code 命令行')
  const fail = (what, error) => { throw Error(what + '：' + String(error?.stderr || error?.message || error).trim().split('\n').slice(-2).join(' ').slice(0, 300)) }
  if (action === 'install') {
    // A checkout installs itself (local marketplace); an installed copy installs from GitHub.
    const source = existsSync(join(ROOT, '.git')) ? ROOT : 'yu381792/superlcm'
    try { await exec(env, runCommand, ['plugin', 'marketplace', 'add', source]) } catch (error) { if (!/already/i.test(String(error?.stderr || error?.message))) fail('添加插件来源失败', error) }
    try { await exec(env, runCommand, ['plugin', 'install', `superlcm@${MARKETPLACE}`]) } catch (error) { fail('安装插件失败', error) }
  } else if (action === 'update') {
    const plugin = await claudePlugin({ env, runCommand })
    if (!plugin) throw Error('还没有安装 SuperLcm 插件')
    const marketplace = plugin.id.split('@')[1]
    try { await exec(env, runCommand, ['plugin', 'marketplace', 'update', marketplace]) } catch (error) { fail('刷新插件来源失败', error) }
    try { await exec(env, runCommand, ['plugin', 'update', plugin.id]) } catch (error) { fail('更新插件失败', error) }
  } else if (action === 'cleanup') {
    if (!(await claudePlugin({ env, runCommand }))?.enabled) throw Error('先装好并启用 SuperLcm 插件，再清理旧接入')
    const backups = []
    const legacy = await claudeLegacy(store, { env, runCommand })
    if (legacy.mcp) {
      backups.push(backup(store, configFiles('claude-code', env).mcp))
      try { await exec(env, runCommand, ['mcp', 'remove', '--scope', 'user', 'superlcm']) } catch (error) { fail('移除旧的 MCP 登记失败', error) }
    }
    if (legacy.hooks) {
      const file = configFiles('claude-code', env).hooks, settings = readJson(file)
      backups.push(backup(store, file))
      for (const [event, groups] of Object.entries(settings.hooks || {})) {
        if (!Array.isArray(groups)) continue
        const kept = groups.map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !ourHook(h)) })).filter(g => g.hooks.length)
        if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event]
      }
      if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temp = file + '.superlcm-' + randomBytes(6).toString('hex')
      writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, file)
    }
    return { action, backups: backups.filter(Boolean), legacy: await claudeLegacy(store, { env, runCommand }) }
  } else throw Error('Unknown plugin action')
  return { action, plugin: await claudePlugin({ env, runCommand }) }
}
