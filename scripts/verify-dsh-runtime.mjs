// Run with the existing DSH host peers, never a mock compaction base.
// This mounts an isolated in-memory host and makes no model/network requests.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import Engine from '../dsh/engine.js'
import { apply, projectEvent } from '../dsh/archive.js'
import { ClaudeStore } from '../src/store.js'
import { prepareAsyncRegion, summarizeAsyncRegion, commitAsyncRegion } from '../dsh/async-region.js'

const dir = mkdtempSync(join(tmpdir(), 'superlcm-native-host-'))
process.env.SUPERLCM_HOME = dir
process.env.DSH_HOME = join(dir, 'empty')
delete process.env.DSH_SUPERLCM_DB; delete process.env.DSH_LOSSLESS_DB
const ctx = new Context(), warnings = []
let localSummaryCalls = 0
ctx.logger.warn = message => warnings.push(message)
try {
  new SystemPrompt(ctx, {})
  new SessionStore(ctx)
  new ToolRuntime(ctx)
  new Query(ctx, { path: ':memory:', openAt: 'never' })
  ctx.reflect.provide('llm', { async *stream() { localSummaryCalls++; yield { type: 'text-delta', index: 0, text: '原文讨论了 DSH 共享会话存储，决定使用一套插件。' } } })
  ctx.reflect.provide('tokenMeter', {
    measure(session) { return { nodes: session.surface.nodes.map(seq => ({ seq, tokens: Math.ceil(JSON.stringify(session.eventAt(seq).data).length / 4), heuristicTokens: Math.ceil(JSON.stringify(session.eventAt(seq).data).length / 4) })) } },
    estimateMessage(message) { return Math.ceil(JSON.stringify(message).length / 4) },
  })
  new Engine(ctx, { auto: false, summarizationProvider: 'local-fixture', summarizationModel: 'deterministic' })
  assert.equal(ctx.compaction.constructor.name, 'SuperLcmCompactionEngine')
  assert.equal(ctx.compaction.superLcmStore.path, join(dir, 'lcm.sqlite'))
  apply(ctx)
  const session = ctx.sessions.create('native-runtime', { meta: { cwd: '/project' } })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '真实 DSH 服务中的会话事件。'.repeat(1000) }] }), { surfaceOp: 'append' })
  const store = new ClaudeStore(dir)
  try {
    const until = Date.now() + 10000
    while (store.stats('dsh-native-runtime').records < 1 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(store.stats('dsh-native-runtime').records >= 1)
    assert.match(projectEvent(session.id, session.eventAt(0)).content, /真实 DSH 服务/)
    const before = store.stats('dsh-native-runtime').records
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '增量第二条' }] }), { surfaceOp: 'append' })
    while (store.stats('dsh-native-runtime').records <= before && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.stats('dsh-native-runtime').records, before + 1)
    assert.equal(store.effectiveSetting('dsh-native-runtime').mode, 'off')
    const agent = { session, options: { provider: 'local-fixture', model: 'deterministic' } }
    const prepared = prepareAsyncRegion(ctx.compaction, agent, { start: 0, end: 0 })
    const summarized = await summarizeAsyncRegion(ctx.compaction, agent, prepared, new AbortController().signal)
    commitAsyncRegion(ctx.compaction, agent, summarized)
    while (store.stats('dsh-native-runtime').summary_count < 1 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.stats('dsh-native-runtime').summary_count, 1)
    assert.equal(localSummaryCalls, 1)
    assert.deepEqual(store.outline('dsh-native-runtime').nodes[0].source_records, [0])
    assert.deepEqual(warnings.filter(x => !String(x).includes('ExperimentalWarning')), [])
    console.log(JSON.stringify({ status: 'PASS', runtime: 'installed DSH 0.2.1-alpha.1', records: store.stats('dsh-native-runtime').records, compactionProviders: 1, localSummaryCalls, paidModelCalls: 0, sharedSummaries: 1, archive: 'isolated temporary database' }))
  } finally { store.close() }
} finally { await ctx.fiber.dispose() }
