// Hermes' config.yaml is read and written only through Hermes' own Python config code
// (the same functions `hermes mcp add` uses), so SuperLcm never hand-edits YAML or touches other keys.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findCli, paths } from './runtime.js'
// pre_llm_call is the one per-turn moment a shell hook can hand the AI a short note (对话模型生成).
export const HERMES_EVENTS = ['on_session_end', 'on_session_finalize', 'pre_llm_call']
export const hermesHome = (env = process.env) => env.HERMES_HOME || join(paths(env).home, '.hermes')
const shebang = file => { try { const first = readFileSync(file, 'utf8').split('\n')[0]; return first.startsWith('#!') ? first.slice(2).trim() : null } catch { return null } }
// Hermes installs a shell launcher that execs a venv entry point; the venv's Python sits next to that
// entry point (it may also be named in the entry point's shebang).
export function hermesPython(env = process.env) {
  if (env.SUPERLCM_HERMES_PYTHON) return env.SUPERLCM_HERMES_PYTHON
  const bin = findCli('hermes', env); if (!bin) return null
  let entry = bin
  try { const target = readFileSync(bin, 'utf8').slice(0, 4096).match(/exec\s+"([^"]+)"/)?.[1]; if (target && existsSync(target)) entry = target } catch {}
  const declared = shebang(entry)?.split(/\s+/)[0]
  if (declared && /python/.test(declared) && existsSync(declared)) return declared
  const dir = dirname(realpathSync(entry))
  return ['python3', 'python'].map(n => join(dir, n)).find(existsSync) || null
}
function runPython(env, code, input) {
  const py = hermesPython(env)
  if (!py) return Promise.reject(new Error('Hermes Python not found'))
  return new Promise((resolve, reject) => {
    const clean = { ...env }; delete clean.PYTHONPATH; delete clean.PYTHONHOME // as Hermes' own launcher does
    const child = spawn(py, ['-c', code], { env: clean, cwd: hermesHome(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Hermes config helper timed out')) }, 30000)
    child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      const line = out.split('\n').reverse().find(l => l.startsWith('SUPERLCM_JSON '))
      if (code !== 0 || !line) return reject(new Error('Hermes config helper failed: ' + (err.trim().split('\n').at(-1) || 'exit ' + code)))
      resolve(JSON.parse(line.slice(14)))
    })
    child.stdin.end(JSON.stringify(input || {}))
  })
}
export function readHermesConfig(env = process.env) {
  return runPython(env, `import json
from hermes_cli.config import load_config_readonly
c = load_config_readonly()
print("SUPERLCM_JSON " + json.dumps({"mcp": (c.get("mcp_servers") or {}).get("superlcm"), "hooks": c.get("hooks") or {}, "auto_accept": bool(c.get("hooks_auto_accept"))}))`)
}
// Adds the SuperLcm MCP server and hook entries; other servers and hooks are kept as they are.
export function writeHermesConfig(env, { mcp, hooks }) {
  return runPython(env, `import json, sys
from hermes_cli.config import load_config, save_config
from hermes_cli.mcp_config import _save_mcp_server
x = json.load(sys.stdin)
if x.get("mcp") and not _save_mcp_server("superlcm", x["mcp"]):
    raise SystemExit("Hermes rejected the SuperLcm MCP entry")
c = load_config()
h = c.get("hooks")
if not isinstance(h, dict):
    h = {}
    c["hooks"] = h
old = lambda i, entry: isinstance(i, dict) and isinstance(i.get("command"), str) and x.get("script") and x["script"] in i["command"] and "hermes-hook" in i["command"] and i["command"] != entry["command"]
for event, entry in (x.get("hooks") or {}).items():
    items = [i for i in (h.get(event) or []) if not old(i, entry)]  # replace an older SuperLcm hook instead of adding a second one
    if not any(isinstance(i, dict) and i.get("command") == entry["command"] for i in items):
        items = list(items) + [entry]
    h[event] = items
save_config(c)
print("SUPERLCM_JSON " + json.dumps({"saved": True}))`, { mcp, hooks })
}
// Read-only: which SuperLcm hook commands Hermes has already been allowed to run.
export function hermesHookTrust(command, env = process.env) {
  const file = join(hermesHome(env), 'shell-hooks-allowlist.json')
  let approvals = []
  try { approvals = JSON.parse(readFileSync(file, 'utf8')).approvals || [] } catch {}
  const untrusted = HERMES_EVENTS.filter(event => !approvals.some(a => a.event === event && a.command === command))
  return { checked: true, total: HERMES_EVENTS.length, trusted: HERMES_EVENTS.length - untrusted.length, untrusted, ok: !untrusted.length }
}
