import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { pressureStep } from './ratio-runtime.js'
import { SessionFoldRegistry } from './summary-guards.js'

const REBUILD = 'SUPERLCM_REQUEST_REBUILD'
export function nativePreStep(engine, payload) {
  if (!Array.isArray(payload.messages)) return false
  engine.requestAgents ??= new Map()
  engine.requestAgents.set(payload.agent.session.id,new WeakRef(payload.agent))
  return true
}
// The real host admits new input and logs its resolved header AFTER pre-step.
// Check that final request at the documented llm/stream middleware boundary.
// A replaced surface requires one local admission retry: no adapter call is
// made for the stale frozen request and the host rebuilds it from the archive.
export function registerRequestBoundary(engine) {
  const pending = new SessionFoldRegistry()
  engine.ctx.on('llm/stream',(options,next)=>{
    const agent=engine.requestAgents?.get(options.sessionId)?.deref()
    if (!agent || !engine.config.auto || !isAgentLoopRequest(options)) return next()
    return (async function* () {
      const generation=agent.session.surface.replaceGeneration
      await pressureStep(engine,agent,options.signal)
      if (agent.session.surface.replaceGeneration!==generation) {
        pending.set(agent,agent.session.surface.replaceGeneration)
        yield {type:'finish',reason:{kind:'error',failure:{code:REBUILD,message:'摘要已提交，重新组装本次请求'}}}
        return
      }
      yield* next()
    })()
  })
  engine.ctx.on('agent/request-error',({agent,failure,signal},next)=>{
    if (engine.config.auto && !signal.aborted && failure.code===REBUILD && pending.get(agent)===agent.session.surface.replaceGeneration) {
      pending.delete(agent)
      return {kind:'retry'}
    }
    return next()
  })
  engine.ctx.effect(()=>()=>engine.requestAgents?.clear())
}
