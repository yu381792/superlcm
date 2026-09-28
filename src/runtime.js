import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
export const runCommand = promisify(execFile)
export const cliScript = new URL('./cli.js', import.meta.url)
// Safety ceiling for one summary call, not a setting. Segments are bounded by the 字数 setting (at most 48,000) plus
// record labels, and merges by fanout × 3,600, so real inputs stay well below this.
export const MAX_SUMMARY_INPUT = 64000
export const validModel = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,127}$/.test(id)
export function paths(env=process.env) {
  const home=env.HOME || env.USERPROFILE || homedir()
  return {home,codex:resolve(env.CODEX_HOME || join(home,'.codex')),claude:resolve(env.CLAUDE_CONFIG_DIR || join(home,'.claude'))}
}
export function findCli(name,env=process.env) {
  const override=name==='codex'?env.SUPERLCM_CODEX_CLI_BIN:name==='claude'?env.SUPERLCM_CLAUDE_CLI_BIN:name==='hermes'?env.SUPERLCM_HERMES_BIN:name==='pi'?env.SUPERLCM_PI_BIN:null
  const candidate=override||name
  const home=paths(env).home
  const dirs=(env.PATH||'').split(delimiter).filter(Boolean).concat([join(home,'.local','bin'),join(home,'.npm-global','bin'),'/opt/homebrew/bin','/usr/local/bin',...(env.APPDATA?[join(env.APPDATA,'npm')]:[])])
  const files=isAbsolute(candidate)?[candidate]:dirs.flatMap(dir=>process.platform==='win32'?[join(dir,candidate+'.exe'),join(dir,candidate+'.cmd'),join(dir,candidate)]:[join(dir,candidate)])
  for(const file of files)try{accessSync(file,constants.X_OK);return file}catch{}
  return null
}
// Background summary runs use a tool exactly as the user configured it (account, provider, model). The marker
// makes SuperLcm's own hooks skip that run, so a summary job is never captured as a conversation.
export function workerEnv(env=process.env){const clean={...env,SUPERLCM_CLI_WORKER:'1'};delete clean.SUPERLCM_ANTHROPIC_API_KEY;return clean}
// Whether the SuperLcm Claude plugin is switched on in the user's Claude settings (plugin id superlcm@<marketplace>).
export function claudePluginEnabled(env=process.env){
  try{return Object.entries(JSON.parse(readFileSync(join(paths(env).claude,'settings.json'),'utf8')).enabledPlugins||{}).some(([id,on])=>on===true&&/^superlcm@/.test(id))}catch{return false}
}
export const commandOptions = env => ({env,timeout:12000,maxBuffer:2*1024*1024,windowsHide:true})

// Node that the connected tools should launch SuperLcm with. Prefer one that no AI tool ships inside its
// own folder (Hermes bundles one under ~/.hermes/node): a tool update can replace or remove its copy.
const TOOL_DIRS = [['.hermes', 'Hermes'], ['.codex', 'Codex'], ['.claude', 'Claude Code'], ['.pi', 'Pi']]
const recentNode = new Map()
function nodeRecentEnough(bin) {
  if (!recentNode.has(bin)) {
    let ok = false
    try { const [major, minor] = spawnSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000 }).stdout.trim().split('.').map(Number); ok = major > 22 || (major === 22 && minor >= 16) } catch {}
    recentNode.set(bin, ok)
  }
  return recentNode.get(bin)
}
export function nodeOwner(bin, env = process.env) {
  let real; try { real = realpathSync(bin) } catch { return null }
  let home = paths(env).home; try { home = realpathSync(home) } catch {}
  return TOOL_DIRS.find(([dir]) => real.startsWith(join(home, dir) + sep))?.[1] || null
}
export function preferredNode(env = process.env) {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const candidates = [process.execPath, '/usr/local/bin/node', '/opt/homebrew/bin/node', ...(env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, exe))]
  for (const bin of candidates) {
    let real; try { accessSync(bin, constants.X_OK); real = realpathSync(bin) } catch { continue }
    if (!/^node(\.exe)?$/i.test(basename(real)) || nodeOwner(bin, env)) continue // skip version-manager shims and tool-bundled copies
    if (bin !== process.execPath && !nodeRecentEnough(bin)) continue
    return { path: bin, borrowed: null }
  }
  return { path: process.execPath, borrowed: nodeOwner(process.execPath, env) }
}
