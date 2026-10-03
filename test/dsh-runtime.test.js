// Optional host test: installed DSH services and compaction base, local model
// responses only. No API keys, network requests, or production session writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Engine from '../dsh/engine.js'
import { prepareAsyncRegion, summarizeAsyncRegion, commitAsyncRegion } from '../dsh/async-region.js'
import { markerFromSummary } from '../dsh/marker.js'
import { nodeLevel } from '../dsh/core.js'
import { ClaudeStore } from '../src/store.js'
import { captureDshPacket } from '../src/dsh.js'
import { projectEvent } from '../dsh/archive.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function withHost(config, response, run) {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-dsh-optimized-'))
  const prior = process.env.DSH_SUPERLCM_DB
  process.env.DSH_SUPERLCM_DB = join(dir, 'lcm.sqlite')
  const ctx = new Context(), calls = [], warnings = []
  ctx.logger.warn = message => warnings.push(message)
  try {
    new SessionStore(ctx); new SessionProjections(ctx)
    ctx.reflect.provide('llm', { async *stream(options) {
      calls.push({ provider: options.provider, model: options.model, signal: options.signal })
      const text = await response(options)
      yield { type: 'text-delta', index: 0, text }
    }, imageRequestPricing() {}, fileRequestText() {} })
    new TokenMeter(ctx)
    new Engine(ctx, { auto: false, summarizationProvider: 'local', summarizationModel: 'fixture', ...config })
    const session = ctx.sessions.create('optimized-native', { meta: { cwd: '/project' } })
    const agent = { session, options: { provider: 'local', model: 'fixture' } }
    await run({ ctx, engine: ctx.compaction, session, agent, calls, warnings, dir })
  } finally {
    await ctx.fiber.dispose()
    if (prior === undefined) delete process.env.DSH_SUPERLCM_DB; else process.env.DSH_SUPERLCM_DB = prior
  }
}
const append = (session, text) => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
const source = 'original engineering facts and exact numbers. '.repeat(5000)

test('real DSH condenses four leaf checkpoints and shared recall retains every original', async () => {
  let phase = 'leaf'
  await withHost({ tailCount: 2, minRetainTokens: 100, foldBatchTokens: 4000, pressureFoldTokens: 1000, summaryPrefixTargetTokens: 1500 },
    async () => phase === 'leaf' ? 'leaf summary with a source pointer. '.repeat(130) : '四个旧摘要已合并，原文仍可逐层查阅。',
    async ({ engine, session, agent, calls, dir }) => {
      const children = [], originalSeqs = []
      for (let i = 0; i < 4; i++) {
        const raw = append(session, source + i); originalSeqs.push(raw.seq)
        const prepared = prepareAsyncRegion(engine, agent, { start: raw.seq, end: raw.seq })
        const summary = await summarizeAsyncRegion(engine, agent, prepared, new AbortController().signal)
        commitAsyncRegion(engine, agent, summary); children.push(markerFromSummary(summary.summary).id)
        await tick()
      }
      append(session, '最近问题一'); append(session, '最近问题二')
      const selection = engine.planRolling(agent)
      assert.equal(selection.reason, 'summary-prefix'); assert.equal(selection.sourceCount, 4)
      phase = 'condensed'
      assert.equal(engine.startBackgroundFold(agent, selection), true)
      await engine.settleBackgroundFold(agent)
      const result = engine.tryCommitBackgroundFold(agent)
      assert.ok(result); await tick()
      assert.equal(calls.length, 5)
      const parentId = markerFromSummary(result.summary).id
      const parent = engine.superLcmStore.getNode(session.id, parentId)
      assert.deepEqual(parent.childIds, children); assert.equal(nodeLevel(engine.superLcmStore, session.id, parentId), 2)
      assert.equal(session.surface.nodes.length, 3)
      for (const seq of originalSeqs) assert.match(session.eventAt(seq).data.content[0].text, /original engineering facts/)
      const shared = new ClaudeStore(dir)
      try {
        const captured = captureDshPacket(shared, { header: session.header, records: session.snapshotEvents().map(event => projectEvent(session.id, event)) })
        const root = shared.outline(captured.session).nodes[0]
        assert.equal(root.level, 1); assert.equal(root.children.length, 4)
        for (const seq of originalSeqs) assert.equal(JSON.parse(shared.exact(captured.session, seq)).event.data.content[0].text, session.eventAt(seq).data.content[0].text)
      } finally { shared.close() }
    })
})

test('real DSH starts one background call for two agents sharing a session', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  await withHost({ tailCount: 1, minRetainTokens: 0, foldBatchTokens: 1000 }, async () => { await gate; return 'compact summary' },
    async ({ engine, session, agent, calls }) => {
      append(session, source); append(session, 'fresh tail')
      const other = { ...agent }, selection = engine.planRolling(agent)
      assert.equal(engine.startBackgroundFold(agent, selection), true)
      assert.equal(engine.startBackgroundFold(other, selection), false)
      await tick(); assert.equal(calls.length, 1)
      release(); await engine.settleBackgroundFold(other)
      assert.ok(engine.tryCommitBackgroundFold(other, { force: true }))
    })
})

test('real DSH skips the banned primary route on the next call and keeps explicit fallback', async () => {
  await withHost({ summarizationProvider: 'banned', fallbackSummarizationProvider: 'working', fallbackSummarizationModel: 'fixture' },
    async options => { if (options.provider === 'banned') throw Object.assign(Error('account banned'), { status: 403 }); return 'successful fallback summary' },
    async ({ engine, session, agent, calls }) => {
      append(session, source)
      const input = { messages: [createUserMessage({ content: [{ type: 'text', text: 'summarize' }] })] }
      await engine.summarize(input, agent, new AbortController().signal)
      await engine.summarize(input, agent, new AbortController().signal)
      assert.deepEqual(calls.map(call => call.provider), ['banned', 'working', 'working'])
      assert.equal(engine.backgroundRouteConfigured(), true)
    })
})

test('a rewritten selected span never publishes its prepared summary', async () => {
  await withHost({ tailCount: 1, minRetainTokens: 0, foldBatchTokens: 1000 }, async () => 'prepared summary',
    async ({ engine, session, agent }) => {
      const raw = append(session, source); append(session, 'fresh tail')
      engine.startBackgroundFold(agent, engine.planRolling(agent))
      await engine.settleBackgroundFold(agent)
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'revised selected context' }] }), { surfaceOp: { op: 'replace', startSeq: raw.seq, endSeq: raw.seq }, sourceEventSeqs: [raw.seq] })
      assert.equal(engine.tryCommitBackgroundFold(agent, { force: true }), null)
      assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/start').length, 0)
      assert.equal(session.eventAt(raw.seq).data.content[0].text, source)
    })
})

test('a summary that saves no space remains unpublished and does not buy another call next step', async () => {
  const text = 'source details. '.repeat(1000)
  await withHost({ tailCount: 1, minRetainTokens: 0, foldBatchTokens: 1000 }, async () => text.repeat(2),
    async ({ engine, session, agent, calls }) => {
      append(session, text); append(session, 'fresh tail')
      const selection = engine.planRolling(agent)
      engine.startBackgroundFold(agent, selection); await engine.settleBackgroundFold(agent)
      assert.equal(engine.startBackgroundFold(agent, selection), false)
      assert.equal(calls.length, 1)
      assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/start').length, 0)
    })
})

test('timeout requests cancellation, retains the exclusive slot until the provider settles, and avoids immediate retry', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  await withHost({ tailCount: 1, minRetainTokens: 0, foldBatchTokens: 1000, summaryTimeoutMs: 20 }, async () => { await gate; return 'late response' },
    async ({ engine, session, agent, calls }) => {
      append(session, source); append(session, 'fresh tail')
      const selection = engine.planRolling(agent), other = { ...agent }
      assert.equal(engine.startBackgroundFold(agent, selection), true)
      await new Promise(resolve => setTimeout(resolve, 40))
      assert.equal(calls[0].signal.aborted, true)
      assert.equal(engine.backgroundFolds.has(other), true)
      assert.equal(engine.startBackgroundFold(other, selection), false)
      release(); await engine.settleBackgroundFold(agent)
      assert.equal(engine.backgroundFolds.has(agent), false)
      assert.equal(engine.startBackgroundFold(other, selection), false)
      assert.equal(calls.length, 1)
      assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/start').length, 0)
    })
})
