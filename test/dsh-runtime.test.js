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
import { markerFromSummary, encodeMarker } from '../dsh/marker.js'
import { nodeLevel, reindexSession } from '../dsh/core.js'
import { SuperLcmStore } from '../dsh/store.js'
import { draftTokens } from '../dsh/draft-tree.js'
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
    ctx.reflect.provide('llm', { async *stream(options) {
      calls.push({ provider: options.provider, model: options.model, signal: options.signal, sessionId: options.sessionId })
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
    assert.ok(nodeLevel(engine.superLcmStore, session.id, root) >= 3)
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
      assert.ok(shared.outline(captured.session).nodes[0].level >= 2)
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
      const selected=[];engine.summaryContext.llm.stream=async function*(o){selected.push(o.provider);yield{type:'text-delta',index:0,text:'新的压缩摘要保留原文指针'}}
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
    engine.summaryContext.llm.stream=async function*(options){selected.push([options.provider,options.model]);yield{type:'text-delta',index:0,text:'原始工程事实已压缩，主对话模型未参与。'}}
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
