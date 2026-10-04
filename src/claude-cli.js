import { validModel, MAX_SUMMARY_INPUT, workerEnv } from './runtime.js'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './store.js'
import { SUMMARY_SYSTEM, buildSummaryPrompt, checkedSummary } from './summary-policy.js'

const MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 180000
export { SUMMARY_SYSTEM }

export function summarizeWithClaudeCli(text, { model = '', bin = process.env.SUPERLCM_CLAUDE_CLI_BIN || 'claude', env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, cwd = join(home(), 'claude-cli-cwd'), spawnProcess = spawn, summaryTask } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_SUMMARY_INPUT) throw new Error(`Claude CLI summary input must be nonempty and at most ${MAX_SUMMARY_INPUT} characters`)
  if (typeof model !== 'string' || (model && !validModel(model))) throw new Error('Invalid SUPERLCM_CLAUDE_CLI_MODEL')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Invalid Claude CLI timeout')
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  // No session file and no hooks: the run leaves nothing in the user's Claude history.
  const args = ['--print', '--output-format', 'json', ...(model ? ['--model', model] : []), '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--tools', '', '--strict-mcp-config', '--system-prompt', SUMMARY_SYSTEM]
  const prompt = buildSummaryPrompt(text, summaryTask)
  return new Promise((resolve, reject) => {
    const child = spawnProcess(bin, args, { cwd, env: workerEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = '', settled = false, overflow = false, timedOut = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    child.on('error', error => finish(new Error(`Claude CLI could not start: ${error.message}`)))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (overflow) return
      out += chunk
      if (Buffer.byteLength(out) > MAX_OUTPUT_BYTES) { overflow = true; child.kill('SIGTERM') }
    })
    child.stderr.resume() // drain without retaining sensitive transcript fragments
    child.on('close', code => {
      if (timedOut) return finish(new Error('Claude CLI summarization timed out'))
      if (overflow) return finish(new Error('Claude CLI summary output exceeded 1 MiB'))
      if (code !== 0) return finish(new Error(`Claude CLI summarization failed (exit ${code}); check CLI login/model and local logs`))
      let result
      try {
        const decoded = JSON.parse(out)
        result = Array.isArray(decoded) ? decoded.findLast(item => item?.type === 'result') : decoded
      } catch { return finish(new Error('Claude CLI did not return a JSON result envelope')) }
      if (result?.is_error || result?.type !== 'result' || typeof result.result !== 'string' || !result.result.trim()) return finish(new Error('Claude CLI summarization returned an error or empty result'))
      try { finish(null, checkedSummary(result.result,{finishReason:result.stop_reason})) }
      catch(error) { finish(error) }
    })
    child.stdin.on('error', () => { /* a rejected child will be reported by error/close */ })
    child.stdin.end(prompt)
  })
}
