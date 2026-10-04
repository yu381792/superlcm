import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export class ArchiveWorker {
  constructor(env = process.env, onWarning = () => {}, { onUnavailable = () => {}, onReady = () => {}, spawnProcess = spawn, restartDelayMs = 1000 } = {}) {
    this.pending = new Map(); this.serial = 0; this.closed = false
    Object.assign(this, { env, onWarning, onUnavailable, onReady, spawnProcess, restartDelayMs })
    this.failures = 0; this.stopping = false
    this.start()
  }
  start() {
    if (this.stopping) return
    this.closed = false
    const child = this.child = this.spawnProcess(process.execPath, [fileURLToPath(new URL('../src/dsh-worker.js', import.meta.url))], { env: this.env, stdio: ['pipe','pipe','pipe'] })
    const failCurrent = error => { if (child === this.child) this.fail(error) }
    child.stdin.on('error', failCurrent)
    child.stdout.on('error', failCurrent)
    child.stderr.on('error', failCurrent)
    child.stderr.on('data', data => this.onWarning(String(data).trim()))
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('error', failCurrent)
    this.lines.on('line', line => {
      if (child !== this.child || this.closed) return
      try {
        const response = JSON.parse(line), task = this.pending.get(response.id)
        if (!task) return
        this.pending.delete(response.id)
        if (response.error) task.reject(Error(response.error)); else task.resolve(response.result)
      } catch (error) { this.fail(error) }
    })
    child.once('error', error => { if (child === this.child) this.fail(error) })
    child.once('exit', code => {
      if (child !== this.child) return
      this.fail(Error('DSH archive worker stopped: ' + code))
      this.scheduleRestart()
    })
    this.request({ method: 'ping' }).then(result => {
      if (child !== this.child || this.closed || this.stopping) return
      if (!result?.ready) throw Error('DSH archive worker did not become ready')
      this.readyAt = Date.now(); this.onReady()
    }).catch(error => { if (child === this.child && !this.closed) this.fail(error) })
  }
  fail(error) {
    if (this.closed) return
    if (this.readyAt && Date.now() - this.readyAt > 30000) this.failures = 0
    this.readyAt = null
    this.closed = true
    for (const task of this.pending.values()) task.reject(error)
    this.pending.clear()
    if (!this.stopping) this.onUnavailable(error)
    this.child.stdin.end()
    if (this.child.exitCode !== null || !this.child.pid) this.scheduleRestart()
  }
  scheduleRestart() {
    if (this.stopping || this.restartTimer) return
    const delay = Math.min(30000, this.restartDelayMs * 2 ** Math.min(5, this.failures++))
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      try { this.start() } catch (error) { this.closed = true; this.onUnavailable(error); this.scheduleRestart() }
    }, delay)
    this.restartTimer.unref()
  }
  request(body) {
    if (this.closed) return Promise.reject(Error('DSH archive worker is unavailable'))
    const id = ++this.serial, line = JSON.stringify({ id, ...body }) + '\n'
    if (Buffer.byteLength(line) > 32e6) return Promise.reject(Error('DSH archive request exceeds 32 MB'))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(line, error => {
        if (error) { this.pending.delete(id); reject(error) }
      })
    })
  }
  close() {
    this.stopping = true
    clearTimeout(this.restartTimer)
    // EOF lets the worker drain accepted requests and close its SQLite handle.
    this.child.stdin.end()
    return new Promise(resolve => {
      if (this.child.exitCode !== null) resolve()
      else this.child.once('exit', resolve)
    })
  }
}
