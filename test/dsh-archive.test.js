import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore } from '../src/store.js'
import { captureDshPacket } from '../src/dsh.js'
import { SuperLcmStore } from '../dsh/store.js'
import { migrateLegacyIndex } from '../dsh/migration.js'
import { ArchiveWorker } from '../dsh/worker-client.js'
import { call } from '../src/mcp.js'
import { readRawDshSession } from '../dsh/raw-session.js'

const fixture = () => new ClaudeStore(mkdtempSync(join(tmpdir(), 'superlcm-dsh-test-')))
const header = { id: 'native-test', createdAt: 100, cwd: '/project' }
const record = (seq, text = 'event ' + seq) => ({ role: seq === 0 ? 'user' : 'assistant', content: text, dsh_session: header.id, event: { seq, time: 100 + seq, type: seq === 0 ? 'user/message' : 'assistant/message', data: { content: [{ type: 'text', text }] } } })
const packet = records => ({ header, title: 'DSH 任务', records })

test('cold capture reads raw persistence and excludes synthetic interrupted-turn closers', async () => {
  const originals = [record(0).event], synthetic = { seq: 1, type: 'turn/end' }
  let disposed = false, closed = false
  const ctx = {
    sessionQuery: { observeSession: async () => ({ source: 'prepared', header, events: [...originals, synthetic], [Symbol.dispose]: () => { disposed = true } }) },
    sessionPersistence: { open: async (_id, access) => { assert.equal(access, 'read'); return { header, read: async () => ({ events: originals }), close: async () => { closed = true } } } },
  }
  const observation = await readRawDshSession(ctx, header.id)
  assert.equal(disposed, true); assert.deepEqual(observation.events, originals)
  await observation.close(); assert.equal(closed, true)
})

test('native archive preserves raw events, deduplicates replay and supports cross-tool handoff', async () => {
  const store = fixture()
  try {
    const r = record(0, '接续 Claude 的任务')
    const result = captureDshPacket(store, packet([r, record(1)]))
    assert.equal(result.added, 2)
    assert.deepEqual(JSON.parse(store.exact(result.session, 0)).event, r.event)
    assert.equal(captureDshPacket(store, packet([r, record(1)])).added, 0)
    assert.equal(store.stats(result.session).records, 2)
    const handoff = await call(store, 'lcm_continue', { conversation: '#' + result.code })
    assert.match(JSON.stringify(handoff), /接续 Claude 的任务/)
    store.setGlobalSetting('agent')
    assert.equal(store.effectiveSetting(result.session).mode, 'off')
    await assert.rejects(call(store, 'lcm_summary_task', { conversation: '#' + result.code }), /not enabled/)
  } finally { store.close() }
})

test('changed event, sequence gap and changed identity refuse mutation', () => {
  const store = fixture()
  try {
    const result = captureDshPacket(store, packet([record(0)]))
    assert.throws(() => captureDshPacket(store, packet([record(0, 'changed')])), /changed/)
    assert.throws(() => captureDshPacket(store, packet([record(2)])), /sequence gap/)
    assert.throws(() => captureDshPacket(store, { ...packet([]), header: { ...header, cwd: '/other' } }), /identity changed/)
    assert.equal(store.stats(result.session).records, 1)
  } finally { store.close() }
})

test('file append before database commit is recovered once; incomplete tail is refused', () => {
  const store = fixture()
  try {
    const result = captureDshPacket(store, packet([record(0)]))
    const path = store.source(result.session).path
    appendFileSync(path, JSON.stringify(record(1)) + '\n')
    assert.equal(captureDshPacket(store, packet([record(1), record(2)])).added, 1)
    assert.equal(store.stats(result.session).records, 3)
    appendFileSync(path, '{')
    assert.throws(() => captureDshPacket(store, packet([])), /partial tail/)
  } finally { store.close() }
})

test('only committed summaries with archived sources are shared, and coverage retains holes', () => {
  const store = fixture(), native = new SuperLcmStore(join(store.dir, 'lcm.sqlite'))
  try {
    const base = { sessionId: header.id, nodeId: 'native-node', summarySeq: 3, createdAt: 103, summary: [{ type: 'text', text: 'old native summary' }], summaryText: 'old native summary', sourceSeqs: [0, 2], childIds: [], status: 'ready', model: 'original-model' }
    native.upsertNode(base)
    const result = captureDshPacket(store, packet([record(0), record(1), record(2)]))
    assert.equal(store.stats(result.session).summary_count, 0)
    captureDshPacket(store, packet([record(3)]))
    assert.equal(store.stats(result.session).summary_count, 1)
    assert.deepEqual(store.outline(result.session).nodes[0].source_records, [0, 2])
    assert.deepEqual(store.stats(result.session).unsummarized_ranges, [{ from: 1, to: 1 }, { from: 3, to: 3 }])
    native.upsertNode({ ...base, nodeId: 'unfinished', summarySeq: 2, status: 'pending' })
    captureDshPacket(store, packet([]))
    assert.equal(store.stats(result.session).summary_count, 1)
  } finally { native.close(); store.close() }
})

test('legacy summaries migrate idempotently without modifying the legacy database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-dsh-migrate-')), path = join(dir, 'old.sqlite')
  const old = new SuperLcmStore(path)
  old.upsertNode({ sessionId: header.id, nodeId: 'legacy', summarySeq: 1, summary: [], summaryText: 'persisted summary', sourceSeqs: [0], childIds: [], status: 'ready' }); old.close()
  const before = readFileSync(path), target = new SuperLcmStore(join(dir, 'new.sqlite'))
  try {
    const env = { DSH_HOME: join(dir, 'empty'), DSH_SUPERLCM_LEGACY_DB: path }
    assert.equal(migrateLegacyIndex(target, env).added, 1)
    assert.equal(migrateLegacyIndex(target, env).added, 0)
    assert.deepEqual(readFileSync(path), before)
  } finally { target.close() }
})

test('real worker captures and retrieves from the same shared database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-dsh-worker-'))
  const worker = new ArchiveWorker({ ...process.env, SUPERLCM_HOME: dir })
  try {
    const result = await worker.request({ method: 'capture', packet: packet([record(0)]) })
    const found = await worker.request({ method: 'call', name: 'lcm_find', args: { harness: 'dsh' } })
    assert.equal(found.conversations[0].code, result.code)
    assert.equal(await worker.request({ method: 'cursor', session: result.session }), 1)
    await assert.rejects(worker.request({ method: 'call', name: 'lcm_summary_task', args: {} }), /only exposes recall/)
  } finally { await worker.close() }
})
