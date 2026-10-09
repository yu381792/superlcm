import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ClaudeStore } from '../src/store.js'
import { captureDshPacket } from '../src/dsh.js'
import { SuperLcmStore } from '../dsh/store.js'
import { migrateLegacyIndex } from '../dsh/migration.js'
import { ArchiveWorker } from '../dsh/worker-client.js'
import { call } from '../src/mcp.js'
import { readRawDshSession } from '../dsh/raw-session.js'
import { syncDshSummaries } from '../src/dsh-summaries.js'

const fixture = () => new ClaudeStore(mkdtempSync(join(tmpdir(), 'superlcm-dsh-test-')))
const header = { id: 'native-test', createdAt: 100, cwd: '/project' }
const record = (seq, text = 'event ' + seq) => ({ role: seq === 0 ? 'user' : 'assistant', content: text, dsh_session: header.id, event: { seq, time: 100 + seq, type: seq === 0 ? 'user/message' : 'assistant/message', data: { content: [{ type: 'text', text }] }, surfaceOp: 'append' } })
const packet = records => ({ header, title: 'DSH 任务', records })

test('historical replay keeps native activity time and does not bury active conversations', () => {
  const store = fixture()
  try {
    const recentHeader = { ...header, id: 'recent-native' }
    const recent = { ...record(0), dsh_session: recentHeader.id, event: { ...record(0).event, time: 1000 } }
    const active = captureDshPacket(store, { header: recentHeader, records: [recent] })
    const older = captureDshPacket(store, packet([record(0), record(1)]))
    assert.equal(store.source(older.session).updated_ms, 101)
    captureDshPacket(store, packet([]))
    assert.equal(store.source(older.session).updated_ms, 101)
    assert.equal(store.listSessions(2, 0, 'dsh').sessions[0].session, active.session)
  } finally { store.close() }
})

test('activity cursor and timestamp are protected against a concurrent writer', () => {
  const store = fixture(), other = new DatabaseSync(join(store.dir, 'lcm.sqlite'))
  try {
    const { session } = captureDshPacket(store, packet([record(0)]))
    const prepare = store.db.prepare.bind(store.db)
    let protectedWrite = false
    store.db.prepare = sql => {
      const statement = prepare(sql)
      if (!protectedWrite && sql === 'SELECT records FROM session_event_counts WHERE session=?') {
        const get = statement.get.bind(statement)
        statement.get = (...args) => {
          assert.throws(() => other.prepare('UPDATE dsh_activity SET time_ms=9999 WHERE session=?').run(session), /locked/)
          protectedWrite = true
          return get(...args)
        }
      }
      return statement
    }
    captureDshPacket(store, packet([record(1)]))
    assert.equal(protectedWrite, true)
    assert.equal(store.source(session).updated_ms, 101)
    assert.equal(prepare('SELECT records FROM dsh_activity WHERE session=?').get(session).records, 2)
  } finally { other.close(); store.close() }
})

test('cold capture reads raw persistence and excludes synthetic interrupted-turn closers', async () => {
  const originals = [record(0).event], synthetic = { seq: 1, type: 'turn/end' }
  let disposed = false, closed = false
  const ctx = {
    sessionQuery: { observeSession: async () => ({ source: 'prepared', header, events: [...originals, synthetic], [Symbol.dispose]: () => { disposed = true } }) },
    sessionPersistence: { open: async (_id, access) => { assert.equal(access, 'read'); return { header, read: async () => ({ events: originals }), close: async () => { closed = true } } } },
  }
  const observation = await readRawDshSession(ctx, header.id)
  assert.equal(disposed, false, 'raw persistence is read before query projections'); assert.deepEqual(observation.events, originals)
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

test('a legacy header without delegationDepth accepts its default only and refreshes the native title', () => {
  const store = fixture()
  try {
    const result = captureDshPacket(store, { header, records: [record(0)] })
    store.db.prepare('UPDATE dsh_mirrors SET header=? WHERE session=?').run(JSON.stringify(Object.fromEntries(Object.entries(header).sort(([a], [b]) => a.localeCompare(b)))), result.session)
    captureDshPacket(store, { header: { ...header, delegationDepth: 0 }, records: [record(1)], title: 'Native user title' })
    assert.equal(store.stats(result.session).records, 2)
    assert.equal(store.metadata(result.session).name, 'Native user title')
    assert.equal(store.metadata(result.session).name_source, 'native')
    for (const change of [{ createdAt: 101 }, { cwd: '/different' }, { delegationDepth: 1 }, { delegationDepth: null }]) {
      assert.throws(() => captureDshPacket(store, { header: { ...header, delegationDepth: 0, ...change }, records: [] }), /identity changed/)
    }
  } finally { store.close() }
})

test('DSH coverage counts exact original surface messages, not metadata or preview text', () => {
  const store = fixture(), native = new SuperLcmStore(join(store.dir, 'lcm.sqlite'))
  try {
    const event = (seq, type, op, source) => ({ role: type === 'user/message' ? 'user' : 'assistant', content: '', dsh_session: header.id,
      event: { seq, type, data: { ...(source ? { source } : {}), content: [] }, ...(op ? { surfaceOp: seq % 2 ? op : { op } } : {}) } })
    const records = [event(0, 'turn/start'), event(1, 'system/message', 'append'), event(2, 'user/message', 'append'),
      event(3, 'tool/call'), event(4, 'assistant/message', 'append'), event(5, 'tool/result', 'append'), event(6, 'compaction/summary'),
      event(7, 'user/message', 'replace', { kind: 'compact-checkpoint' }), event(8, 'user/message', 'replace'),
      event(9, 'developer/message', 'append'), event(10, 'tool/result', 'replace')]
    native.upsertNode({ sessionId: header.id, nodeId: 'surface-node', summarySeq: 6, summary: [{ type: 'text', text: 'Source summary' }], summaryText: 'Source summary', sourceSeqs: [2, 4, 5], childIds: [], status: 'ready' })
    const { session } = captureDshPacket(store, packet(records)), stats = store.stats(session), listed = store.listSessions().sessions[0]
    assert.equal(stats.records, 11)
    assert.equal(stats.raw_records, 5); assert.equal(stats.summarized_records, 3); assert.equal(stats.unsummarized_records, 2)
    assert.equal(stats.non_message_records, 3); assert.equal(stats.persistent_records, 2); assert.equal(stats.checkpoint_records, 1)
    assert.deepEqual(stats.covered_ranges, [{ from: 2, to: 2 }, { from: 4, to: 5 }])
    assert.deepEqual(stats.unsummarized_ranges, [{ from: 8, to: 8 }, { from: 10, to: 10 }])
    assert.deepEqual(stats.latest_tail, { from: 8, to: 10, records: 2, ranges: stats.unsummarized_ranges })
    assert.deepEqual(store.outline(session).unsummarized, stats.latest_tail)
    for (const key of ['records', 'raw_records', 'summarized_records', 'unsummarized_records', 'unsummarized_ranges', 'latest_tail']) assert.deepEqual(listed[key], stats[key])
    assert.equal(listed.summary_mode, 'off')
  } finally { native.close(); store.close() }
})

test('incremental DSH classification reads only newly archived events', () => {
  const store = fixture()
  try {
    const { session } = captureDshPacket(store, packet([record(0)])), exact = store.exact.bind(store), read = []
    store.exact = (id, seq) => { read.push(seq); return exact(id, seq) }
    captureDshPacket(store, packet([record(1), record(2)]))
    assert.deepEqual(read, [1, 2])
    read.length = 0
    store.stats(session); store.listSessions(); captureDshPacket(store, packet([]))
    assert.deepEqual(read, [])
    assert.equal(store.stats(session).raw_records, 3)
  } finally { store.close() }
})

test('replaced original versions stay archived and do not count as pending summaries', () => {
  const store = fixture(), native = new SuperLcmStore(join(store.dir, 'lcm.sqlite'))
  try {
    const old = record(0), dependency = record(1), replacement = record(2)
    replacement.event.type = 'tool/result'
    replacement.event.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 0 }
    replacement.event.sourceEventSeqs = [0, 1]
    native.upsertNode({ sessionId: header.id, nodeId: 'revised-result', summarySeq: 3, summary: [{ type: 'text', text: 'Updated result' }], summaryText: 'Updated result', sourceSeqs: [2], childIds: [], status: 'ready' })
    const { session } = captureDshPacket(store, packet([old, dependency, replacement, { ...record(3), event: { seq: 3, type: 'compaction/summary', data: {} } }]))
    const stats = store.stats(session)
    assert.equal(stats.records, 4); assert.equal(stats.raw_records, 2); assert.equal(stats.summarized_records, 1)
    assert.equal(stats.unsummarized_records, 1); assert.equal(stats.superseded_records, 1)
    assert.deepEqual(stats.unsummarized_ranges, [{ from: 1, to: 1 }], 'a cited dependency outside the actual replaced span is still pending')
    assert.deepEqual(stats.superseded_ranges, [{ from: 0, to: 0 }]); assert.match(store.exact(session, 0), /event 0/)
    const reads = [], exact = store.exact.bind(store)
    store.exact = (id, seq) => { reads.push(seq); return exact(id, seq) }
    captureDshPacket(store, packet([record(4)]))
    assert.deepEqual(reads, [4], 'classifying revisions also reads only newly appended events')
  } finally { native.close(); store.close() }
})

test('shared DSH forest makes assembled nodes transparent and carries recursive exact originals', () => {
  const store = fixture(), native = new SuperLcmStore(join(store.dir, 'lcm.sqlite'))
  try {
    const base = { sessionId: header.id, summarySeq: 8, status: 'ready', childIds: [] }
    const leaf = (nodeId, sourceSeqs, text) => ({ ...base, nodeId, sourceSeqs, summary: [{ type: 'text', text }], summaryText: text })
    native.upsertNode(leaf('leaf-one', [0, 2], 'Summary one'))
    native.upsertNode(leaf('leaf-two', [4], 'Summary two'))
    native.upsertNode({ ...base, nodeId: 'assembled', sourceSeqs: [0, 2, 4], childIds: ['leaf-one', 'leaf-two'], summary: [{ type: 'text', text: 'Summary one' }, { type: 'text', text: 'Summary two' }], summaryText: 'Summary one\n\nSummary two' })
    native.upsertNode({ ...leaf('condensed', [6], 'A genuinely shorter summary'), childIds: ['assembled'] })
    const records = Array.from({ length: 9 }, (_, i) => record(i))
    records[6].event = { seq: 6, type: 'user/message', data: { source: { kind: 'compact-checkpoint' }, content: [] }, surfaceOp: { op: 'replace' } }
    const { session } = captureDshPacket(store, packet(records))
    // Simulate a derived envelope from the prior implementation without touching native history.
    store.addNode({ session, id: 'dsh-native-assembled', level: 1, first: 0, last: 4, children: ['dsh-native-leaf-one', 'dsh-native-leaf-two'], summary: 'Historical assembled text', digest: 'old', model: 'old' })
    syncDshSummaries(store, session, header.id)
    assert.equal(store.stats(session).summary_count, 3)
    assert.equal(store.stats(session).levels, 2)
    assert.equal(store.node(session, 'dsh-native-assembled').summary, 'Historical assembled text', 'historical derived rows are retained')
    const [root] = store.roots(session)
    assert.equal(root.id, 'dsh-native-condensed'); assert.equal(root.level, 1)
    assert.deepEqual(root.children, ['dsh-native-leaf-one', 'dsh-native-leaf-two'])
    assert.deepEqual(root.source_records, [0, 2, 4]); assert.equal(root.first, 0); assert.equal(root.last, 4)
    assert.deepEqual(store.outline(session, root.id).nodes.map(n => n.id), root.children)
    assert.equal(store.summaries(session).nodes.some(n => n.id === 'dsh-native-assembled'), false)
    assert.equal(store.find('Historical assembled').summaries.length, 0)
    assert.deepEqual(native.getNode(header.id, 'condensed').sourceSeqs, [6], 'native sources stay immutable')
  } finally { native.close(); store.close() }
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

test('legacy provenance and body conflicts retain both archives and do not block other migrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-dsh-conflict-')), path = join(dir, 'old.sqlite')
  const old = new SuperLcmStore(path), target = new SuperLcmStore(join(dir, 'new.sqlite'))
  const base = { sessionId: header.id, nodeId: 'same-body', compactionId: 'historical', summarySeq: 100, summary: [{ type: 'text', text: 'Immutable summary' }], summaryText: 'Immutable summary', sourceSeqs: [13, 14, 12993], childIds: [], status: 'ready' }
  try {
    old.upsertNode(base)
    old.upsertNode({ ...base, nodeId: 'different-body' })
    old.upsertNode({ ...base, nodeId: 'new-node' })
    target.upsertNode({ ...base, summarySeq: 10, sourceSeqs: [14, 15, 387] })
    target.upsertNode({ ...base, nodeId: 'different-body', summary: [{ type: 'text', text: 'Current verified body' }], summaryText: 'Current verified body' })
  } finally { old.close() }
  const before = readFileSync(path), current = target.getNode(header.id, 'same-body'), body = target.getNode(header.id, 'different-body')
  try {
    const env = { DSH_HOME: join(dir, 'empty'), DSH_SUPERLCM_LEGACY_DB: path }
    const result = migrateLegacyIndex(target, env)
    assert.equal(result.added, 1); assert.equal(result.conflicts.length, 2)
    assert.deepEqual(result.conflicts.find(c => c.nodeId === 'same-body').fields, ['sourceSeqs', 'summarySeq'])
    assert.deepEqual(target.getNode(header.id, 'same-body'), current)
    assert.deepEqual(target.getNode(header.id, 'different-body'), body)
    assert.deepEqual(readFileSync(path), before)
    assert.equal(migrateLegacyIndex(target, env).added, 0)
    assert.equal(migrateLegacyIndex(target, env).conflicts.length, 2, 'conflicts remain explicit on the next startup')
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
