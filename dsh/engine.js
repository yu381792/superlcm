import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { committedCompactionSummary, indexCompactionEvent } from './core.js'
import { appendRecallEnvelope, extractChildNodeIds } from './marker.js'
import { selectRollingRange } from './rolling.js'
import { SuperLcmStore, resolveDatabasePath } from './store.js'
import {
  AsyncSurfaceChangedError,
  commitAsyncRegion,
  prepareAsyncRegion,
  summarizeAsyncRegion,
} from './async-region.js'

import { DEPRECATED_CONFIG_KEYS, FALLBACK_CONFIG_KEYS, ROLLING_CONFIG_KEYS, ROLLING_DEFAULTS, positiveInteger, nonNegativeInteger, normalizeRolling, cleanRouteValue, cleanRoute, routeIsComplete, routeIsConfigured, routesEqual, SETTINGS_NAMESPACE, SUMMARIZATION_ROUTE_SCHEMA, SETTINGS_SCHEMA, unwrapVolatile, unwrapConfig, splitConfig, systemPrefixEndIndex, isFrozenCheckpoint, firstFoldableSurfaceIndex, reportIndexFailure } from './engine-config.js'

export class SuperLcmCompactionEngine extends BasicCompactionEngine {
  // dsh 0.1.7: 运行时可热更字段（原 installSection 的 settings 区）改为在 Config 上
  // 声明 volatile。Settings 表单直接读写本条目的 Config，变更经 loader 的
  // volatile 提交路径更新 fiber.config 并触发 loader/volatile-update。
  // 注意：必须用单层 z.object —— z.intersect 会把 volatile ref 按 key 拆散合并，
  // 丢失引用语义（实测 schemastery 3.18.3），所以这里平铺声明全部字段。
  static Config = z.object({
    // —— 继承自 BasicCompactionEngine.Config 的字段（保持同形）——
    thresholdRatio: z.number(),
    headroomTokens: z.number().step(1).min(0),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(z.object({})),
    auto: z.boolean(),
    // —— SuperLcm 自有字段，全部 volatile，可运行中热更 ——
    summarizationProvider: z.string().default('').volatile(),
    summarizationModel: z.string().default('').volatile(),
    fallbackSummarizationProvider: z.string().default('').volatile(),
    fallbackSummarizationModel: z.string().default('').volatile(),
    mode: z.const('rolling').default(ROLLING_DEFAULTS.mode).volatile(),
    tailCount: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.tailCount).volatile(),
    minRetainTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.minRetainTokens).volatile(),
    pressureFoldTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.pressureFoldTokens).volatile(),
    foldBatchTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.foldBatchTokens).volatile(),
    softActiveTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.softActiveTokens).volatile(),
    hardActiveTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.hardActiveTokens).volatile(),
    foldTiming: z.const('background').default(ROLLING_DEFAULTS.foldTiming).volatile(),
  })

  constructor(ctx, config = {}) {
    const { base, rolling, fallbackRoute } = splitConfig(config)
    super(ctx, base)
    this.rollingConfig = rolling
    this.fallbackSummarizationRoute = fallbackRoute
    this.superLcmStore = new SuperLcmStore(resolveDatabasePath())
    this.backgroundFolds = new WeakMap()
    this.backgroundControllers = new Set()
    this.warnedMissingBackgroundRoute = false
    this.superlcmStore = this.superLcmStore
    // 兼容 dsh-lossless-context <= 0.2.x 的旧属性 / Compatibility property for dsh-lossless-context <= 0.2.x.
    this.losslessStore = this.superLcmStore
    ctx.effect(() => () => {
      for (const controller of this.backgroundControllers) controller.abort(new Error('SuperLcm disposed'))
      this.backgroundControllers.clear()
      this.superLcmStore.close()
    })

    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'compaction/end') return
      try {
        const summaryEvent = committedCompactionSummary(session, event)
        if (summaryEvent !== null) {
          const node = indexCompactionEvent(this.superLcmStore, session, summaryEvent)
          this.superLcmStore.setIndexCursor(node.sessionId, event.seq)
        }
      } catch (error) {
        reportIndexFailure(error)
      }
    })

    this.watchVolatileConfig(ctx)
  }

  // dsh 0.1.7 迁移：原 installSection 的 onChange/validate 由这里承接。
  // volatile 字段变更时 Loader 会把新值提交进运行中的 fiber.config，
  // 并对本 fiber 发 loader/volatile-update；这里重读 config 派生运行参数。
  watchVolatileConfig(ctx) {
    ctx.on('loader/volatile-update', () => {
      try {
        this.applyRuntimeConfig(ctx.fiber?.config)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`[SuperLcm] 配置变更被拒绝 / rejected config change: ${message}`)
      }
    })
  }

  applyRuntimeConfig(config) {
    const raw = unwrapConfig(config)
    // 先做主路由校验（与旧版 validate 的报错顺序一致），再走 splitConfig
    // 的 fallback 完整性检查。
    const route = cleanRoute({
      provider: raw.summarizationProvider,
      model: raw.summarizationModel,
    })
    if (!routeIsComplete(route) || !routeIsConfigured(route)) {
      throw new Error('background compaction requires an explicit summarization provider and model')
    }
    const { rolling, fallbackRoute } = splitConfig(raw)
    if (!routeIsComplete(fallbackRoute)) {
      throw new Error('fallback summarization provider and model must be set together')
    }
    if (routeIsConfigured(fallbackRoute) && routesEqual(route, fallbackRoute)) {
      throw new Error('fallback summarization route must differ from the primary route')
    }
    if (rolling.pressureFoldTokens > rolling.foldBatchTokens) {
      throw new Error(`pressureFoldTokens (${rolling.pressureFoldTokens}) must not exceed foldBatchTokens (${rolling.foldBatchTokens})`)
    }
    if (rolling.hardActiveTokens <= rolling.softActiveTokens) {
      throw new Error(`hardActiveTokens (${rolling.hardActiveTokens}) must be greater than softActiveTokens (${rolling.softActiveTokens})`)
    }
    this.rollingConfig = rolling
    this.fallbackSummarizationRoute = fallbackRoute
    this.config = {
      ...this.config,
      summarizationProvider: route.provider,
      summarizationModel: route.model,
    }
  }

  async summarize(...args) {
    const metadata = args[3]
    const children = Array.isArray(metadata?.trustedChildNodeIds)
      ? [...new Set(metadata.trustedChildNodeIds)]
      : []
    const summarizeArgs = args.slice(0, 3)
    const primaryRoute = cleanRoute({
      provider: this.config?.summarizationProvider,
      model: this.config?.summarizationModel,
    })
    const fallbackRoute = cleanRoute(this.fallbackSummarizationRoute)

    const attempt = async (route) => {
      const receiver = route === null ? this : Object.assign(Object.create(this), {
        config: {
          ...this.config,
          summarizationProvider: route.provider,
          summarizationModel: route.model,
          modelPolicies: Array.isArray(this.config?.modelPolicies)
            ? this.config.modelPolicies.map((policy) => ({
                ...policy,
                summarizationProvider: route.provider,
                summarizationModel: route.model,
              }))
            : [],
        },
      })
      const result = await super.summarize.call(receiver, ...summarizeArgs)
      if (result === null || typeof result !== 'object' || !Array.isArray(result.summary)) {
        throw new TypeError('BasicCompactionEngine.summarize() returned an invalid summary result')
      }
      return result
    }

    let result
    try {
      result = await attempt(routeIsConfigured(primaryRoute) ? primaryRoute : null)
    } catch (primaryError) {
      const signal = summarizeArgs[2]
      if (signal?.aborted || !routeIsConfigured(fallbackRoute)) throw primaryError
      this.ctx.logger?.warn?.(
        `primary summarization route ${primaryRoute.provider}/${primaryRoute.model} failed; retrying once with fallback ${fallbackRoute.provider}/${fallbackRoute.model}`,
      )
      try {
        result = await attempt(fallbackRoute)
      } catch (fallbackError) {
        if (signal?.aborted) throw fallbackError
        throw new AggregateError(
          [primaryError, fallbackError],
          `primary and fallback summarization routes failed (${primaryRoute.provider}/${primaryRoute.model} -> ${fallbackRoute.provider}/${fallbackRoute.model})`,
        )
      }
    }

    const nodeId = randomUUID()
    return {
      ...result,
      summary: appendRecallEnvelope(result.summary, { id: nodeId, children }),
    }
  }

  _registerAutomaticCompaction() {
    if (this.rollingConfig === undefined) {
      queueMicrotask(() => this._registerAutomaticCompaction())
      return
    }
    if (this.rollingConfig.mode !== 'rolling') return super._registerAutomaticCompaction()
    this._registerRollingPressure()
    this._registerOverflowRecovery()
  }

  _registerRollingPressure() {
    const { ctx } = this
    ctx.on('agent/pre-step', ({ agent, signal }, next) => {
      if (signal.aborted) return next()
      this.tryCommitBackgroundFold(agent, { allowPressure: true })
      if (this.backgroundFolds.has(agent)) return next()

      try {
        const selection = this.planRolling(agent)
        if (selection !== null) this.startBackgroundFold(agent, selection)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`rolling selection failed: ${message}; continuing the turn`)
      }
      return next()
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.tryCommitBackgroundFold(agent)
    })
  }

  backgroundRouteConfigured() {
    const provider = cleanRouteValue(this.config?.summarizationProvider)
    const model = cleanRouteValue(this.config?.summarizationModel)
    if (provider.length > 0 && model.length > 0) return true
    if (!this.warnedMissingBackgroundRoute) {
      this.warnedMissingBackgroundRoute = true
      this.ctx.logger?.warn?.('SuperLcm background compaction requires an explicit summarizationRoute; refusing to fall back to the conversation model')
    }
    return false
  }

  prepareBackgroundSelection(agent, selection) {
    return prepareAsyncRegion(this, agent, selection)
  }

  summarizeBackgroundSelection(agent, prepared, signal) {
    return summarizeAsyncRegion(this, agent, prepared, signal)
  }

  commitBackgroundSelection(agent, summarized) {
    const result = commitAsyncRegion(this, agent, summarized)
    return result === null ? null : { ...result, rollingPolicy: summarized }
  }

  startBackgroundFold(agent, selection) {
    if (this.backgroundFolds.has(agent) || !this.backgroundRouteConfigured()) return false
    let prepared
    try {
      prepared = this.prepareBackgroundSelection(agent, selection)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger?.warn?.(`rolling compaction staging failed: ${message}; continuing`)
      return false
    }

    const controller = new AbortController()
    const state = { status: 'summarizing', selection, prepared, controller, promise: null, summarized: null }
    this.backgroundFolds.set(agent, state)
    this.backgroundControllers.add(controller)
    state.promise = this.summarizeBackgroundSelection(agent, prepared, controller.signal)
      .then((summarized) => {
        if (this.backgroundFolds.get(agent) !== state) return
        state.summarized = summarized
        state.status = 'ready'
      })
      .catch((error) => {
        if (this.backgroundFolds.get(agent) === state) this.backgroundFolds.delete(agent)
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger?.warn?.(`rolling compaction background summary failed: ${message}; continuing`)
      })
      .finally(() => this.backgroundControllers.delete(controller))
    return true
  }

  tryCommitBackgroundFold(agent, options = {}) {
    const state = this.backgroundFolds.get(agent)
    if (state?.status !== 'ready') return null
    if (options.force !== true && state.selection.reason === 'background-batch') {
      const activeTokens = options.allowPressure === true
        ? this.ctx.tokenMeter.measure(agent.session).totalTokens
        : 0
      if (activeTokens < this.rollingConfig.softActiveTokens) return null
    }
    try {
      const result = this.commitBackgroundSelection(agent, state.summarized)
      if (result === null) return null
      this.backgroundFolds.delete(agent)
      this.logFoldResult(this.ctx, result)
      return result
    } catch (error) {
      this.backgroundFolds.delete(agent)
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof AsyncSurfaceChangedError) {
        this.ctx.logger?.info?.(`rolling compaction prepared span changed; restaging later: ${message}`)
      } else {
        this.ctx.logger?.warn?.(`rolling compaction commit failed: ${message}; continuing`)
      }
      return null
    }
  }

  async settleBackgroundFold(agent) {
    const state = this.backgroundFolds.get(agent)
    if (state?.promise !== null && state?.promise !== undefined) await state.promise
  }

  logFoldResult(ctx, result) {
    if (result !== null && typeof result === 'object' && Array.isArray(result.shadowedSeqs)) {
      const policy = result.rollingPolicy
      const detail = policy === undefined
        ? ''
        : `, reason=${policy.reason}, active~${policy.activeTokens}, tail~${policy.tailTokens}`
      ctx.logger?.info?.(
        `compaction (rolling): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens${detail})`,
      )
    }
  }

  _registerOverflowRecovery() {
    const { ctx } = this
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== void 0) this.overflowRetries.delete(agent)
    })
    ctx.on('agent/request-error', ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= (this.config?.maxOverflowRetries ?? 1)) return next()
      const generation = agent.session.surface.replaceGeneration
      const result = this.tryCommitBackgroundFold(agent, { force: true })
      if (result !== null && agent.session.surface.replaceGeneration > generation) {
        this.overflowRetries.set(agent, retries + 1)
        return { kind: 'retry' }
      }
      if (!this.backgroundFolds.has(agent)) {
        try {
          const selection = this.planRolling(agent, false)
          if (selection !== null) this.startBackgroundFold(agent, selection)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`context-overflow background staging failed: ${message}`)
        }
      }
      ctx.logger?.warn?.('context overflow reached before the background summary was ready; preserving the request error without blocking')
      return next()
    })
  }

  planRolling(agent) {
    const session = agent.session
    const measurement = this.ctx.tokenMeter.measure(session)
    const options = {
      tailCount: this.rollingConfig.tailCount,
      minRetainTokens: this.rollingConfig.minRetainTokens,
      pressureFoldTokens: this.rollingConfig.pressureFoldTokens,
      foldBatchTokens: this.rollingConfig.foldBatchTokens,
      softActiveTokens: this.rollingConfig.softActiveTokens,
      hardActiveTokens: this.rollingConfig.hardActiveTokens,
      activeTokens: measurement.totalTokens,
      firstFoldableIndex: firstFoldableSurfaceIndex(session),
      isBalancedBefore: (seq) => toolPairingBalancedBefore(session, seq),
    }
    const selection = selectRollingRange(measurement.nodes, session.surface.nodes, options)
    if (selection !== null || measurement.totalTokens < this.rollingConfig.hardActiveTokens) return selection
    const systemEnd = systemPrefixEndIndex(session)
    if (options.firstFoldableIndex <= systemEnd) return null
    return selectRollingRange(measurement.nodes, session.surface.nodes, { ...options, firstFoldableIndex: systemEnd })
  }

  async commitRollingSelection(agent, selection) {
    this.startBackgroundFold(agent, selection)
    return null
  }

  async rollingMaintain(agent, _signal) {
    const selection = this.planRolling(agent)
    if (selection === null) return null
    this.startBackgroundFold(agent, selection)
    return null
  }

}

// 兼容旧版 SuperLcm、SuperLCM 与 dsh-lossless-context <= 0.2.x 的导出 / Compatibility exports for older SuperLcm, SuperLCM, and dsh-lossless-context <= 0.2.x.
export { SuperLcmCompactionEngine as SuperLCMCompactionEngine }
export { SuperLcmCompactionEngine as LosslessCompactionEngine }
export default SuperLcmCompactionEngine