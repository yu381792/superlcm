import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export class ArchiveWorker {
  constructor(env = process.env, onWarning = () => {}) {
    this.pending = new Map(); this.serial = 0; this.closed = false
    this.child = spawn(process.execPath, [fileURLToPath(new URL('../src/dsh-worker.js', import.meta.url))], { env, stdio: ['pipe','pipe','pipe'] })
    this.child.stderr.on('data', data => onWarning(String(data).trim()))
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', line => {
      try {
        const response = JSON.parse(line), task = this.pending.get(response.id)
        if (!task) return
        this.pending.delete(response.id)
        if (response.error) task.reject(Error(response.error)); else task.resolve(response.result)
      } catch (error) { this.fail(error) }
    })
    this.child.once('error', error => this.fail(error))
    this.child.once('exit', code => this.fail(Error('DSH archive worker stopped: ' + code)))
  }
  fail(error) {
    this.closed = true
    for (const task of this.pending.values()) task.reject(error)
    this.pending.clear()
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
    // EOF lets the worker drain accepted requests and close its SQLite handle.
    this.child.stdin.end()
    return new Promise(resolve => {
      if (this.child.exitCode !== null) resolve()
      else this.child.once('exit', resolve)
    })
  }
}
