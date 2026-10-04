// Host adapters report facts here; the console never infers a running engine
// from a configuration file. No prompts, API keys or provider errors are stored.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const runtimeVersion = version
export const compressionCapabilities = {
  'claude-code': { supported: true, owner: 'superlcm', mode: 'takeover' },
  dsh: { supported: true, owner: 'superlcm', mode: 'takeover' },
  codex: { supported: false, owner: null, mode: 'summary-only' },
  hermes: { supported: false, owner: null, mode: 'summary-only' },
  pi: { supported: false, owner: null, mode: 'summary-only' },
}
const schema = `CREATE TABLE IF NOT EXISTS superlcm_compression_runtime(
  instance TEXT NOT NULL, session TEXT NOT NULL, harness TEXT NOT NULL,
  kind TEXT NOT NULL, profile TEXT, pid INTEGER NOT NULL, version TEXT NOT NULL,
  phase TEXT NOT NULL, enabled INTEGER NOT NULL, route_ready INTEGER NOT NULL,
  source_start INTEGER, source_end INTEGER, updated_ms INTEGER NOT NULL,
  PRIMARY KEY(instance,session));
  CREATE INDEX IF NOT EXISTS superlcm_compression_runtime_updated ON superlcm_compression_runtime(updated_ms);`
export class CompressionReporter {
  constructor(db, { kind, profile = null, enabled = false, routeReady = false, clock = Date.now, onError = () => {} }) {
    this.db = db; this.clock = clock; this.onError = onError; this.instance = randomUUID()
    this.kind = kind; this.profile = profile; this.enabled = enabled; this.routeReady = routeReady
    this.phase = 'loaded'
    db.exec(schema)
    this.report('', 'loaded')
    this.timer = setInterval(() => this.report('', this.phase), 15000); this.timer.unref()
  }
  report(session, phase, selection = {}) {
    if (this.closed) return
    if (session === '') this.phase = phase
    try {
      this.db.prepare(`INSERT INTO superlcm_compression_runtime VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(instance,session) DO UPDATE SET phase=excluded.phase,enabled=excluded.enabled,
        route_ready=excluded.route_ready,source_start=excluded.source_start,source_end=excluded.source_end,updated_ms=excluded.updated_ms`)
        .run(this.instance, session, 'dsh', this.kind, this.profile, process.pid, version, phase,
          +this.enabled, +this.routeReady, selection.start ?? null, selection.end ?? null, this.clock())
    } catch (error) { this.onError(error) }
  }
  configure({ enabled, routeReady }) { this.enabled = enabled; this.routeReady = routeReady; this.report('', this.phase) }
  applied(revision) {
    this.db.exec('CREATE TABLE IF NOT EXISTS superlcm_compression_settings_ack(instance TEXT PRIMARY KEY,revision TEXT NOT NULL)')
    this.db.prepare('INSERT INTO superlcm_compression_settings_ack VALUES(?,?) ON CONFLICT(instance) DO UPDATE SET revision=excluded.revision').run(this.instance,revision)
    this.report('','loaded')
  }
  close() { clearInterval(this.timer); this.report('', 'stopped'); this.closed = true }
}
export function compressionSnapshot(store, { now = Date.now(), alive = pid => { try { process.kill(pid, 0); return true } catch { return false } } } = {}) {
  if (!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='superlcm_compression_runtime'").get()) return { runtimes: [], jobs: [] }
  const recent = store.db.prepare("SELECT * FROM superlcm_compression_runtime WHERE session='' ORDER BY updated_ms DESC LIMIT 100").all()
  const runtimes = recent.map(row => ({ ...row, enabled: !!row.enabled, route_ready: !!row.route_ready,
    live: row.phase === 'loaded' && row.updated_ms <= now && row.updated_ms > now - 45000 && alive(row.pid) }))
  if(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='superlcm_compression_settings_ack'").get())for(const row of runtimes)row.settings_revision=store.db.prepare('SELECT revision FROM superlcm_compression_settings_ack WHERE instance=?').get(row.instance)?.revision||null
  const active = new Set(runtimes.filter(r => r.live).map(r => r.instance))
  const jobs = store.db.prepare("SELECT * FROM superlcm_compression_runtime WHERE session<>'' ORDER BY updated_ms DESC LIMIT 20").all()
    .map(row => ({ ...row, live: active.has(row.instance) }))
  return { runtimes, jobs }
}
