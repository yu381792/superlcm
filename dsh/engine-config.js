import z from '@deepseek-ai/schemastery'
import {ratioOptions} from './ratio-policy.js'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { extractChildNodeIds } from './marker.js'

const DEPRECATED_CONFIG_KEYS = new Set(['cacheTtlSeconds', 'thresholdRatio', 'retainRatio'])
const FALLBACK_CONFIG_KEYS = new Set(['fallbackSummarizationProvider', 'fallbackSummarizationModel'])

const ROLLING_CONFIG_KEYS = new Set([
  'budgetMode','prepareRatio','switchRatio','emergencyRatio',
  'archiveHome',
  'controlFile',
  'summaryAdapter',
  'runtimeTuning',
  'mode',
  'tailCount',
  'minRetainTokens',
  'pressureFoldTokens',
  'foldBatchTokens',
  'softActiveTokens',
  'hardActiveTokens',
  'foldTiming',
  'summaryPrefixTargetTokens',
  'condensedMinFanout',
  'summaryTimeoutMs',
  'summaryRetryCooldownMs',
])

const ROLLING_DEFAULTS = Object.freeze({
  mode: 'rolling',
  budgetMode: 'ratio',prepareRatio:0.7,switchRatio:0.8,emergencyRatio:0.9,
  tailCount: 24,
  minRetainTokens: 32000,
  pressureFoldTokens: 20000,
  foldBatchTokens: 20000,
  softActiveTokens: 160000,
  hardActiveTokens: 220000,
  foldTiming: 'background',
  summaryPrefixTargetTokens: 0,
  condensedMinFanout: 4,
  summaryTimeoutMs: 180000,
  summaryRetryCooldownMs: 30000,
})

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function normalizeRolling(config) {
  const raw = config ?? {}
  if (raw.foldTiming !== undefined && raw.foldTiming !== 'background') {
    throw new Error('SuperLcm only supports non-blocking background automatic compaction')
  }
  if (raw.mode !== undefined && raw.mode !== 'rolling') {
    throw new Error('SuperLcm only supports rolling mode because automatic compaction must remain non-blocking')
  }
  if (raw.budgetMode !== undefined && !['tokens','ratio'].includes(raw.budgetMode)) throw Error('压缩预算模式无效')
  const mode = 'rolling'
  const foldBatchTokens = positiveInteger(raw.foldBatchTokens, ROLLING_DEFAULTS.foldBatchTokens)
  const pressureFoldTokens = Math.min(
    positiveInteger(raw.pressureFoldTokens, ROLLING_DEFAULTS.pressureFoldTokens),
    foldBatchTokens,
  )
  const softActiveTokens = positiveInteger(raw.softActiveTokens, ROLLING_DEFAULTS.softActiveTokens)
  const requestedHardActiveTokens = positiveInteger(raw.hardActiveTokens, ROLLING_DEFAULTS.hardActiveTokens)
  const hardActiveTokens = requestedHardActiveTokens > softActiveTokens
    ? requestedHardActiveTokens
    : softActiveTokens + 1

  return {
    mode,
    budgetMode:raw.budgetMode??(raw.softActiveTokens!==undefined||raw.hardActiveTokens!==undefined?'tokens':'ratio'),
    ...ratioOptions(raw),
    tailCount: positiveInteger(raw.tailCount, ROLLING_DEFAULTS.tailCount),
    minRetainTokens: nonNegativeInteger(raw.minRetainTokens, ROLLING_DEFAULTS.minRetainTokens),
    pressureFoldTokens,
    foldBatchTokens,
    softActiveTokens,
    hardActiveTokens,
    foldTiming: ROLLING_DEFAULTS.foldTiming,
    summaryPrefixTargetTokens: nonNegativeInteger(raw.summaryPrefixTargetTokens, ROLLING_DEFAULTS.summaryPrefixTargetTokens),
    condensedMinFanout: Math.max(2, positiveInteger(raw.condensedMinFanout, ROLLING_DEFAULTS.condensedMinFanout)),
    summaryTimeoutMs: positiveInteger(raw.summaryTimeoutMs, ROLLING_DEFAULTS.summaryTimeoutMs),
    summaryRetryCooldownMs: positiveInteger(raw.summaryRetryCooldownMs, ROLLING_DEFAULTS.summaryRetryCooldownMs),
  }
}

function cleanRouteValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanRoute(route) {
  return {
    provider: cleanRouteValue(route?.provider),
    model: cleanRouteValue(route?.model),
  }
}

function routeIsComplete(route) {
  return (route.provider.length === 0) === (route.model.length === 0)
}

function routeIsConfigured(route) {
  return route.provider.length > 0 && route.model.length > 0
}

function routesEqual(left, right) {
  return left.provider === right.provider && left.model === right.model
}

const SETTINGS_NAMESPACE = 'superlcm'

const SUMMARIZATION_ROUTE_SCHEMA = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
}).default({ provider: '', model: '' })

const SETTINGS_SCHEMA = z.object({
  summarizationRoute: SUMMARIZATION_ROUTE_SCHEMA,
  fallbackSummarizationRoute: SUMMARIZATION_ROUTE_SCHEMA,
  tailCount: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.tailCount),
  minRetainTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.minRetainTokens),
  pressureFoldTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.pressureFoldTokens),
  foldBatchTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.foldBatchTokens),
  softActiveTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.softActiveTokens),
  hardActiveTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.hardActiveTokens),
  foldTiming: z.const('background').default(ROLLING_DEFAULTS.foldTiming),
})

// dsh 0.1.7: volatile 字段 resolve 后是 { get() } 引用对象，读取时解包。
function unwrapVolatile(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

function unwrapConfig(config) {
  const raw = config ?? {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) out[key] = unwrapVolatile(value)
  return out
}

function splitConfig(config) {
  const raw = unwrapConfig(config)
  const primaryRoute = cleanRoute({
    provider: raw.summarizationProvider,
    model: raw.summarizationModel,
  })
  const fallbackRoute = cleanRoute({
    provider: raw.fallbackSummarizationProvider,
    model: raw.fallbackSummarizationModel,
  })
  if (!routeIsComplete(fallbackRoute)) {
    throw new Error('fallback summarization provider and model must be set together')
  }
  if (routeIsConfigured(fallbackRoute) && !routeIsConfigured(primaryRoute)) {
    throw new Error('fallback summarization route requires an explicit primary route')
  }
  if (routeIsConfigured(fallbackRoute) && routesEqual(primaryRoute, fallbackRoute)) {
    throw new Error('fallback summarization route must differ from the primary route')
  }

  const base = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!ROLLING_CONFIG_KEYS.has(key) && !DEPRECATED_CONFIG_KEYS.has(key) && !FALLBACK_CONFIG_KEYS.has(key)) base[key] = value
  }
  return { base, rolling: normalizeRolling(raw), fallbackRoute }
}

function systemPrefixEndIndex(session) {
  const surfaceNodes = session?.surface?.nodes
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length === 0) return 0
  const head = typeof session.eventAt === 'function' ? session.eventAt(surfaceNodes[0]) : undefined
  return head?.type === 'system/message' ? 1 : 0
}

function isFrozenCheckpoint(event) {
  return event?.type === 'user/message'
    && !!event.data?.source
    && isCompactCheckpointSource(event.data?.source)
    && extractChildNodeIds(event.data?.content).length > 0
}

function firstFoldableSurfaceIndex(session) {
  const surfaceNodes = session?.surface?.nodes
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length === 0) return 0
  let index = systemPrefixEndIndex(session)
  if (typeof session.eventAt !== 'function') return index
  while (index < surfaceNodes.length && isFrozenCheckpoint(session.eventAt(surfaceNodes[index]))) index += 1
  return index
}

function reportIndexFailure(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.warn(`[SuperLcm] 已提交的压缩索引失败 / failed to index committed compaction: ${message}`)
}


export { DEPRECATED_CONFIG_KEYS, FALLBACK_CONFIG_KEYS, ROLLING_CONFIG_KEYS, ROLLING_DEFAULTS, positiveInteger, nonNegativeInteger, normalizeRolling, cleanRouteValue, cleanRoute, routeIsComplete, routeIsConfigured, routesEqual, SETTINGS_NAMESPACE, SUMMARIZATION_ROUTE_SCHEMA, SETTINGS_SCHEMA, unwrapVolatile, unwrapConfig, splitConfig, systemPrefixEndIndex, isFrozenCheckpoint, firstFoldableSurfaceIndex, reportIndexFailure }
