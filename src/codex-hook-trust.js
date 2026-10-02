// Whether Codex trusts SuperLcm's hooks, via Codex's own app-server `hooks/list`. With approve:true (only after
// the user confirmed in the console) it records the same trust Codex's /hooks review would: each hook's
// currentHash under hooks.state in config.toml, written through the app-server's config/batchWrite.
// Only hooks whose command is exactly SuperLcm's are touched.
import { spawn } from 'node:child_process'
import { findCli } from './runtime.js'
// Setup quotes each word ('...' on macOS/Linux, "..." on Windows), so allow a quote around either side.
// The entry is cli.js from a checkout, or superlcm.js (the fixed entry that follows plugin updates).
const ours = hook => hook.handlerType === 'command' && /(?:cli|superlcm)\.js['"]? +['"]?codex-hook\b/.test(hook.command || '')
export function codexHookTrust({ env = process.env, bin = findCli('codex', env), cwd = env.HOME || process.cwd(), timeoutMs = 10000, approve = false, command = null } = {}) {
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
        if (message?.id === 2 || message?.id === 4) {
          if (message.error) return finish({ checked: false, error: message.error.message || 'hooks/list failed' })
          // Given the exact command setup writes, only that hook counts (another cli.js codex-hook entry is not ours).
          const hooks = (message.result?.data || []).flatMap(x => x.hooks || []).filter(ours).filter(h => !command || h.command === command)
          const pending = hooks.filter(h => h.enabled !== false && h.trustStatus !== 'trusted')
          const approvable = pending.filter(h => h.key && h.currentHash)
          if (message.id === 2 && approve && approvable.length) {
            send({ id: 3, method: 'config/batchWrite', params: { edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value: Object.fromEntries(approvable.map(h => [h.key, { trusted_hash: h.currentHash }])) }] } })
            continue
          }
          const untrusted = pending.map(h => h.eventName)
          return finish({ checked: true, total: hooks.length, trusted: hooks.length - untrusted.length, untrusted, ok: hooks.length > 0 && !untrusted.length, ...(message.id === 4 ? { approved: true } : {}) })
        }
        if (message?.id === 3) {
          if (message.error) return finish({ checked: false, error: message.error.message || 'config/batchWrite failed' })
          send({ id: 4, method: 'hooks/list', params: { cwds: [cwd] } })
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'superlcm', version: '0' } } })
  })
}
