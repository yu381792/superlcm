import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { ClaudeStore } from '../src/store.js'
import { buildHierarchy } from '../src/summarize.js'
import { captureHermes } from '../src/hermes.js'
import { planCompaction, cutIndex } from '../src/compaction.js'
import { startWeb } from '../src/web.js'
import { captureDshPacket } from '../src/dsh.js'
import { saveApiKey, readApiKey } from '../src/api-credentials.js'
import { ArchiveWorker } from '../dsh/worker-client.js'
import { CompressionReporter, compressionSnapshot } from '../src/compression-status.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, count = 4, webOwnsStore = false) {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-reliability-')), store = new ClaudeStore(join(dir, 'archive'))
  const file = join(dir, 'source.jsonl')
  writeFileSync(file, Array.from({ length: count }, (_, i) => JSON.stringify({ role: i % 2 ? 'assistant' : 'user', content: 'Synthetic decision ' + i })).join('\n') + '\n')
  store.ingest('fixture', file)
  if (!webOwnsStore) t.after(() => store.close())
  return { dir, store }
}

test('ambiguous repeated Claude sequences fall back without dropping an unsummarized decision', () => {
  const old = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: i % 2 ? 'Routine unchanged status.' : 'Routine status check.' }))
  const messages = [...old, { role: 'user', text: 'Repeat the status cycle.' }, { role: 'assistant', text: 'IMPORTANT unsummarized decision' }, ...old,
    { role: 'user', text: 'Repeat the status cycle.' }, { role: 'assistant', text: 'Current status.' }, { role: 'user', text: 'Proceed.' }, { role: 'assistant', text: 'Proceeding.' }].map(m => ({ ...m, size: 1000, toolResults: 0 }))
  const events = messages.map((m, ordinal) => ({ ordinal, preview: m.role + ': ' + m.text }))
  assert.equal(cutIndex(messages, events, 5), null)
  const plan = planCompaction({ meta: { code: 'fixture' }, events, nodes: [{ id: 'old', level: 0, first: 0, last: 5, summary: 'Old status' }], messages, tokens: 260000 })
  assert.equal(plan.use, false)
  assert.equal(plan.ambiguous, true, 'inline recent text must not bypass an ambiguous boundary')
  const afterEarlierCompaction = messages.slice(6)
  const afterPlan = planCompaction({ meta: { code: 'fixture' }, events, nodes: [{ id: 'old', level: 0, first: 0, last: 5, summary: 'Old status' }], messages: afterEarlierCompaction, tokens: 260000 })
  assert.equal(cutIndex(afterEarlierCompaction, events, 5), null, 'a later repeat is not the vanished covered prefix')
  assert.equal(afterPlan.use, false)
  assert.equal(afterPlan.ambiguous, true)
})

test('Hermes recovers an append before commit once, including the first capture', t => {
  const { dir, store } = fixture(t), nativeDir = join(dir, 'hermes'); mkdirSync(nativeDir)
  const native = new DatabaseSync(join(nativeDir, 'state.db')); t.after(() => native.close())
  native.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,parent_session_id TEXT,end_reason TEXT,title TEXT,started_at INTEGER); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT)')
  native.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run('a', null, null, 'Synthetic task', 1)
  const insert = id => native.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(id, 'a', id % 2 ? 'user' : 'assistant', 'Synthetic original ' + id)
  const env = { HERMES_HOME: nativeDir }, original = store.db
  const failCommit = () => {
    let inject = true
    store.db = new Proxy(original, { get(target, key) {
      if (key === 'exec') return sql => { if (inject && sql === 'COMMIT') { inject = false; throw Error('injected commit failure') }; return target.exec(sql) }
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
    } })
    try { assert.throws(() => captureHermes(store, 'a', { env }), /injected/) } finally { store.db = original }
  }
  insert(1); failCommit()
  captureHermes(store, 'a', { env })
  insert(2); failCommit()
  const result = captureHermes(store, 'a', { env }), file = store.source(result.session).path
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map(x => JSON.parse(x).id), [1, 2])
  assert.equal(store.stats(result.session).records, 2)
  appendFileSync(file, '{')
  assert.throws(() => captureHermes(store, 'a', { env }), /partial tail/)
  assert.match(readFileSync(file, 'utf8'), /\{$/, 'damaged bytes are preserved for inspection')
})

test('a pending summary renews its lease and does not allow a second billed call', async t => {
  const { store } = fixture(t, 2)
  const other = new ClaudeStore(store.dir); t.after(() => other.close())
  let release, calls = 0; const gate = new Promise(r => { release = r })
  const first = buildHierarchy(store, 'fixture', { model: 'synthetic', batchSize: 2, leaseDurationMs: 120, leaseHeartbeatMs: 15,
    summarize: async () => { calls++; await gate; return 'Synthetic factual summary' } })
  await new Promise(r => setTimeout(r, 190))
  const second = await buildHierarchy(other, 'fixture', { model: 'synthetic', batchSize: 2, summarize: async () => { calls++; return 'duplicate' } })
  assert.equal(second.busy, true)
  release(); assert.equal((await first).created, 1); assert.equal(calls, 1)
})

test('a writer whose lease was replaced cannot save or release the new owner', async t => {
  const { store } = fixture(t, 2)
  let release; const gate = new Promise(r => { release = r })
  const pending = buildHierarchy(store, 'fixture', { model: 'synthetic', batchSize: 2, summarize: async () => { await gate; return 'stale summary' } })
  const rejection = assert.rejects(pending, /lost its lease/)
  await tick()
  store.db.prepare('UPDATE leases SET owner=?,until_ms=? WHERE session=?').run('new-owner', Date.now() + 330000, 'fixture')
  release(); await rejection
  assert.equal(store.nodeRows('fixture', 0).length, 0)
  assert.equal(store.ownsLease('fixture', 'new-owner'), true)
})

test('changing automatic summary settings stops a pending pass before further calls', async t => {
  const { store } = fixture(t)
  store.setGlobalSetting('cli')
  let calls = 0
  const result = await buildHierarchy(store, 'fixture', { model: 'synthetic', batchSize: 2, summarize: async () => { calls++; store.setGlobalSetting('off'); return 'Synthetic summary' } })
  assert.equal(calls, 1)
  assert.equal(result.stopped, 'settings-changed')
  assert.equal(result.created, 0)
})

test('lease replacement during final original verification is fenced inside the node transaction', async t => {
  const { store } = fixture(t, 2), other = new ClaudeStore(store.dir)
  t.after(() => other.close())
  const exact = store.exact.bind(store)
  let summaryReturned = false, switched = false
  store.exact = (...args) => {
    const value = exact(...args)
    if (summaryReturned && !switched) {
      switched = true
      other.db.prepare('UPDATE leases SET owner=?,until_ms=? WHERE session=?').run('replacement-writer', Date.now() + 330000, 'fixture')
    }
    return value
  }
  await assert.rejects(buildHierarchy(store, 'fixture', { model: 'synthetic', batchSize: 2,
    summarize: async () => { summaryReturned = true; return 'Synthetic navigation summary' } }), /lost its lease/)
  assert.equal(switched, true)
  assert.equal(store.nodeRows('fixture', 0).length, 0)
  assert.equal(other.ownsLease('fixture', 'replacement-writer'), true)
})

test('DSH exposes no generic summary backend and rejects direct generic generation', async t => {
  const { store } = fixture(t, 4, true), nativeId = 'dsh-fixture'
  const { session } = captureDshPacket(store, { header: { id: nativeId }, records: [{ role: 'user', content: 'Synthetic DSH original', dsh_session: nativeId, event: { seq: 0, type: 'user/message', data: {} } }] })
  let spawns = 0
  const web = await startWeb({ store, env: { ...process.env, SUPERLCM_CLAUDE_CLI_BIN: process.execPath }, spawnWorker: () => { spawns++; return { on() {}, unref() {} } } })
  t.after(() => web.close())
  const detail = await fetch(web.url + 'api/conversation?session=' + session).then(r => r.json())
  assert.deepEqual(detail.backends, [])
  assert.equal(detail.writer_tool, null)
  const response = await fetch(web.url + 'api/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, backend: 'cli' }) })
  assert.equal(response.status, 400); assert.equal(spawns, 0)
  await assert.rejects(buildHierarchy(store, session, { model: 'synthetic', summarize: async () => 'unused' }), /owned by the compaction plugin/)
})

test('legacy settings reject reusing a key across endpoints and clear it on loopback changes', async t => {
  const { store } = fixture(t, 4, true)
  store.setGlobalSetting('api', 'synthetic', 'openai', 'https://old.example.invalid/v1')
  saveApiKey(store.dir, 'global', 'synthetic-local-fixture')
  const web = await startWeb({ store }); t.after(() => web.close())
  const save = api_url => fetch(web.url + 'api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'global', mode: 'api', model: 'synthetic', api_provider: 'openai', api_url }) })
  assert.equal((await save('https://new.example.invalid/v1')).status, 400)
  assert.match(store.globalSetting().api_url, /old\.example/)
  assert.equal((await save('http://127.0.0.1:12345/v1')).status, 200)
  assert.equal(readApiKey(store.dir, 'global'), null)
  assert.equal(store.apiConfig('fixture').apiKey, '')
})

test('archive worker failure remains unhealthy and restarts with a verified ready handshake', async t => {
  const { store } = fixture(t), reporter = new CompressionReporter(store.db, { kind: 'archive', enabled: true, routeReady: true })
  t.after(() => reporter.close())
  const children = [], ready = []
  const spawnProcess = () => {
    const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, exitCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
    child.stdin.on('data', data => {
      for (const line of String(data).trim().split('\n')) {
        const request = JSON.parse(line)
        setImmediate(() => child.stdout.write(JSON.stringify({ id: request.id, result: request.method === 'ping' ? { ready: true } : 0 }) + '\n'))
      }
    })
    child.stdin.on('finish', () => { child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('exit', 0) })
    children.push(child); return child
  }
  reporter.report('', 'starting')
  const worker = new ArchiveWorker({}, () => {}, { spawnProcess, restartDelayMs: 5, onUnavailable() { reporter.report('', 'failed') }, onReady() { reporter.report('', 'loaded'); ready.push(children.length) } })
  try {
    await tick(); await tick()
    assert.equal(ready.length, 1)
    worker.fail(Error('synthetic crash'))
    reporter.report('', reporter.phase)
    assert.equal(compressionSnapshot(store, { alive: () => true }).runtimes[0].live, false)
    await assert.rejects(worker.request({ method: 'cursor' }), /unavailable/)
    await new Promise(r => setTimeout(r, 30))
    assert.equal(ready.length, 2)
    assert.equal(await worker.request({ method: 'cursor' }), 0)
    assert.equal(compressionSnapshot(store, { alive: () => true }).runtimes[0].live, true)
    assert.doesNotThrow(() => children[1].stdin.emit('error', Object.assign(Error('synthetic pipe closed'), { code: 'EPIPE' })))
    assert.equal(compressionSnapshot(store, { alive: () => true }).runtimes[0].live, false)
    await new Promise(r => setTimeout(r, 35))
    assert.equal(ready.length, 3)
    assert.equal(await worker.request({ method: 'cursor' }), 0)
    assert.doesNotThrow(() => children[1].stdin.emit('error', Error('old pipe error')))
    assert.equal(worker.closed, false, 'a retired pipe cannot fail its replacement')
  } finally { await worker.close() }
})
