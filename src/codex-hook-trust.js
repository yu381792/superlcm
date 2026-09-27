// Read-only check of whether Codex already trusts SuperLcm's hooks, via Codex's own app-server `hooks/list`.
// SuperLcm never writes trust; this only decides whether to ask the user to review them in /hooks.
import { spawn } from 'node:child_process'
import { findCli } from './runtime.js'
const ours = hook => hook.handlerType === 'command' && /cli\.js"? codex-hook\b/.test(hook.command || '')
export function codexHookTrust({ env = process.env, bin = findCli('codex', env), cwd = env.HOME || process.cwd(), timeoutMs = 10000 } = {}) {
  if (!bin) return Promise.resolve({ checked: false, error: 'Codex CLI not found' })
  return new Promise(resolve => {
    let child, buf = '', done = false
    const finish = value => { if (done) return; done = true; clearTimeout(timer); try { child?.kill('SIGTERM') } catch {} resolve(value) }
    const timer = setTimeout(() => finish({ checked: false, error: 'Codex hooks/list timed out' }), timeoutMs)
    try { child = spawn(bin, ['app-server'], { env, cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }) } catch (error) { return finish({ checked: false, error: error.message }) }
    const send = message => child.stdin.write(JSON.stringify(message) + '\n')
    child.on('error', error => finish({ checked: false, error: error.message }))
    child.on('close', () => finish({ checked: false, error: 'Codex app-server exited' }))
    child.stdin.on('error', () => {})
    child.stdout.on('data', chunk => {
      buf += chunk
      if (buf.length > 4e6) return finish({ checked: false, error: 'Codex hooks/list output too large' })
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        let message; try { message = JSON.parse(buf.slice(0, i)) } catch { message = null }
        buf = buf.slice(i + 1)
        if (message?.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } }) }
        if (message?.id === 2) {
          if (message.error) return finish({ checked: false, error: message.error.message || 'hooks/list failed' })
          const hooks = (message.result?.data || []).flatMap(x => x.hooks || []).filter(ours)
          const untrusted = hooks.filter(h => h.enabled !== false && h.trustStatus !== 'trusted').map(h => h.eventName)
          return finish({ checked: true, total: hooks.length, trusted: hooks.length - untrusted.length, untrusted, ok: hooks.length > 0 && !untrusted.length })
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'superlcm', version: '0' } } })
  })
}
