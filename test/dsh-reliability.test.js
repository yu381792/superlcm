import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Engine from '../dsh/engine.js'
import { doctorSession, reindexSession, nodeLevel } from '../dsh/core.js'
import { SuperLcmStore } from '../dsh/store.js'
import { appendRecallEnvelope, markerFromSummary } from '../dsh/marker.js'
import { apply as nativeTools } from '../dsh/tool.js'
import { isTransparentAssembly } from '../dsh/tree-semantics.js'
import { preparedTreeNodes } from '../dsh/prepared-tree.js'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { apply as archivePlugin, projectEvent } from '../dsh/archive.js'
import { ClaudeStore } from '../src/store.js'
import { captureDshPacket, dshSessionKey } from '../src/dsh.js'

test('transparent assembly proof preserves every image and file block', () => {
  const image = { type: 'image', source: { kind: 'fixture', data: 'original-image', mimeType: 'image/png' } }
  const file = { type: 'file', source: { kind: 'fixture', data: 'original-file', mimeType: 'text/plain' } }
  const blocks = [{ type: 'text', text: 'A' }, image, { type: 'text', text: 'B' }, file]
  const children = [
    appendRecallEnvelope(blocks.slice(0, 2), { id: 'proof-child-a' }),
    appendRecallEnvelope(blocks.slice(2), { id: 'proof-child-b' }),
  ]
  const wrap = value => appendRecallEnvelope(value, { id: 'proof-parent', children: ['proof-child-a', 'proof-child-b'] })
  assert.equal(isTransparentAssembly(wrap(blocks), children), true)
  assert.equal(isTransparentAssembly(wrap(blocks.filter(block => block !== image)), children), false, 'missing images cannot be hidden by equal text')
  assert.equal(isTransparentAssembly(wrap(blocks.filter(block => block !== file)), children), false, 'missing files cannot be hidden by equal text')
  assert.equal(isTransparentAssembly(wrap(blocks.map(block => block === image ? { ...image, source: { ...image.source, data: 'changed-image' } } : block)), children), false)
  assert.equal(isTransparentAssembly(wrap(blocks.map(block => block === file ? { ...file, source: { ...file.source, data: 'changed-file' } } : block)), children), false)
})

test('transparent assembly proof does not merge or split text block boundaries', () => {
  const children = [
    appendRecallEnvelope([{ type: 'text', text: 'A' }], { id: 'boundary-child-a' }),
    appendRecallEnvelope([{ type: 'text', text: 'B' }], { id: 'boundary-child-b' }),
  ]
  const wrap = blocks => appendRecallEnvelope(blocks, { id: 'boundary-parent', children: ['boundary-child-a', 'boundary-child-b'] })
  assert.equal(isTransparentAssembly(wrap([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]), children), true)
  assert.equal(isTransparentAssembly(wrap([{ type: 'text', text: 'A\nB' }]), children), false)
  assert.equal(isTransparentAssembly(wrap([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }, { type: 'text', text: 'extra' }]), children), false)
})

test('prepared tree rejects duplicate forest coverage through a reused new draft', () => {
  const summary = (id, texts, children = []) => appendRecallEnvelope(texts.map(text => ({ type: 'text', text })), { id, children })
  const a = { nodeId: 'overlap-member-a', summary: summary('overlap-member-a', ['A']), childIds: [], kind: 'leaf' }
  const b = { nodeId: 'overlap-member-b', summary: summary('overlap-member-b', ['B']), childIds: [], kind: 'leaf' }
  const checkpoint = { nodeId: 'overlap-checkpoint', summary: summary('overlap-checkpoint', ['A', 'B'], [a.nodeId, b.nodeId]), childIds: [a.nodeId, b.nodeId], kind: 'assembled' }
  const store = { getNode(session, id) { return [a, b, checkpoint].find(node => node.nodeId === id) ?? null } }
  const x = { nodeId: 'overlap-draft-x', summary: summary('overlap-draft-x', ['A compressed'], [a.nodeId]), childIds: [a.nodeId], sourceSeqs: [10], kind: 'condensed' }
  const y = { nodeId: 'overlap-draft-y', summary: summary('overlap-draft-y', ['A and B'], [x.nodeId, b.nodeId]), childIds: [x.nodeId, b.nodeId], sourceSeqs: [10], kind: 'condensed' }
  const root = { sessionId: 'fixture', nodeId: 'overlap-root', summary: summary('overlap-root', ['A compressed', 'A and B'], [x.nodeId, y.nodeId]), sourceSeqs: [10] }
  const event = { data: { preparedTree: [x, y], summaryTreeKind: 'assembled' } }
  const session = { eventAt(seq) { return { seq, type: 'user/message', data: { source: compactCheckpointSource('overlap-compaction'), content: checkpoint.summary } } } }
  assert.throws(() => preparedTreeNodes(session, event, root, store), /overlap|repeated|reused|multiple/)
})

const tick = () => new Promise(r => setImmediate(r))

for (const listingFails of [false, true]) test(listingFails
  ? 'archive mounted after host ready drains known sources even when persistence listing fails'
  : 'archive mounted after host ready replays live, mirrored cold and unseen cold sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-late-archive-')), ctx = new Context(), coldCtx = new Context()
  const envKeys = ['DSH_SUPERLCM_DB', 'DSH_HOME', 'DSH_SUPERLCM_LEGACY_DB']
  const prior = new Map(envKeys.map(key => [key, process.env[key]])), warnings = [], opened = []
  process.env.DSH_SUPERLCM_DB = join(dir, 'lcm.sqlite')
  process.env.DSH_HOME = join(dir, 'isolated-dsh')
  process.env.DSH_SUPERLCM_LEGACY_DB = join(dir, 'absent-legacy.sqlite')
  const shared = new ClaudeStore(dir)
  try {
    ctx.logger.warn = message => warnings.push(message)
    new SessionStore(ctx); new SessionStore(coldCtx)
    const append = (session, text) => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    const live = ctx.sessions.create('late-live'), mirrored = coldCtx.sessions.create('late-mirrored-cold'), unseen = coldCtx.sessions.create('late-unseen-cold')
    append(live, 'Live event before plugin mount')
    for (const session of [mirrored, unseen]) for (let i = 0; i < 3; i++) append(session, 'Persisted fixture event ' + i)
    const cold = new Map([mirrored, unseen].map(session => [session.id, { header: session.header, events: session.snapshotEvents() }]))
    let failListing = false
    ctx.reflect.provide('sessionPersistence', {
      identity: {},
      async list() { if (failListing) throw Error('fixture persistence listing failed'); return [...cold.values()].map(value => ({ header: value.header })) },
      async stat(id) { const value = cold.get(id); return value ? { header: value.header, revision: 'fixture-revision' } : undefined },
      async open(id, access) {
        assert.equal(access, 'read'); opened.push(id)
        const value = cold.get(id); assert.ok(value)
        return { header: value.header, inheritedEventCount: 0, async read() { return { events: value.events } }, async close() {} }
      },
    })
    ctx.reflect.provide('tools', { register() {} })
    new SessionQuery(ctx)
    await tick()
    assert.deepEqual(ctx.sessions.list().map(session => session.id), [live.id], 'the actual live store does not enumerate cold histories')
    assert.deepEqual(new Set((await ctx.sessionQuery.listSessions()).map(record => record.header.id)), new Set([live.id, mirrored.id, unseen.id]))
    captureDshPacket(shared, { header: mirrored.header, records: [projectEvent(mirrored.id, mirrored.eventAt(0))] })
    const native = new SuperLcmStore(join(dir, 'lcm.sqlite'))
    try { assert.deepEqual(native.archivedSessionIds(), [mirrored.id]) } finally { native.close() }
    ctx.emit('ready')
    failListing = listingFails
    archivePlugin(ctx, { archiveHome: dir })
    const deadline = Date.now() + 5000
    const expected = listingFails ? [live, mirrored] : [live, mirrored, unseen]
    const complete = () => expected.every(session => shared.source(dshSessionKey(session.id)) && shared.stats(dshSessionKey(session.id)).records === session.seq)
    while (!complete() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(complete(), true, 'worker readiness backfills every source without another ready event or chat message: ' + JSON.stringify(warnings))
    assert.ok(opened.includes(mirrored.id))
    if (!listingFails) assert.ok(opened.includes(unseen.id))
    else assert.equal(shared.source(dshSessionKey(unseen.id)), undefined, 'listing failure cannot invent a cold source')
    for (const session of expected) {
      const key = dshSessionKey(session.id)
      for (const event of session.snapshotEvents()) assert.deepEqual(JSON.parse(shared.exact(key, event.seq)).event, event)
    }
    assert.equal(warnings.some(message => /fixture persistence listing failed/.test(message)), listingFails)
    assert.equal(warnings.some(message => /not found|history became shorter|identity changed|classification is incomplete/.test(message)), false)
  } finally {
    await ctx.fiber.dispose(); await coldCtx.fiber.dispose(); shared.close()
    for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

const config = { minRetainTokens: 1000, foldBatchTokens: 2000, pressureFoldTokens: 1000, softActiveTokens: 26000, hardActiveTokens: 28000 }
async function host(response, run) {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-native-reliability-')), ctx = new Context(), prior = process.env.DSH_SUPERLCM_DB
  process.env.DSH_SUPERLCM_DB = join(dir, 'archive', 'lcm.sqlite')
  try {
    new SessionStore(ctx); new SessionProjections(ctx)
    ctx.reflect.provide('llm', { async *stream(options) { yield { type: 'text-delta', index: 0, text: '# '+await response(options) };yield{type:'finish',reason:{kind:'stop'}} }, imageRequestPricing() {}, fileRequestText() {} })
    new TokenMeter(ctx)
    new Engine(ctx, { auto: false, summarizationProvider: 'local', summarizationModel: 'old', ...config })
    const session = ctx.sessions.create('native-reliability', { meta: { cwd: '/synthetic' } }), agent = { session, options: { provider: 'local', model: 'old' } }
    for (let i = 0; i < 7; i++) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Synthetic factual source '.repeat(680) + i }] }), { surfaceOp: 'append' })
    await run({ engine: ctx.compaction, session, agent, dir })
  } finally {
    await ctx.fiber.dispose()
    if (prior === undefined) delete process.env.DSH_SUPERLCM_DB; else process.env.DSH_SUPERLCM_DB = prior
  }
}

test('doctor accepts every validated committed tree node and still detects a real orphan', async () => {
  await host(async () => 'Compact synthetic navigation summary.', async ({ engine, session, agent }) => {
    engine.startBackgroundFold(agent, engine.planRolling(agent)); await engine.settleBackgroundFold(agent)
    const result = engine.tryCommitBackgroundFold(agent, { allowPressure: true }); assert.ok(result); await tick()
    assert.ok(engine.superLcmStore.listNodes(session.id).length > 1)
    const report = doctorSession(engine.superLcmStore, session)
    assert.equal(report.ok, true); assert.deepEqual(report.staleInDb, [])
    const root = engine.superLcmStore.getNode(session.id, markerFromSummary(result.summary).id)
    engine.superLcmStore.upsertNode({ ...root, nodeId: 'synthetic-orphan', childIds: [] })
    const broken = doctorSession(engine.superLcmStore, session)
    assert.equal(broken.ok, false); assert.ok(broken.staleInDb.includes('synthetic-orphan'))
  })
})

test('three forest members below the actual checkpoint budget do not buy an early merge', async () => {
  let calls = 0
  await host(async () => ++calls <= 3 ? 'a'.repeat(1200) + calls : 'Compact facts.', async ({ engine }) => {
    engine.applyRuntimeConfig({ auto: false, summarizationProvider: 'local', summarizationModel: 'old',
      minRetainTokens: 1000, foldBatchTokens: 64000, pressureFoldTokens: 1000,
      summaryPrefixTargetTokens: 1400, softActiveTokens: 4000, hardActiveTokens: 10000 })
    const session = engine.ctx.sessions.create('forest-budget-fixture')
    const agent = { session, options: { provider: 'local', model: 'old' } }, levels = []
    for (let i = 0; i < 3; i++) {
      const raw = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(24000) + i }] }), { surfaceOp: 'append' })
      engine.startBackgroundFold(agent, { start: raw.seq, end: raw.seq, activeTokens: 8000, eligibleEnd: raw.seq })
      await engine.settleBackgroundFold(agent)
      const state = engine.backgroundFolds.get(agent)
      assert.ok(engine.ctx.tokenMeter.estimateMessage(state.summarized.checkpointMessage) <= 1400)
      const result = engine.tryCommitBackgroundFold(agent, { allowPressure: true }); assert.ok(result)
      await tick()
      levels.push(nodeLevel(engine.superLcmStore, session.id, markerFromSummary(result.summary).id))
    }
    assert.deepEqual(levels, [1, 1, 1], 'three siblings fit in one physical frame and stay on the first level')
    assert.equal(calls, 3, 'virtual member framing cannot trigger an unnecessary budget merge')
  })
})

test('native recall uses the explicitly shared store and does not own its lifetime', async () => {
  await host(async () => 'Compact synthetic navigation summary.', async ({ engine, session, agent, dir }) => {
    engine.startBackgroundFold(agent, engine.planRolling(agent)); await engine.settleBackgroundFold(agent)
    const result = engine.tryCommitBackgroundFold(agent, { allowPressure: true }); assert.ok(result); await tick()
    const definitions = [], effects = []
    nativeTools({ tools: { register: d => definitions.push(d) }, effect: fn => effects.push(fn) }, { store: engine.superLcmStore })
    const id = markerFromSummary(result.summary).id
    const response = await definitions.find(d => d.name === 'lcm_describe').execute({ node_id: id }, { agent })
    assert.ok(response)
    assert.equal(effects.length, 0, 'the archive owns closing the borrowed store')
    assert.equal(engine.superLcmStore.getNode(session.id, id).nodeId, id)
    assert.equal(existsSync(join(dir, 'default-archive')), false)
  })
})

test('legacy runtime updates abort pending summaries and reject ready drafts under old settings', async () => {
  let release; const gate = new Promise(r => { release = r })
  await host(async () => { await gate; return 'Compact synthetic navigation summary.' }, async ({ engine, session, agent }) => {
    const original = [...session.surface.nodes]
    engine.startBackgroundFold(agent, engine.planRolling(agent)); await tick()
    const state = engine.backgroundFolds.get(agent)
    engine.applyRuntimeConfig({ ...config, auto: false, summarizationProvider: 'local', summarizationModel: 'new', minRetainTokens: 50000 })
    assert.equal(state.controller.signal.aborted, true)
    release(); await engine.settleBackgroundFold(agent)
    assert.equal(engine.tryCommitBackgroundFold(agent, { allowPressure: true }), null)
    assert.deepEqual(session.surface.nodes, original)
  })
  await host(async () => 'Compact synthetic navigation summary.', async ({ engine, session, agent }) => {
    engine.startBackgroundFold(agent, engine.planRolling(agent)); await engine.settleBackgroundFold(agent)
    assert.equal(engine.backgroundFolds.get(agent).status, 'ready')
    engine.applyRuntimeConfig({ ...config, auto: false, summarizationProvider: 'local', summarizationModel: 'new' })
    assert.equal(engine.tryCommitBackgroundFold(agent, { allowPressure: true }), null)
    assert.equal(session.snapshotEvents().filter(e => e.type === 'compaction/start').length, 0)
  })
})

test('history tree reconstruction snapshots once per step instead of once per selected source', () => {
  const n = 10000, k = 1000, compactionId = 'synthetic-compaction', summary = appendRecallEnvelope([{ type: 'text', text: 'Synthetic history summary.' }], { id: 'synthetic-root', children: [] })
  const selected = Array.from({ length: k }, (_, i) => n - k + i)
  const events = Array.from({ length: n }, (_, seq) => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text: 'Synthetic source' }] } }))
  events.push({ seq: n, type: 'compaction/start', data: { compactionId } },
    { seq: n + 1, type: 'compaction/summary', data: { compactionId, summary, shadowedRange: { start: n - k, end: n - 1 }, shadowedSeqs: selected, preparedTree: [], summaryTreeKind: 'leaf' } },
    { seq: n + 2, type: 'user/message', data: { source: compactCheckpointSource(compactionId), content: summary }, surfaceOp: { op: 'replace', startSeq: n - k, endSeq: n - 1 }, sourceEventSeqs: [n, n + 1, ...selected] },
    { seq: n + 3, type: 'compaction/end', data: { compactionId } })
  const store = new SuperLcmStore(join(mkdtempSync(join(tmpdir(), 'superlcm-history-index-')), 'lcm.sqlite'))
  let snapshots = 0
  try {
    const result = reindexSession(store, { id: 'fixture', snapshotEvents() { snapshots++; return events } })
    assert.deepEqual(result.errors, []); assert.equal(result.indexed, 1)
    assert.ok(snapshots <= 4, `snapshot count ${snapshots} must not grow with ${k} source records`)
  } finally { store.close() }
})
