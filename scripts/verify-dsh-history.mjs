// Read-only replay of real persisted summary bodies. Full live conversations
// remain host-owned; this check never publishes compaction or calls a model.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Engine from '../dsh/engine.js'
import { migrateLegacyIndex } from '../dsh/migration.js'

const path = process.argv[2] || join(homedir(), '.dsh/lossless-context/lcm.sqlite')
const source = new DatabaseSync(path, { readOnly: true })
const dir = mkdtempSync(join(tmpdir(), 'superlcm-history-replay-'))
process.env.DSH_SUPERLCM_DB = join(dir, 'lcm.sqlite')
const ctx = new Context(); let modelCalls = 0
try {
  new SessionStore(ctx); new SessionProjections(ctx)
  ctx.reflect.provide('llm', { imageRequestPricing() {}, fileRequestText() {}, stream() { modelCalls++; throw Error('Model inference is forbidden in this read-only replay') } })
  new TokenMeter(ctx)
  new Engine(ctx, { auto: false, summarizationProvider: 'replay-only', summarizationModel: 'no-inference' })
  const engine = ctx.compaction
  migrateLegacyIndex(engine.superLcmStore, { DSH_HOME: join(dir, 'empty'), DSH_SUPERLCM_LEGACY_DB: path })
  const rows = source.prepare(`SELECT n.* FROM lcm_nodes n WHERE n.status='ready' AND NOT EXISTS (
    SELECT 1 FROM lcm_edges e JOIN lcm_nodes p ON p.session_id=e.session_id AND p.node_id=e.parent_id
    WHERE e.session_id=n.session_id AND e.child_id=n.node_id AND p.status='ready'
  ) ORDER BY n.session_id,n.summary_seq`).all()
  const groups = new Map()
  for (const row of rows) { if (!groups.has(row.session_id)) groups.set(row.session_id, []); groups.get(row.session_id).push(row) }
  let copied = 0, regularCondensations = 0, forcedCondensations = 0
  for (const [id, summaries] of groups) {
    const session = ctx.sessions.create(id, { meta: { cwd: '/replay' } })
    for (const row of summaries) {
      const content = JSON.parse(row.summary_json)
      const event = session.append('user/message', createUserMessage({ content, source: compactCheckpointSource(row.compaction_id || row.node_id) }), { surfaceOp: 'append' })
      assert.deepEqual(event.data.content, content); copied++
    }
    for (const text of ['replay tail one', 'replay tail two']) session.append('user/message', createUserMessage({ content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    const regular = engine.planRolling({ session }), forced = engine.planRolling({ session }, true)
    if (regular?.summaryKind === 'condensed') regularCondensations++
    if (forced?.summaryKind === 'condensed') forcedCondensations++
    if (regular?.summaryKind === 'condensed') assert.ok(regular.sourceCount >= 4)
    if (forced?.summaryKind === 'condensed') assert.ok(forced.sourceCount >= 2)
    for (const selection of [regular, forced]) if (selection?.summaryKind === 'condensed') assert.ok(selection.end < summaries.length)
    assert.equal(session.snapshotEvents().some(event => event.type === 'compaction/start'), false)
  }
  assert.equal(modelCalls, 0)
  console.log(JSON.stringify({ status: 'PASS', runtime: 'DSH 0.2.1-alpha.1', sourceAccess: 'readOnly', sessionsReplayed: groups.size, persistedSummaryBodiesReplayed: copied, regularCondensationCandidates: regularCondensations, simulatedOverflowCondensationCandidates: forcedCondensations, originalSummaryContentChanges: 0, modelCalls, publishedCompactions: 0, productionWrites: 0, limitation: 'Persisted summary-body replay; not a complete live transcript or online model-quality test' }))
} finally { source.close(); await ctx.fiber.dispose() }
