import Basic from '@deepseek-ai/dsh-compaction-basic'
import Engine from './engine.js'
import { readControls } from './controls-config.js'
import { SuperLcmStore, resolveDatabasePath } from './store.js'
import { join } from 'node:path'

function cancellable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
    if (signal.aborted) cancel()
  })
}

// Mount the actual native implementation when takeover is off. In particular,
// do not reuse SuperLcm's summarizer or its private model adapter in this mode.
function owned(Base) {
  return class extends Base {
    operations = new Set()
    controllers = new Set()
    backgroundTasks = new Set()
    retiring = false
    operation(run, signal) {
      if (this.retiring) return Promise.reject(Error('压缩引擎正在切换'))
      const controller = new AbortController()
      this.controllers.add(controller)
      const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const result = Promise.resolve().then(() => { abort.throwIfAborted(); return run(abort) })
      this.operations.add(result)
      return result.finally(() => { this.controllers.delete(controller); this.operations.delete(result) })
    }
    compactRegion(start, end, agent, signal) {
      return this.operation(abort => super.compactRegion(start, end, agent, abort), signal)
    }
    compactNow(agent, signal, sourceCommandId) {
      return this.operation(abort => super.compactNow(agent, abort, sourceCommandId), signal)
    }
    async summarize(...args) {
      const signal = args[2]
      const result = await cancellable(super.summarize(...args), signal)
      // The host's automatic region path does not re-check cancellation after
      // its summarizer returns. A late adapter result must never get committed.
      signal?.throwIfAborted()
      return result
    }
    startBackgroundFold(...args) {
      if (this.retiring) return false
      const started = super.startBackgroundFold(...args)
      const task = started && this.backgroundFolds.get(args[0])?.promise
      if (task) { this.backgroundTasks.add(task); task.finally(() => this.backgroundTasks.delete(task)) }
      return started
    }
    async retire() {
      this.retiring = true
      for (const controller of this.controllers) controller.abort(Error('压缩引擎已切换'))
      for (const controller of this.backgroundControllers || []) controller.abort(Error('压缩引擎已切换'))
      await Promise.allSettled([...this.operations, ...this.backgroundTasks])
    }
  }
}
const Takeover = owned(Engine), Native = owned(Basic)

export async function mountCompactionOwner(ctx, config = {}) {
  let fiber, engine, handlers = new Map(), reporter, store, revision, closed = false, pending
  let invalidControls=false
  const current = () => {
    try {const document=readControls(config.controlFile);invalidControls=false;return document||(config.controlFile?{revision:'missing-controls',config:{auto:false},invalid:true}:{revision:'',config})}
    catch {
      if(!invalidControls)ctx.logger?.warn?.('压缩设置读取失败，保留 DSH 原生压缩保护')
      invalidControls=true
      return {revision:'invalid-controls',config:{auto:false},invalid:true}
    }
  }
  const initial = current()
  const nativeOptions = { summarizationProvider: '', summarizationModel: '', ...config.nativeConfigs?.[ctx.get?.('profileContext')?.name], auto: true }
  const {nativeConfigs,archiveOnly,...takeoverConfig}=config
  let enabled
  // Stable listeners dispatch to the current owner after a switch. Cordis
  // snapshots a waterfall's listeners before awaiting them, so registering
  // fresh host listeners during a transition would miss that very request.
  const events = ['agent/pre-step', 'agent/request-error', 'agent/status', 'session/event']
  async function dispatch(event, args, next) {
    await reload()
    const callbacks = [...(handlers.get(event) || [])]
    const step = index => callbacks[index] ? callbacks[index](...args, () => step(index + 1)) : next?.()
    return step(0)
  }
  ctx.on('agent/pre-step', (payload, next) => dispatch('agent/pre-step', [payload], next))
  ctx.on('agent/request-error', (payload, next) => dispatch('agent/request-error', [payload], next))
  // These notifications are synchronous; loading is serialized by pre-step
  // and request-error, and retiring owners cannot submit new work.
  ctx.on('agent/status', (...args) => { for (const cb of handlers.get('agent/status') || []) cb(...args) })
  ctx.on('session/event', (...args) => { for (const cb of handlers.get('session/event') || []) cb(...args) })
  async function mount(selected, options) {
    const listeners = new Map()
    const plugin = { inject: Basic.inject, apply(child) {
      const scoped = new Proxy(child, { get(target, key, receiver) {
        if (key !== 'on') return Reflect.get(target, key, receiver)
        return (event, callback, ...rest) => {
          if (!events.includes(event)) return child.on(event, callback, ...rest)
          const list = listeners.get(event) || []; list.push(callback); listeners.set(event, list)
          return () => { const at = list.indexOf(callback); if (at >= 0) list.splice(at, 1) }
        }
      } })
      engine = new selected(scoped, options)
    } }
    fiber = ctx.plugin(plugin)
    await fiber.await()
    if (!engine) throw Error('压缩引擎未能启动')
    await engine.summaryModelReady
    handlers = listeners
  }
  async function install(document) {
    if (fiber) {
      await engine?.retire()
      handlers = new Map()
      await fiber.dispose()
      reporter?.close(); store?.close(); reporter = store = null
    }
    if (closed) return
    enabled = document.config.auto !== false
    const selected = enabled ? Takeover : Native
    const options = enabled ? { ...takeoverConfig, ...document.config, controlFile: '' } : nativeOptions
    engine = null
    try { await mount(selected, options) }
    catch (error) {
      await fiber?.dispose()
      engine = null
      await mount(Native, nativeOptions)
      enabled = false
      ctx.logger?.warn?.('所选压缩引擎启动失败，已恢复 DSH 原生压缩')
      if (!document.config.auto) throw error
    }
    if (!enabled) {
      store = new SuperLcmStore(config.archiveHome ? join(config.archiveHome, 'lcm.sqlite') : resolveDatabasePath())
      reporter = store.compressionReporter({ kind: 'engine', profile: ctx.get?.('profileContext')?.name || null,
        enabled: false, routeReady: true, onError: () => ctx.logger?.warn?.('DSH 原生压缩状态写入失败') })
      if (document.config.auto === false&&!document.invalid) reporter.applied(document.revision)
    }
    if (enabled) engine.compressionReporter.applied(document.revision)
    // Remember failed documents too, without acknowledging them as applied.
    // Rebuilding the fallback on each error would reset its overflow budget.
    revision = document.revision
    ctx.logger?.info?.(enabled ? 'SuperLcm 接管压缩已启用' : 'SuperLcm 接管已关闭；DSH 原生自动压缩和溢出恢复已启用，使用当前会话模型')
  }
  await install(initial)
  function reload() {
    if (closed) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      while (!closed) {
        const document = current()
        if (document.revision === revision) return
        await install(document)
      }
    })().finally(() => { pending = null })
    return pending
  }
  const timer = config.controlFile ? setInterval(() => reload().catch(() => ctx.logger?.warn?.('压缩引擎切换未完成')), 1000) : null
  timer?.unref()
  ctx.effect(() => async () => {
    closed = true; clearInterval(timer)
    await pending?.catch(() => {})
    await engine?.retire()
    reporter?.close(); store?.close()
  })
  return { reload, get mode() { return enabled ? 'superlcm' : 'dsh-native' } }
}
