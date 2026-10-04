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
import { doctorSession, reindexSession } from '../dsh/core.js'
import { SuperLcmStore } from '../dsh/store.js'
import { appendRecallEnvelope, markerFromSummary } from '../dsh/marker.js'
import { apply as nativeTools } from '../dsh/tool.js'

const tick = () => new Promise(r => setImmediate(r))
const config = { minRetainTokens: 1000, foldBatchTokens: 2000, pressureFoldTokens: 1000, softActiveTokens: 26000, hardActiveTokens: 28000 }
async function host(response, run) {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-native-reliability-')), ctx = new Context(), prior = process.env.DSH_SUPERLCM_DB
  process.env.DSH_SUPERLCM_DB = join(dir, 'archive', 'lcm.sqlite')
  try {
    new SessionStore(ctx); new SessionProjections(ctx)
    ctx.reflect.provide('llm', { async *stream(options) { yield { type: 'text-delta', index: 0, text: await response(options) } }, imageRequestPricing() {}, fileRequestText() {} })
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
