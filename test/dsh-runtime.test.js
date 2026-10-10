// Optional host test: installed DSH services and compaction base, local model
// responses only. No API keys, network requests, or production session writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Engine from '../dsh/engine.js'
import { prepareAsyncRegion, summarizeAsyncRegion, commitAsyncRegion } from '../dsh/async-region.js'
import { markerFromSummary, encodeMarker, appendRecallEnvelope } from '../dsh/marker.js'
import { nodeLevel, reindexSession, nodeFromCompactionEvent, doctorSession } from '../dsh/core.js'
import { SuperLcmStore } from '../dsh/store.js'
import { draftTokens } from '../dsh/draft-tree.js'
import { semanticFrontier } from '../dsh/tree-semantics.js'
import { ClaudeStore } from '../src/store.js'
import { captureDshPacket } from '../src/dsh.js'
import { projectEvent } from '../dsh/archive.js'
import { compressionSnapshot } from '../src/compression-status.js'
import Llm from '@deepseek-ai/dsh-llm'
import * as PiAdapter from '@deepseek-ai/dsh-llm-pi-ai'
import Authorization from '@deepseek-ai/dsh-authorization'
import { summaryContext } from '../dsh/summary-model.js'
import { readControls,controlsConfig } from '../dsh/controls-config.js'
import { summarySessionId } from '../dsh/summary-session.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function withHost(config, response, run) {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-dsh-optimized-'))
  const prior = process.env.DSH_SUPERLCM_DB
  process.env.DSH_SUPERLCM_DB = join(dir, 'lcm.sqlite')
  const ctx = new Context(), calls = [], warnings = []
  ctx.logger.warn = message => warnings.push(message)
  try {
    new SessionStore(ctx); new SessionProjections(ctx)
    const localStream=async function* (options) {
      calls.push({ provider: options.provider, model: options.model, signal: options.signal, sessionId: options.sessionId,
        inputTokens:Math.ceil(JSON.stringify(options.messages).length/4) })
      const text = await response(options)
      yield { type: 'text-delta', index: 0, text:'# '+text }
    }
    ctx.reflect.provide('llm', {
      stream:options=>ctx.waterfall('llm/stream',options,()=>localStream(options)),
      prepareCall:async config=>({config,context:{contextWindow:config.model==='million'?1000000:100000},stream:options=>ctx.llm.stream(options)}),
      resolveModelInfo:async (_provider,model)=>({context:{contextWindow:model==='million'?1000000:100000},defaultMaxTokens:0}), imageRequestPricing() {}, fileRequestText() {} })
    new TokenMeter(ctx)
    new Engine(ctx, { budgetMode:'tokens', auto: false, summarizationProvider: 'local', summarizationModel: 'fixture', ...config })
    const session = ctx.sessions.create('optimized-native', { meta: { cwd: '/project' } })
    const agent = { session, options: { provider: 'local', model: 'fixture' } }
    await tick()
    await run({ ctx, engine: ctx.compaction, session, agent, calls, warnings, dir })
  } finally {
    await ctx.fiber.dispose()
    if (prior === undefined) delete process.env.DSH_SUPERLCM_DB; else process.env.DSH_SUPERLCM_DB = prior
  }
}
const append = (session, text) => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
const source = 'original engineering facts and exact numbers. '.repeat(5000)

test('successive checkpoints retain a same-level forest and only four siblings truly升层', async () => {
  let serial = 0
  await withHost({ minRetainTokens: 1000, foldBatchTokens: 64000, pressureFoldTokens: 1000,
    summaryPrefixTargetTokens: 64000, softActiveTokens: 4000, hardActiveTokens: 10000 },
  async () => 'Distinct summarized facts and exact references ' + (++serial),
  async ({ engine, session, agent, dir }) => {
    const levels = [], sizes = [], original = [], replacements = []
    for (let i = 0; i < 6; i++) {
      const raw = append(session, source.slice(0, 24000) + i); original.push(raw.seq)
      const live = [...session.surface.nodes]
      engine.startBackgroundFold(agent, { start: raw.seq, end: raw.seq, activeTokens: 8000, eligibleEnd: raw.seq })
      await engine.settleBackgroundFold(agent)
      assert.deepEqual(session.surface.nodes, live, 'preparation never changes the live prefix')
      const result = engine.tryCommitBackgroundFold(agent, { allowPressure: true }); assert.ok(result)
      await tick()
      assert.equal(new Set(result.shadowedSeqs).size, result.shadowedSeqs.length, 'physical checkpoints occur once')
      const root = markerFromSummary(result.summary).id
      levels.push(nodeLevel(engine.superLcmStore, session.id, root))
      sizes.push(semanticFrontier(engine.superLcmStore, session.id, root).length)
      replacements.push(session.snapshotEvents().filter(e => e.surfaceOp?.op === 'replace').length)
    }
    assert.deepEqual(levels, [1, 1, 1, 2, 2, 2])
    assert.deepEqual(sizes, [1, 2, 3, 1, 2, 3])
    assert.deepEqual(replacements, [1, 2, 3, 4, 5, 6])
    assert.equal(serial, 7, 'six first-level summaries plus one genuine four-way merge')
    const root = markerFromSummary(session.eventAt(session.surface.nodes[0]).data.content).id
    const rebuilt = new SuperLcmStore(join(dir, 'forest-rebuilt.sqlite'))
    try {
      assert.deepEqual(reindexSession(rebuilt, session).errors, [])
      assert.equal(nodeLevel(rebuilt, session.id, root), 2)
      assert.deepEqual(semanticFrontier(rebuilt, session.id, root), semanticFrontier(engine.superLcmStore, session.id, root))
      for (const seq of original) assert.match(session.eventAt(seq).data.content[0].text, /original engineering facts/)
    } finally { rebuilt.close() }
  })
})

test('background model calls use a stable private identity and never rename the main conversation', async () => {
  await withHost({}, async () => 'summary', async ({ engine, session, agent, calls }) => {
    const id = session.id
    const raw = append(session, source)
    const prepared = prepareAsyncRegion(engine, agent, { start: raw.seq, end: raw.seq })
    await summarizeAsyncRegion(engine, agent, prepared, new AbortController().signal)
    await summarizeAsyncRegion(engine, agent, prepared, new AbortController().signal)
    assert.equal(session.id, id)
    assert.equal(calls[0].sessionId, calls[1].sessionId)
    assert.equal(calls[0].sessionId, summarySessionId(id, { provider: 'local', model: 'fixture' }))
    assert.notEqual(calls[0].sessionId, id)
    assert.notEqual(calls[0].sessionId, summarySessionId(id, { provider: 'local', model: 'other-model' }))
    assert.equal(session.surface.nodes.length, 1)
  })
})

test('pressure freezes a finite cycle even while new complete tool groups keep arriving', async () => {
  let release, count = 0
  const gate = new Promise(resolve => { release = resolve })
  await withHost({ minRetainTokens: 1000, foldBatchTokens: 6000, pressureFoldTokens: 1000,
    softActiveTokens: 26000, hardActiveTokens: 28000 }, async () => {
    if (++count === 1) await gate
    return 'A complete compact navigation summary.'
  }, async ({ engine, session, agent }) => {
    for (let i = 0; i < 7; i++) append(session, source.slice(0, 16000) + i)
    const live = [...session.surface.nodes], selection = engine.planRolling(agent)
    engine.startBackgroundFold(agent, selection)
    assert.equal(engine.tryCommitBackgroundFold(agent, { allowPressure: true }), null)
    const frozen = engine.backgroundFolds.get(agent).cutoffEnd
    const fresh = []
    for (let i = 0; i < 10; i++) fresh.push(append(session, source.slice(0, 16000) + 'after cutoff ' + i).seq)
    release(); await engine.settleBackgroundFold(agent)
    const state = engine.backgroundFolds.get(agent)
    assert.equal(state.summarized.end, frozen)
    assert.equal(engine.planRolling(agent), null, 'new arrivals cannot extend this cycle')
    assert.deepEqual(session.surface.nodes, [...live, ...fresh])
    assert.ok(engine.tryCommitBackgroundFold(agent, { allowPressure: true }))
    assert.ok(fresh.every(seq => session.surface.nodes.includes(seq)))
    assert.equal(session.snapshotEvents().filter(e => e.type === 'compaction/start').length, 1)
  })
})

test('a frozen cycle summarizes its final span below the normal batch minimum', async () => {
  await withHost({ minRetainTokens: 1000, foldBatchTokens: 6000, pressureFoldTokens: 3000,
    softActiveTokens: 7000, hardActiveTokens: 20000 }, async () => 'Complete compact navigation summary.',
  async ({ engine, session, agent }) => {
    for (let i = 0; i < 8; i++) append(session, 'x'.repeat(4000) + i)
    const original = [...session.surface.nodes]
    engine.startBackgroundFold(agent, engine.planRolling(agent))
    await engine.settleBackgroundFold(agent)
    const draft = engine.backgroundFolds.get(agent)
    assert.equal(draft.parts.length, 2, 'the small final span also receives a summary')
    assert.equal(draft.summarized.end, draft.cutoffEnd)
    assert.deepEqual(session.surface.nodes, original, 'preparation never replaces live context')
    const result = engine.tryCommitBackgroundFold(agent, { allowPressure: true })
    assert.ok(result)
    assert.equal(result.shadowedRange.end, draft.cutoffEnd)
    assert.ok(!session.surface.nodes.includes(draft.cutoffEnd))
    assert.equal(session.snapshotEvents().filter(e => e.type === 'compaction/start').length, 1)
  })
})

test('a tail smaller than an empty checkpoint stays verbatim without blocking the completed draft', async () => {
  await withHost({ minRetainTokens: 1000, foldBatchTokens: 6000, pressureFoldTokens: 3000,
    softActiveTokens: 7000, hardActiveTokens: 20000 }, async () => 'Complete compact navigation summary.',
  async ({ engine, session, agent, calls }) => {
    for (let i = 0; i < 6; i++) append(session, 'x'.repeat(4000) + i)
    const tiny = append(session, 'ok').seq
    const recent = append(session, 'y'.repeat(4000)).seq
    engine.startBackgroundFold(agent, engine.planRolling(agent))
    await engine.settleBackgroundFold(agent)
    assert.equal(calls.length, 1, 'no model call can shrink the tiny tail into a checkpoint')
    const draft = engine.backgroundFolds.get(agent)
    assert.equal(draft.cutoffEnd, draft.summarized.end, 'the committed boundary explicitly excludes retained tokens')
    assert.ok(engine.tryCommitBackgroundFold(agent, { allowPressure: true }))
    assert.ok(session.surface.nodes.includes(tiny))
    assert.ok(session.surface.nodes.includes(recent))
    assert.equal(session.snapshotEvents().filter(e => e.type === 'compaction/start').length, 1)
  })
})

test('prepared leaves form a recall tree before one switch; replay reconstructs all levels and originals', async () => {
  await withHost({ minRetainTokens: 1000, foldBatchTokens: 2000, pressureFoldTokens: 1000,
    softActiveTokens: 26000, hardActiveTokens: 28000 }, async () => 'Compact facts and exact recall.',
  async ({ engine, session, agent, dir }) => {
    const originals = []
    for (let i = 0; i < 7; i++) originals.push(append(session, source.slice(0, 16000) + i).seq)
    engine.startBackgroundFold(agent, engine.planRolling(agent)); await engine.settleBackgroundFold(agent)
    const draft = engine.backgroundFolds.get(agent)
    assert.ok(draft.tree.length > draft.parts.length, 'four leaves were summarized into a higher level')
    assert.equal(engine.superLcmStore.listNodes(session.id).length, 0, 'drafts are not advertised as committed recall')
    const result = engine.tryCommitBackgroundFold(agent, { allowPressure: true }); assert.ok(result)
    await tick()
    const root = markerFromSummary(result.summary).id
    assert.equal(nodeLevel(engine.superLcmStore, session.id, root), 2, 'four leaves merge once; the envelope adds no level')
    assert.equal(session.eventAt(result.summarySeq).data.summaryTreeDepth, nodeLevel(engine.superLcmStore, session.id, root))
    assert.equal(engine.superLcmStore.stats(session.id).missingChildren.length, 0)
    const rebuilt = new SuperLcmStore(join(dir, 'rebuilt.sqlite'))
    try {
      const indexed = reindexSession(rebuilt, session)
      assert.deepEqual(indexed.errors, [])
      assert.equal(nodeLevel(rebuilt, session.id, root), nodeLevel(engine.superLcmStore, session.id, root))
      assert.equal(rebuilt.listNodes(session.id).length, engine.superLcmStore.listNodes(session.id).length)
    } finally { rebuilt.close() }
    const shared = new ClaudeStore(dir)
    try {
      const captured = captureDshPacket(shared, { header: session.header, records: session.snapshotEvents().map(event => projectEvent(session.id, event)) })
      assert.ok(shared.outline(captured.session).nodes[0].level >= 1)
      for (const seq of originals) assert.equal(JSON.parse(shared.exact(captured.session, seq)).event.data.content[0].text, session.eventAt(seq).data.content[0].text)
    } finally { shared.close() }
  })
})

test('one oversized old root and new leaves share the total budget without waiting for equal-depth fanout', async () => {
  let phase = 'old'
  await withHost({ minRetainTokens: 1000, foldBatchTokens: 2000, pressureFoldTokens: 1000,
    summaryPrefixTargetTokens: 1500, softActiveTokens: 26000, hardActiveTokens: 28000 },
  async () => phase === 'old' ? 'Old decisions and preserved identifiers. '.repeat(400) : 'Essential active facts with recall pointers.',
  async ({ engine, session, agent }) => {
    const original = append(session, source)
    const summary = await summarizeAsyncRegion(engine, agent, prepareAsyncRegion(engine, agent, { start: original.seq, end: original.seq }), new AbortController().signal)
    commitAsyncRegion(engine, agent, summary); await tick(); phase = 'new'
    const oldCheckpoint = session.surface.nodes[0]
    for (let i = 0; i < 7; i++) append(session, source.slice(0, 16000) + i)
    engine.startBackgroundFold(agent, engine.planRolling(agent)); await engine.settleBackgroundFold(agent)
    const state = engine.backgroundFolds.get(agent)
    assert.ok(draftTokens(engine, agent, state.frontier) <= 1500)
    assert.equal(state.summarized.start, oldCheckpoint)
    assert.ok(engine.tryCommitBackgroundFold(agent, { allowPressure: true }))
    assert.equal(session.surface.nodes.length, 2)
    assert.equal(session.eventAt(original.seq).data.content[0].text, source)
  })
})

test('a tiny old-prefix suffix remains included when the selected condensation covers only four roots', async () => {
  let mode = 'old', oldCalls = 0
  await withHost({ minRetainTokens: 20000, foldBatchTokens: 4000, pressureFoldTokens: 1000,
    summaryPrefixTargetTokens: 1500, softActiveTokens: 20000, hardActiveTokens: 40000 },
  async () => mode === 'old' ? 'facts '.repeat(++oldCalls === 5 ? 250 : 700) : 'merged '.repeat(480),
  async ({ engine, session, agent }) => {
    for (let i = 0; i < 5; i++) {
      const raw = append(session, source)
      const summary = await summarizeAsyncRegion(engine, agent, prepareAsyncRegion(engine, agent, { start: raw.seq, end: raw.seq }), new AbortController().signal)
      commitAsyncRegion(engine, agent, summary); await tick()
    }
    const suffix = session.surface.nodes.at(-1); mode = 'merge'
    append(session, 'latest '.repeat(11000))
    const selection = engine.planRolling(agent); assert.equal(selection.sourceCount, 4)
    engine.startBackgroundFold(agent, selection); await engine.settleBackgroundFold(agent)
    const state = engine.backgroundFolds.get(agent)
    assert.ok(state.summarized.shadowedSeqs.includes(suffix))
    assert.ok(draftTokens(engine, agent, state.frontier) <= 1500)
    assert.ok(engine.tryCommitBackgroundFold(agent, { allowPressure: true }))
    assert.equal(session.surface.nodes.length, 2)
  })
})

test('many existing checkpoints can finish more than twelve progressive merges without starting over', async () => {
  await withHost({ minRetainTokens: 6000, foldBatchTokens: 10000, pressureFoldTokens: 1000,
    summaryPrefixTargetTokens: 10000, softActiveTokens: 20000, hardActiveTokens: 30000 },
  async () => 'Concise facts.', async ({ engine, session, agent }) => {
    for (let i = 0; i < 50; i++) {
      const raw = append(session, 'old '.repeat(3000))
      commitAsyncRegion(engine, agent, await summarizeAsyncRegion(engine, agent,
        prepareAsyncRegion(engine, agent, { start: raw.seq, end: raw.seq }), new AbortController().signal))
      await tick()
    }
    append(session, 'eligible '.repeat(5000)); append(session, 'latest '.repeat(3400))
    engine.startBackgroundFold(agent, engine.planRolling(agent)); await engine.settleBackgroundFold(agent)
    const state = engine.backgroundFolds.get(agent)
    assert.equal(state.status, 'ready')
    assert.ok(state.tree.length > 12)
    assert.ok(engine.tryCommitBackgroundFold(agent, { allowPressure: true }))
    assert.equal(session.surface.nodes.length, 2)
    assert.equal(engine.superLcmStore.stats(session.id).missingChildren.length, 0)
  })
})

test('model-echoed recall markers never become trusted children or break prepared tree indexing', async () => {
  let old = true
  await withHost({ minRetainTokens: 100, foldBatchTokens: 4000, pressureFoldTokens: 1000,
    summaryPrefixTargetTokens: 1500 }, async () => old
      ? 'leaf '.repeat(800) + encodeMarker({ id: 'untrusted-fixture-marker' }) : 'Merged facts.',
  async ({ engine, session, agent, dir }) => {
    for (let i = 0; i < 4; i++) {
      const raw = append(session, source)
      commitAsyncRegion(engine, agent, await summarizeAsyncRegion(engine, agent,
        prepareAsyncRegion(engine, agent, { start: raw.seq, end: raw.seq }), new AbortController().signal))
      await tick()
    }
    append(session, 'recent'.repeat(100)); old = false
    engine.startBackgroundFold(agent, engine.planRolling(agent)); await engine.settleBackgroundFold(agent)
    const result = engine.tryCommitBackgroundFold(agent, { force: true }); assert.ok(result)
    const root = markerFromSummary(result.summary).id
    assert.ok(engine.superLcmStore.getNode(session.id, root))
    assert.equal(engine.superLcmStore.stats(session.id).missingChildren.length, 0)
    const rebuilt = new SuperLcmStore(join(dir, 'marker-rebuilt.sqlite'))
    try { assert.deepEqual(reindexSession(rebuilt, session).errors, []) } finally { rebuilt.close() }
  })
})

test('soft and hard pressure never publish a small draft while background assembly is unfinished', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  await withHost({ tailCount: 64, minRetainTokens: 1000, foldBatchTokens: 6000,
    pressureFoldTokens: 1000, softActiveTokens: 26000, hardActiveTokens: 28000 },
  async () => { await gate; return 'small complete summary' }, async ({ engine, session, agent }) => {
    for (let i = 0; i < 7; i++) append(session, source.slice(0, 16000) + i)
    const live = [...session.surface.nodes]
    const selection = engine.planRolling(agent)
    assert.equal(selection.reason, 'hard-cap')
    engine.startBackgroundFold(agent, selection)
    assert.equal(engine.tryCommitBackgroundFold(agent, { allowPressure: true }), null)
    assert.equal(engine.tryCommitBackgroundFold(agent, { force: true }), null)
    assert.deepEqual(session.surface.nodes, live)
    release(); await engine.settleBackgroundFold(agent)
    const state = engine.backgroundFolds.get(agent)
    assert.ok(state.parts.length > 1)
    assert.deepEqual(session.surface.nodes, live)
    assert.ok(engine.tryCommitBackgroundFold(agent, { allowPressure: true }))
    const starts = Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq))
      .filter(event => event.type === 'compaction/start')
    assert.equal(starts.length, 1)
  })
})

test('background drafts accumulate across turns and replace once at the threshold', async () => {
  await withHost({ tailCount: 64, minRetainTokens: 1000, foldBatchTokens: 2000,
    pressureFoldTokens: 1000, softActiveTokens: 26000, hardActiveTokens: 32000 },
  async () => 'Facts preserved in this batch.', async ({ engine, session, agent, calls }) => {
    const originals = []
    for (let i = 0; i < 6; i++) originals.push(append(session, source.slice(0, 16000) + i).seq)
    const initialSurface = [...session.surface.nodes]
    const chosen = engine.planRolling(agent)
    assert.ok(chosen, 'long messages must not be held back by the 64-node setting')
    engine.startBackgroundFold(agent, chosen)
    await engine.settleBackgroundFold(agent)
    assert.ok(calls.length > 1, 'several disjoint batches are prepared')
    assert.deepEqual(session.surface.nodes, initialSurface, 'preparation preserves the live request')
    assert.equal(engine.tryCommitBackgroundFold(agent, { allowPressure: true }), null)
    const events = () => Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq))
    assert.equal(events().some(e => e.type === 'compaction/start'), false)
    const purchased = calls.length
    originals.push(append(session, source.slice(0, 16000) + 'new turn').seq)
    const next = engine.planRolling(agent)
    assert.ok(next)
    assert.ok(next.start > chosen.end)
    engine.startBackgroundFold(agent, next)
    await engine.settleBackgroundFold(agent)
    assert.ok(calls.length > purchased)
    const staged = engine.backgroundFolds.get(agent)
    assert.equal(new Set(staged.summarized.shadowedSeqs).size, staged.summarized.shadowedSeqs.length)
    assert.ok(engine.ctx.tokenMeter.measure(session).totalTokens >= 26000)
    const result = engine.tryCommitBackgroundFold(agent, { allowPressure: true })
    assert.ok(result)
    await tick()
    assert.equal(events().filter(e => e.type === 'compaction/start').length, 1)
    assert.equal(session.surface.nodes.length, 2, 'one assembled checkpoint plus the recent raw message')
    assert.equal(result.shadowedSeqs.length, originals.length - 1)
    const node = engine.superLcmStore.getNode(session.id, markerFromSummary(result.summary).id)
    assert.deepEqual(node.sourceSeqs, originals.slice(0, -1))
    for (const seq of originals) assert.equal(session.eventAt(seq).type, 'user/message')
  })
})

test('console document hot-applies model, switch and retention and cancels old pending compaction',async()=>{
  const file=join(mkdtempSync(join(tmpdir(),'superlcm-controls-runtime-')),'controls.json')
  const spec=id=>({plugin:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{[id]:{api:'openai-responses',baseURL:'http://127.0.0.1:9/v1',models:[{id:'cheap-model',contextWindow:128000}]}}}})
  const config=controlsConfig({auto:true,summaryAdapter:spec('first-provider'),summarizationProvider:'first-provider',summarizationModel:'cheap-model',tailCount:2,minRetainTokens:100,softActiveTokens:3000,hardActiveTokens:4000,foldBatchTokens:2000,pressureFoldTokens:100})
  const publish=(revision,next)=>writeFileSync(file,JSON.stringify({format:1,revision,config:next}))
  publish('initial',config)
  await withHost({controlFile:file},async()=>{throw Error('Chat model must not compact')},async({engine,ctx,session,agent,calls,dir})=>{
    await engine.summaryModelReady
    const dashboard=new ClaudeStore(dir)
    try {
      assert.equal(engine.rollingConfig.minRetainTokens,100)
      assert.equal(compressionSnapshot(dashboard).runtimes[0].settings_revision,'initial')
      let finish;const pending=new Promise(resolve=>{finish=resolve})
      engine.summaryContext.llm.stream=async function*(){await pending;yield{type:'text-delta',index:0,text:'迟到的旧摘要'}}
      const event=append(session,source),before=[...session.surface.nodes]
      assert.equal(engine.startBackgroundFold(agent,{start:event.seq,end:event.seq,reason:'pressure'}),true)
      await tick();publish('disabled',{...config,auto:false});await engine.reloadControls()
      assert.equal(engine.config.auto,false);assert.equal(engine.canPrepareBackground(agent),false)
      assert.equal(engine.backgroundFolds.get(agent).controller.signal.aborted,true)
      finish();await engine.settleBackgroundFold(agent)
      assert.deepEqual(session.surface.nodes,before)
      publish('new-model',{...config,summaryAdapter:spec('second-provider'),summarizationProvider:'second-provider',minRetainTokens:200,softActiveTokens:5000,hardActiveTokens:7000})
      await engine.reloadControls()
      assert.equal(engine.config.auto,true);assert.equal(engine.config.summarizationProvider,'second-provider');assert.equal(engine.rollingConfig.minRetainTokens,200);assert.equal(engine.rollingConfig.softActiveTokens,5000)
      assert.equal(compressionSnapshot(dashboard).runtimes[0].settings_revision,'new-model')
      const selected=[];engine.summaryContext.llm.stream=async function*(o){selected.push(o.provider);yield{type:'text-delta',index:0,text:'# Current state: the new summary retains original source references.'}}
      const prepared=prepareAsyncRegion(engine,agent,{start:event.seq,end:event.seq});const summary=await summarizeAsyncRegion(engine,agent,prepared,new AbortController().signal)
      assert.deepEqual(selected,['second-provider']);assert.equal(calls.length,0);assert.ok(commitAsyncRegion(engine,agent,summary))
      publish('bad',{...config,hardActiveTokens:2000});await engine.reloadControls()
      assert.equal(engine.controlRevision,'new-model');assert.equal(engine.config.summarizationProvider,'second-provider')
      assert.throws(()=>readControls(file),/强制压缩/)
    } finally {dashboard.close()}
  })
})

test('native summary adapters reuse credentials without duplicating settings or sign-in flows',async()=>{
  const ctx=new Context()
  try {
    const credentials={async resolve(){return {value:'fixture-key'}}};ctx.reflect.provide('credentials',credentials)
    const account={async resolveToken(){return 'fixture-token'}};ctx.reflect.provide('deepseekAccount',account)
    new Llm(ctx);new Authorization(ctx)
    const parent=ctx.plugin(PiAdapter,{providers:{}});await parent.await()
    const mainProviders=ctx.llm.listConfigurableProviders()
    const flows=ctx.authorization.list();assert.ok(flows.length>0)
    const summary=summaryContext(ctx,{plugin:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{}}});await summary.ready
    assert.equal((await summary.ctx.get('credentials').resolve('fixture')).value,'fixture-key')
    assert.equal(summary.ctx.get('authorization'),undefined);assert.equal(summary.ctx.get('settings'),undefined)
    assert.deepEqual(ctx.authorization.list(),flows);assert.deepEqual(ctx.llm.listConfigurableProviders(),mainProviders)
    const signedIn=summaryContext(ctx,{plugin:'@deepseek-ai/dsh-llm-deepseek-account',config:{}});await signedIn.ready
    assert.equal(await signedIn.ctx.get('deepseekAccount').resolveToken(),'fixture-token')
    assert.ok((await signedIn.ctx.llm.listModels('deepseek-account')).length>0)
  } finally {await ctx.fiber.dispose()}
})

test('global compaction uses the selected native model scope without changing the conversation registry',async()=>{
  const spec={plugin:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{'selected-provider':{api:'openai-responses',baseURL:'http://127.0.0.1:9/v1',models:[{id:'cheap-model',contextWindow:128000}]}}}}
  await withHost({summaryAdapter:spec,summarizationProvider:'selected-provider',summarizationModel:'cheap-model'},async()=>{throw Error('Main conversation model must not summarize')},async({engine,ctx,session,agent,calls})=>{
    await engine.summaryModelReady
    const selected=[]
    engine.summaryContext.llm.stream=async function*(options){selected.push([options.provider,options.model]);yield{type:'text-delta',index:0,text:'# Current state: original engineering facts are summarized with exact source references.'}}
    const event=append(session,source)
    const prepared=prepareAsyncRegion(engine,agent,{start:event.seq,end:event.seq})
    const summary=await summarizeAsyncRegion(engine,agent,prepared,new AbortController().signal)
    assert.deepEqual(selected,[['selected-provider','cheap-model']]);assert.equal(calls.length,0)
    assert.notEqual(ctx.llm,engine.summaryContext.llm);assert.ok(commitAsyncRegion(engine,agent,summary))
  })
})

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
      const status = new ClaudeStore(dir)
      assert.equal(compressionSnapshot(status).jobs[0].phase, 'summarizing')
      await engine.settleBackgroundFold(agent)
      assert.equal(compressionSnapshot(status).jobs[0].phase, 'ready')
      const result = engine.tryCommitBackgroundFold(agent, { force: true })
      assert.equal(compressionSnapshot(status).jobs[0].phase, 'committed'); status.close()
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
      const raw=append(session, source)
      const input = { messages: [session.deriveEventMessage(raw)] }
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

const legacyHeader = { id: 'legacy-native-test', createdAt: 100 }
const legacyArchiveFixture = () => new ClaudeStore(mkdtempSync(join(tmpdir(), 'superlcm-legacy-proof-')))
const legacyRecord = seq => ({ event: { seq, type: 'user/message', data: { content: [{ type: 'text', text: 'Synthetic decision ' + seq }] }, surfaceOp: 'append' } })
const legacyArchivePacket = records => ({ header: legacyHeader, records })
function legacyHistory() {
  const summary = [{ type: 'text', text: 'An old host summary.' }]
  const next = appendRecallEnvelope([{ type: 'text', text: 'A later summary retaining the old checkpoint.' }], { id: 'after-legacy', children: [] })
  const framed = body => [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>' }, ...body, { type: 'text', text: '</compacted-summary>' }]
  return [legacyRecord(0).event, { seq: 1, type: 'compaction/start', data: { compactionId: 'old-host' } },
    { seq: 2, type: 'compaction/summary', data: { compactionId: 'old-host', summary, shadowedSeqs: [0], shadowedRange: { start: 0, end: 0 } } },
    { seq: 3, type: 'user/message', data: { source: { kind: 'compact-checkpoint', compactionId: 'old-host' }, content: framed(summary) }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [1, 2, 0] },
    { seq: 4, type: 'compaction/end', data: { compactionId: 'old-host' } }, legacyRecord(5).event,
    { seq: 6, type: 'compaction/start', data: { compactionId: 'new-host' } },
    { seq: 7, type: 'compaction/summary', data: { compactionId: 'new-host', summary: next, shadowedSeqs: [3, 5], shadowedRange: { start: 3, end: 5 } } },
    { seq: 8, type: 'user/message', data: { source: { kind: 'compact-checkpoint', compactionId: 'new-host' }, content: framed(next) }, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 5 }, sourceEventSeqs: [6, 7, 3, 5] },
    { seq: 9, type: 'compaction/end', data: { compactionId: 'new-host' } }]
}

test('legacy committed summaries repair an advanced cursor and existing child references without duplicating migrated nodes', () => {
  for (const migrated of [false, true]) {
    const store = legacyArchiveFixture(), native = new SuperLcmStore(join(store.dir, 'lcm.sqlite'))
    try {
      const events = legacyHistory(), session = { id: legacyHeader.id, snapshotEvents: () => events }
      if (migrated) native.upsertNode({ sessionId: legacyHeader.id, nodeId: 'prior-migration', compactionId: 'old-host', summarySeq: 2, summary: events[2].data.summary, summaryText: 'An old host summary.', sourceSeqs: [0], childIds: [], status: 'ready' })
      native.upsertNode({ sessionId: legacyHeader.id, nodeId: 'after-legacy', compactionId: 'new-host', summarySeq: 7, summary: events[7].data.summary, summaryText: 'A later summary retaining the old checkpoint.', sourceSeqs: [3, 5], childIds: [], status: 'ready' })
      native.setIndexCursor(legacyHeader.id, 9)
      const before = native.getNode(legacyHeader.id, 'after-legacy').summary
      const result = reindexSession(native, session)
      assert.deepEqual(result.errors, []); assert.equal(native.listNodeIds(legacyHeader.id).length, 2)
      const older = native.listNodes(legacyHeader.id).find(node => node.summarySeq === 2)
      if (migrated) assert.equal(older.nodeId, 'prior-migration')
      assert.deepEqual(native.getNode(legacyHeader.id, 'after-legacy').childIds, [older.nodeId])
      assert.deepEqual(native.getNode(legacyHeader.id, 'after-legacy').summary, before)
      assert.equal(reindexSession(native, session).indexed, 0)
      assert.equal(doctorSession(native, session).ok, true)
      const captured = captureDshPacket(store, legacyArchivePacket(events.map(event => ({ dsh_session: legacyHeader.id, role: event.type === 'user/message' ? 'user' : 'assistant', content: '', event }))))
      assert.equal(store.stats(captured.session).unsummarized_records, 0)
      assert.deepEqual(store.roots(captured.session)[0].source_records, [0, 5])
    } finally { native.close(); store.close() }
  }
})

test('markerless history refuses missing commits, changed bodies and incomplete source witnesses', () => {
  const mutations = [events => events.splice(4, 1), events => { events[4].data.error = 'failed' },
    events => { events[3].data.content[1].text = 'Different body' }, events => { events[3].sourceEventSeqs = [1, 2] },
    events => { events[3].data.source.compactionId = 'wrong-id' }, events => { events[3].surfaceOp.endSeq = 5 },
    events => { events[2].data.shadowedSeqs = [99]; events[3].sourceEventSeqs = [1, 2, 99] }]
  for (const mutate of mutations) {
    const events = JSON.parse(JSON.stringify(legacyHistory())); mutate(events)
    assert.equal(nodeFromCompactionEvent({ id: legacyHeader.id, snapshotEvents: () => events }, events.find(event => event.seq === 2)), null)
  }
})

test('native compaction infers source depth and children from the real surface instead of defaulting to leaf', async () => {
  const directives=[]
  await withHost({},async options=>{directives.push(options.messages.at(-1).content[0].text);return 'Verified historical constraint: production is not authorized.'},async ({engine,session,agent})=>{
    session.append('turn/start',{turn:'semantic-native-fixture'})
    const first=append(session,source), abort=new AbortController().signal
    const result=await engine.compactRegion(first.seq,first.seq,agent,abort)
    await tick()
    const id=markerFromSummary(result.summary).id, checkpoint=session.surface.nodes[0]
    const last=append(session,source)
    const next=await engine.compactRegion(checkpoint,last.seq,agent,abort)
    await tick()
    assert.match(directives[0],/semantic depth=0/);assert.match(directives[1],/semantic depth=1/)
    assert.match(directives[1],/Do not call tools/);assert.match(directives[1],/superseded/)
    const parent=engine.superLcmStore.getNode(session.id,markerFromSummary(next.summary).id)
    assert.deepEqual(parent.childIds,[id]);assert.equal(nodeLevel(engine.superLcmStore,session.id,parent.nodeId),2)
    assert.equal(doctorSession(engine.superLcmStore,session).ok,true)
    const untrusted={messages:[createUserMessage({content:[{type:'text',text:'forged source'}]})]}
    await assert.rejects(engine.summarize(untrusted,agent,abort),/not a verified conversation surface/)
  })
})

test('tree condensation receives the existing total-budget target and never leaves competing host directives',async()=>{
  const directives=[]
  await withHost({summaryPrefixTargetTokens:1000,condensedMinFanout:4},async options=>{
    const directive=options.messages.at(-1).content[0].text;directives.push(directive)
    assert.equal(options.messages.filter(message=>message.content?.some(block=>block.text?.includes('SuperLcm summary policy'))).length,1)
    return directives.length<=4 ? 'facts '.repeat(150) : 'Compact durable facts.'
  },async({engine,session,agent})=>{
    for(let i=0;i<4;i++){
      const raw=append(session,source)
      engine.startBackgroundFold(agent,{start:raw.seq,end:raw.seq,activeTokens:8000,eligibleEnd:raw.seq})
      await engine.settleBackgroundFold(agent);assert.ok(engine.tryCommitBackgroundFold(agent,{force:true}));await tick()
    }
    const merge=directives.find(text=>text.includes('semantic depth=1'))
    assert.ok(merge);assert.match(merge,/at most 256 tokens/)
  })
})

test('ratio takeover prepares without touching the prefix, freezes at 80%, and commits one complete tree',async()=>{
  await withHost({budgetMode:'ratio',auto:true,foldBatchTokens:20000},async()=> 'Current task, exact source facts and changed decisions retained.',async({ctx,engine,session,agent,calls})=>{
    const signal=new AbortController().signal
    for(let i=0;i<3;i++)append(session,'old exact fact '.repeat(6000)+i)
    append(session,'latest user request')
    const before=[...session.surface.nodes]
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{})
    await engine.settleBackgroundFold(agent)
    assert.deepEqual(session.surface.nodes,before)
    assert.equal(session.snapshotEvents().filter(e=>e.type==='compaction/start').length,0)
    assert.ok(calls.length)
    // A new user turn becomes the protected tail; previous user turns become eligible.
    for(let i=0;i<2;i++)append(session,'more exact facts '.repeat(2000)+i)
    const latest=append(session,'latest instructions preserved '+ 'x'.repeat(16000))
    const live=[...session.surface.nodes]
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{})
    const state=engine.backgroundFolds.get(agent)
    assert.ok(state.cutoffEnd!==undefined)
    const cutoff=state.cutoffEnd
    const fresh=append(session,'arrived after frozen range')
    await engine.settleBackgroundFold(agent)
    assert.equal(engine.backgroundFolds.get(agent).summarized.end,cutoff)
    assert.deepEqual(session.surface.nodes,[...live,fresh.seq])
    assert.ok(engine.tryCommitBackgroundFold(agent,{allowPressure:true}))
    assert.ok(session.surface.nodes.includes(latest.seq));assert.ok(session.surface.nodes.includes(fresh.seq))
    assert.equal(session.snapshotEvents().filter(e=>e.type==='compaction/start').length,1)
    assert.deepEqual(engine.superLcmStore.stats(session.id).missingChildren,[])
    assert.equal(engine.tryCommitBackgroundFold(agent,{allowPressure:true}),null)
  })
})

test('a routed model change discards only that session draft and recalculates capacity',async()=>{
  let release,started
  const gate=new Promise(resolve=>{release=resolve}), entered=new Promise(resolve=>{started=resolve})
  await withHost({budgetMode:'ratio',auto:true,foldBatchTokens:20000},async()=>{started();await gate;return 'Old model draft.'},async({ctx,engine,session,agent})=>{
    const signal=new AbortController().signal
    append(session,'facts '.repeat(18000));append(session,'latest user')
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{});await entered
    const prior=engine.backgroundFolds.get(agent)
    const {resolvePolicy,currentPolicy}=await import('../dsh/ratio-runtime.js')
    agent.options.model='million'
    await resolvePolicy(engine,agent,signal)
    assert.equal(currentPolicy(engine,agent).softActiveTokens,800000)
    assert.equal(prior.controller.signal.aborted,true)
    release();await prior.promise
    assert.equal(engine.backgroundFolds.get(agent),undefined)
    assert.equal(session.snapshotEvents().filter(e=>e.type==='compaction/start').length,0)
  })
})

test('persisted ratio drafts restore exact source snapshots without another model call',async()=>{
  await withHost({budgetMode:'ratio',auto:true,foldBatchTokens:20000},async()=> 'Saved exact facts.',async({ctx,engine,session,agent,calls})=>{
    const signal=new AbortController().signal
    append(session,'facts '.repeat(18000));append(session,'latest user')
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{});await engine.settleBackgroundFold(agent)
    const ready=engine.backgroundFolds.get(agent), count=calls.length
    engine.backgroundFolds.delete(agent)
    engine.draftRestoreAttempts?.delete(agent)
    engine.runtimeGeneration++
    const {resolvePolicy}=await import('../dsh/ratio-runtime.js')
    await resolvePolicy(engine,agent,signal)
    assert.equal(engine.restoreDraft(agent),true)
    assert.equal(calls.length,count)
    assert.deepEqual(engine.backgroundFolds.get(agent).summarized.shadowedSeqs,ready.summarized.shadowedSeqs)
    assert.equal(engine.backgroundFolds.get(agent).generation,engine.runtimeGeneration)
    engine.backgroundFolds.delete(agent);engine.draftRestoreAttempts.delete(agent)
    // Durable source replacement invalidates the saved draft.
    const original=ready.summarized.start
    session.append('user/message',createUserMessage({content:[{type:'text',text:'changed source'}]}),{surfaceOp:{op:'replace',startSeq:original,endSeq:original},sourceEventSeqs:[original]})
    assert.equal(engine.restoreDraft(agent),false)
    assert.equal(engine.superLcmStore.loadDraft(session.id),null)
  })
})

test('emergency ratio protection blocks an oversized latest turn without a blind provider retry',async()=>{
  await withHost({budgetMode:'ratio',auto:true,foldBatchTokens:20000},async()=> 'Unused summary.',async({ctx,session,agent,calls})=>{
    append(session,'latest huge uncompressible turn '.repeat(20000))
    let requested=false
    await assert.rejects(ctx.waterfall('agent/pre-step',{agent,signal:new AbortController().signal},()=>{requested=true}),/本轮原文|占用过多空间/)
    assert.equal(requested,false);assert.equal(calls.length,0)
  })
})

test('equal-length source repairs invalidate saved drafts before reuse',async()=>{
  await withHost({budgetMode:'ratio',auto:true,foldBatchTokens:20000},async()=> 'Saved facts.',async({ctx,engine,session,agent})=>{
    const signal=new AbortController().signal
    append(session,'a'.repeat(84000));append(session,'latest user')
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{});await engine.settleBackgroundFold(agent)
    const state=engine.backgroundFolds.get(agent), before=ctx.tokenMeter.measure(session).totalTokens
    engine.backgroundFolds.delete(agent);engine.draftRestoreAttempts.delete(agent)
    const eventAt=session.eventAt.bind(session)
    session.eventAt=seq=>{
      const event=eventAt(seq)
      if(seq!==state.summarized.start)return event
      const copy=structuredClone(event);copy.data.content[0].text='b'+copy.data.content[0].text.slice(1);return copy
    }
    assert.equal(ctx.tokenMeter.measure(session).totalTokens,before)
    assert.equal(engine.restoreDraft(agent),false)
    assert.equal(engine.superLcmStore.loadDraft(session.id),null)
  })
})

test('a no-progress tree merge never purchases the same input again after cooldown',async()=>{
  let noProgress=false, merged=0
  await withHost({budgetMode:'ratio',auto:true,foldBatchTokens:20000},async options=>{
    if(options.messages.at(-1).content[0].text.includes('semantic depth=1')){
      merged++;if(noProgress)return 'verbose '.repeat(12000)
    }
    return 'leaf useful fact '.repeat(160)
  },async({ctx,engine,session,agent,calls})=>{
    const signal=new AbortController().signal
    // Four 20K leaves produce enough summary input to become an eligible merge.
    for(let i=0;i<3;i++)append(session,'x'.repeat(84000)+i)
    append(session,'latest user')
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{});await engine.settleBackgroundFold(agent)
    noProgress=true
    // Direct staging mirrors the threshold's final complete suffix while keeping
    // the provider request out of the emergency path in this local test.
    const suffix=append(session,'y'.repeat(84000))
    append(session,'latest user')
    const {resolvePolicy}=await import('../dsh/ratio-runtime.js')
    await resolvePolicy(engine,agent,signal)
    const selection=engine.planRolling(agent);assert.ok(selection)
    engine.startBackgroundFold(agent,selection);await engine.settleBackgroundFold(agent)
    assert.ok(merged>0)
    const purchased=calls.length
    let now=Date.now()+3600000;engine.summaryGuards.clock=()=>now
    for(let i=0;i<3;i++){
      const next=engine.planRolling(agent)
      if(next)engine.startBackgroundFold(agent,next)
      await engine.settleBackgroundFold(agent);now+=3600000
    }
    assert.equal(calls.length,purchased)
    assert.ok(session.surface.nodes.includes(suffix.seq))
    assert.equal(session.snapshotEvents().filter(e=>e.type==='compaction/start').length,0)
  })
})

test('restored checkpoint-only drafts freeze without requiring transient prepared input',async()=>{
  await withHost({budgetMode:'tokens',minRetainTokens:1000,foldBatchTokens:64000,softActiveTokens:4000,hardActiveTokens:10000},async()=> 'Saved historical facts.',async({engine,session,agent})=>{
    const raw=append(session,source.slice(0,24000))
    engine.startBackgroundFold(agent,{start:raw.seq,end:raw.seq,activeTokens:0,eligibleEnd:raw.seq})
    await engine.settleBackgroundFold(agent)
    const state=engine.backgroundFolds.get(agent)
    delete state.prepared;state.cutoffEnd=undefined
    // Force the no-eligible-range branch while retaining an already saved range.
    engine.rollingConfig.minRetainTokens=100000
    assert.doesNotThrow(()=>engine.tryCommitBackgroundFold(agent,{allowPressure:true}))
  })
})

async function actualLoop(ctx,model='fixture') {
  const [{default:Agents},{default:SystemPrompt},{default:Tools},{default:AgentLoop}]=await Promise.all([
    import('@deepseek-ai/dsh-agent'),import('@deepseek-ai/dsh-system-prompt'),import('@deepseek-ai/dsh-tools'),import('@deepseek-ai/dsh-agent-loop')])
  new Agents(ctx);new SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:false});new Tools(ctx)
  new AgentLoop(ctx,{agents:[],maxParallelToolCalls:10})
  return ctx.agentLoop.create('real-ratio-loop',{provider:'local',model},{cwd:'/fixture'})
}
async function actualSend(ctx,agent,text) {
  const errors=[]
  let stopStatus,stopError,timer
  try {
    await new Promise((resolve,reject)=>{
      stopError=ctx.on('agent/error',payload=>{if(payload.agent===agent)errors.push(payload.error)})
      stopStatus=ctx.on('agent/status',payload=>{if(payload.agent===agent&&payload.status==='idle')resolve()})
      timer=setTimeout(()=>reject(Error('local Agent.send fixture did not finish')),5000)
      agent.send(createUserMessage({content:[{type:'text',text}]}),'next-turn',true)
    })
  }finally{stopStatus?.();stopError?.();clearTimeout(timer)}
  return errors
}

test('real Agent.send blocks oversized first input after admission and preserves it in the session',async()=>{
  await withHost({budgetMode:'ratio',auto:true},async()=> 'Should not dispatch.',async({ctx,calls})=>{
    const agent=await actualLoop(ctx)
    const errors=await actualSend(ctx,agent,'huge first input '.repeat(40000))
    assert.equal(calls.length,0)
    assert.ok(errors.length)
    assert.ok(agent.session.surface.nodes.some(seq=>agent.session.eventAt(seq).type==='user/message'))
  })
})

test('real Agent.send uses the newly resolved small route instead of the previous large header',async()=>{
  await withHost({budgetMode:'ratio',auto:true},async()=> 'Main response.',async({ctx,calls,engine})=>{
    const agent=await actualLoop(ctx,'million')
    assert.deepEqual(await actualSend(ctx,agent,'normal first input'),[])
    ctx.on('agent/request',async(payload,next)=>{const config=await next();return payload.agent===agent?{...config,model:'fixture'}:config})
    const before=calls.length
    const errors=await actualSend(ctx,agent,'huge new small-model input '.repeat(20000))
    assert.ok(errors.length)
    assert.equal(calls.length,before)
    const {currentPolicy}=await import('../dsh/ratio-runtime.js')
    assert.equal(currentPolicy(engine,agent).softActiveTokens,80000)
    assert.equal(agent.session.requestHeader().config.model,'fixture')
  })
})

test('real Agent.send replaces ready context before one rebuilt provider request',async()=>{
  await withHost({budgetMode:'ratio',auto:true},async()=> 'Exact facts and current decisions.',async({ctx,engine,calls})=>{
    const agent=await actualLoop(ctx),session=agent.session
    for(let i=0;i<3;i++)append(session,'prior full input '.repeat(5000)+i)
    assert.deepEqual(await actualSend(ctx,agent,'prepare background'),[])
    await engine.settleBackgroundFold(agent)
    const mainBefore=calls.filter(call=>call.sessionId===session.id).length
    assert.deepEqual(await actualSend(ctx,agent,'fresh complete input '.repeat(5000)),[])
    await engine.settleBackgroundFold(agent)
    // The next actual request publishes the ready finite cycle, then the
    // host reconstructs its frozen request without sending the stale one.
    assert.deepEqual(await actualSend(ctx,agent,'continue'),[])
    const main=calls.filter(call=>call.sessionId===session.id)
    assert.equal(main.length,mainBefore+2)
    assert.equal(session.snapshotEvents().filter(e=>e.type==='compaction/start').length,1)
    assert.ok(main.at(-1).inputTokens<50000)
    assert.deepEqual(engine.superLcmStore.stats(session.id).missingChildren,[])
  })
})

test('runtime snapshots and multiple inputs preserve the whole newest real user turn',async()=>{
  await withHost({},async()=> 'Unused.',async({session})=>{
    append(session,'old turn')
    session.append('turn/start',{turn:1})
    const first=append(session,'first real input');append(session,'second real input')
    session.append('user/message',createUserMessage({content:[{type:'text',text:'automatic snapshot'}],source:{kind:'runtime-context'}}),{surfaceOp:'append'})
    const {latestUserIndex}=await import('../dsh/ratio-runtime.js')
    assert.equal(session.surface.nodes[latestUserIndex(session)],first.seq)
  })
})

test('a million-token window compresses many leaves into a bounded tree and preserves the recent turn',async()=>{
  await withHost({budgetMode:'ratio',auto:true,foldBatchTokens:20000},async options=>options.messages.at(-1).content[0].text.includes('semantic depth=1')
    ? 'Condensed exact facts, changed decisions and recall pointers.' : 'leaf exact decision and source '.repeat(200),async({ctx,engine,session,agent,calls})=>{
    agent.options.model='million'
    for(let i=0;i<40;i++)append(session,'x'.repeat(80000)+i)
    const latest=append(session,'recent active turn '+ 'y'.repeat(160000))
    await ctx.waterfall('agent/pre-step',{agent,signal:new AbortController().signal},()=>{})
    await engine.settleBackgroundFold(agent)
    const state=engine.backgroundFolds.get(agent)
    assert.ok(state.parts.length>=30)
    assert.ok(state.tree.some(node=>node.kind==='condensed'))
    assert.ok(engine.tryCommitBackgroundFold(agent,{allowPressure:true}))
    assert.ok(ctx.tokenMeter.measure(session).totalTokens<120000)
    assert.ok(session.surface.nodes.includes(latest.seq))
    assert.equal(session.snapshotEvents().filter(e=>e.type==='compaction/start').length,1)
    assert.ok(calls.length<70,'bounded merges avoid deep per-message regeneration')
    assert.deepEqual(engine.superLcmStore.stats(session.id).missingChildren,[])
  })
})

test('real requests honor their bound small adapter capacity during a provider metadata update',async()=>{
  await withHost({budgetMode:'ratio',auto:true},async()=> 'Must not dispatch.',async({ctx,engine,calls})=>{
    const agent=await actualLoop(ctx,'million')
    ctx.llm.prepareCall=async config=>({config,context:{contextWindow:100000},stream:options=>ctx.llm.stream(options)})
    const errors=await actualSend(ctx,agent,'huge actual small-bound input '.repeat(20000))
    assert.ok(errors.length)
    assert.equal(calls.length,0)
    const {currentPolicy}=await import('../dsh/ratio-runtime.js')
    assert.equal(currentPolicy(engine,agent).softActiveTokens,80000)
    assert.equal(agent.session.requestContext().contextWindow,100000)
  })
})

test('custom replacement percentage keeps ready drafts private until its own threshold',async()=>{
  await withHost({budgetMode:'ratio',auto:true,prepareRatio:.6,switchRatio:.85,emergencyRatio:.95},async()=> 'Exact facts and current constraint.',async({ctx,engine,session,agent})=>{
    for(let i=0;i<4;i++)append(session,'x'.repeat(78000)+i)
    append(session,'latest user')
    const signal=new AbortController().signal
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{});await engine.settleBackgroundFold(agent)
    const surface=[...session.surface.nodes]
    assert.ok(ctx.tokenMeter.measure(session).totalTokens>70000)
    assert.equal(engine.tryCommitBackgroundFold(agent,{allowPressure:true}),null)
    assert.deepEqual(session.surface.nodes,surface)
    append(session,'more previous instructions '+ 'y'.repeat(40000));append(session,'new latest user')
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{});await engine.settleBackgroundFold(agent)
    assert.ok(engine.tryCommitBackgroundFold(agent,{allowPressure:true}))
    assert.equal(session.snapshotEvents().filter(e=>e.type==='compaction/start').length,1)
  })
})
