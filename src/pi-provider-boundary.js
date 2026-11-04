// Session-local instrumentation of Pi's effective provider, after the complete
// extension payload chain. No provider registration, credentials or settings change.
import { AsyncLocalStorage } from 'node:async_hooks'
import { clonePiPayload } from './pi-request.js'

const scope = new AsyncLocalStorage()
export const piAuxiliaryRequest = run => scope.run('auxiliary', run)
export const isPiAuxiliaryRequest = () => scope.getStore() === 'auxiliary'

export function piProviderBoundary(onRequest) {
  const installed = new Map()
  let armed = null, closed = false, generation = 0
  return {
    arm(ctx) {
      if (closed) throw Error('Pi 请求边界已关闭')
      armed = null; generation++
      const provider = ctx.modelRegistry?.getProvider?.(ctx.model?.provider)
      if (!provider || typeof provider.streamSimple !== 'function') throw Error('Pi 未提供可核验的请求边界，原文保留')
      if (!installed.has(provider) || provider.streamSimple !== installed.get(provider).wrapped) {
        const original = provider.streamSimple
        const wrapped = function(model, context, options = {}) {
          const current = armed
          if (closed || isPiAuxiliaryRequest() || !current || options.sessionId !== current.sessionId)
            return original.call(this, model, context, options)
          armed = null
          const check=()=>{
            options.signal?.throwIfAborted()
            if(closed||generation!==current.generation||current.ctx.sessionManager.getSessionId()!==current.sessionId)throw Error('Pi 请求所属会话已切换，原文保留')
          }
          const transform = options.onPayload
          if (typeof transform !== 'function') throw Error('Pi 主请求缺少完整处理链，原文保留')
          return original.call(this, model, context, {
            ...options,
            onPayload: async (value, actualModel) => {
              check()
              const raw = clonePiPayload(value)
              const final = (await transform(value, actualModel)) ?? value
              check()
              const replay = payload => piAuxiliaryRequest(async () => (await transform(payload, actualModel)) ?? payload)
              const result=await onRequest({ raw, payload: final, model, messages: context.messages, transformPayload: replay,
                requestHeaders: structuredClone(options.headers || {}), signal: options.signal }, current.ctx)
              check()
              return result
            },
          })
        }
        provider.streamSimple = wrapped
        installed.set(provider, { original, wrapped })
      }
      armed = {ctx,generation,sessionId:ctx.sessionManager.getSessionId()}
    },
    disarm() { armed = null; generation++ },
    close() {
      closed = true; armed = null; generation++
      for (const [provider, { original, wrapped }] of installed)
        if (provider.streamSimple === wrapped) provider.streamSimple = original
      installed.clear()
    },
  }
}
