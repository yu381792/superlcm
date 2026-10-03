import test from 'node:test'
import assert from 'node:assert/strict'
import { selectSummaryCondensation } from '../dsh/summary-prefix.js'
import { selectRollingRange } from '../dsh/rolling.js'
import { SessionFoldRegistry, SummaryGuards } from '../dsh/summary-guards.js'
import { selectionPricing } from '../dsh/selection-pricing.js'

test('tail budgets use observed request density instead of four-character text estimates', () => {
  const pricing = selectionPricing({ surfaceTokens: 100000, surfaceDeltaTokens: 0,
    baseline: { kind: 'usage', tokens: 200000 }, nodes: nodes([20000, 20000, 20000, 20000, 20000]) })
  assert.equal(pricing.factor, 2)
  const result = selectRollingRange(pricing.nodes, [0, 1, 2, 3, 4], {
    tailCount: 64, minRetainTokens: 40000, retainTokenBudget: true,
    foldBatchTokens: 64000, activeTokens: 260000, softActiveTokens: 260000,
  })
  assert.equal(result.tailTokens, 40000)
  assert.equal(result.tailNodes, 1)
})

test('an oversized older tool group is folded instead of inflating the recent tail', () => {
  const priced = nodes([60000, 30000, 30000, 10000])
  const result = selectRollingRange(priced, [0, 1, 2, 3], {
    tailCount: 1, minRetainTokens: 40000, retainTokenBudget: true,
    foldBatchTokens: 64000, activeTokens: 260000, softActiveTokens: 260000,
    isBalancedBefore: seq => seq !== 2, isBalancedAfter: seq => seq !== 1,
  })
  assert.equal(result.tailTokens, 10000)
  assert.equal(result.end, 2)
})

const policy = { systemEnd: 1, prefixEnd: 6, summaryPrefixTargetTokens: 20000, condensedMinFanout: 4, pressureFoldTokens: 20000, foldBatchTokens: 64000, softActiveTokens: 160000, hardActiveTokens: 220000, activeTokens: 90000 }
const nodes = prices => prices.map((tokens, seq) => ({ seq, tokens }))
const choose = (prices, depths, options = {}) => { const priced = nodes(prices); return selectSummaryCondensation(priced, priced.map(n => n.seq), depths, { ...policy, ...options }) }

test('prefix under budget stays untouched and does not query the historical DAG', () => {
  assert.equal(choose([100, 1000, 1000, 1000, 1000, 1000, 32000], () => { throw Error('should not read depth') }), null)
})
test('oversized prefix condenses shallow contiguous checkpoints and protects system/raw tail', () => {
  const selected = choose([100, 10000, 5000, 5000, 5000, 5000, 32000], [null, 3, 1, 1, 1, 1, null])
  assert.equal(selected.start, 2); assert.equal(selected.end, 5)
  assert.equal(selected.sourceDepth, 1); assert.equal(selected.sourceCount, 4)
  assert.equal(selected.tailTokens, 32000); assert.equal(selected.summaryKind, 'condensed')
})
test('depth changes and missing committed nodes never become one mixed condensation', () => {
  assert.equal(choose([100, 10000, 10000, 10000, 10000, 10000, 32000], [null, 1, 1, null, 2, 2, null]), null)
})
test('reported overflow can use two checkpoints without pretending occupancy rose', () => {
  const selected = choose([100, 1000, 1000, 32000], [null, 1, 1, null], { prefixEnd: 3, forceHard: true, activeTokens: 34100 })
  assert.equal(selected.sourceCount, 2); assert.equal(selected.activeTokens, 34100)
  const priced = nodes([10000, 10000, 10000])
  const raw = selectRollingRange(priced, [0, 1, 2], { firstFoldableIndex: 0, tailCount: 3, minRetainTokens: 10000, activeTokens: 30000, forceHard: true })
  assert.equal(raw.reason, 'hard-cap'); assert.equal(raw.activeTokens, 30000); assert.equal(raw.end, 1)
})
test('summary condensation respects tool boundaries', () => {
  assert.equal(choose([100, 10000, 10000, 10000, 10000, 10000, 32000], [null, 1, 1, 1, 1, 1, null], { isBalancedAfter: () => false }), null)
})
test('one background slot is shared by two agents on a session; other sessions remain independent', () => {
  const registry = new SessionFoldRegistry(), session = {}, a = { session }, b = { session }, other = { session: {} }
  const state = { status: 'summarizing' }
  registry.set(a, state)
  assert.equal(registry.get(b), state); assert.equal(registry.has(other), false)
  registry.delete(b); assert.equal(registry.has(a), false)
})
test('banned route waits without model calls while explicit fallback stays usable', () => {
  let now = 1000
  const guards = new SummaryGuards(() => now), primary = { provider: 'p', model: 'a' }, fallback = { provider: 'q', model: 'b' }
  guards.failedRoute(primary, Object.assign(Error('account banned'), { status: 403 }), 30000)
  assert.equal(guards.canTry(primary), false); assert.equal(guards.canTry(fallback), true)
  assert.throws(() => guards.assertRoute(primary), { code: 'SUPERLCM_SUMMARY_COOLDOWN' })
  now += 300000; assert.equal(guards.canTry(primary), true)
  guards.succeededRoute(primary); assert.equal(guards.routes.size, 0)
  guards.failedRoute(primary, Object.assign(Error('credentials unavailable'), { code: 'AUTH_REQUIRED' }), 30000)
  now += 30000; assert.equal(guards.canTry(primary), false)
})
test('transient/no-progress retry waits increase, share session ownership, and reset on configuration change', () => {
  let now = 1000
  const guards = new SummaryGuards(() => now), session = {}, a = { session }, b = { session }
  guards.failedSession(a, 'route1', 30000)
  assert.equal(guards.canStart(b, 'route1'), false); assert.equal(guards.canStart(b, 'route2'), true)
  now += 30000; assert.equal(guards.canStart(b, 'route1'), true)
  guards.failedSession(b, 'route1', 30000)
  now += 30000; assert.equal(guards.canStart(a, 'route1'), false)
  guards.clear(); assert.equal(guards.canStart(a, 'route1'), true)
})
