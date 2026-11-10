import {currentPolicy} from './ratio-runtime.js'
import {locateStableSpan} from './async-region.js'
import {summaryFailureCode} from './summary-session.js'

export function waitForRetry(ms,signal) {
  signal.throwIfAborted()
  return new Promise((resolve,reject)=>{
    const finish=(fn,value)=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);fn(value)}
    const cancel=()=>finish(reject,signal.reason)
    const timer=setTimeout(()=>finish(resolve),ms)
    signal.addEventListener('abort',cancel,{once:true})
    if(signal.aborted)cancel()
  })
}

export const terminalForkFailure = error => ['SUPERLCM_FORK_CAPACITY','SUPERLCM_FORK_INVALID_OUTPUT'].includes(error?.code)

export function failureKind(error) {
  if(error?.summaryKind==='timeout'||error?.name==='TimeoutError')return 'timeout'
  if(error?.code==='SUPERLCM_FORK_CAPACITY')return 'capacity'
  if(error?.code==='SUPERLCM_FORK_INVALID_OUTPUT')return 'invalid_output'
  if(error?.summaryKind==='length'||error?.code==='SUPERLCM_FORK_SUMMARY_BUDGET')return 'length'
  if(['stream_cutoff','stream_empty'].includes(error?.summaryKind))return error.summaryKind
  const code=summaryFailureCode(error?.code)
  if(code)return code.toLowerCase()
  if(error instanceof SyntaxError)return 'invalid_json'
  return 'invalid_summary'
}

// Recoverable failures keep one frozen request and use cancellable backoff.
// A capacity failure after all safe cuts are exhausted cannot improve by retrying.
export async function retryFork(engine,agent,state,policy,run) {
  const signal=state.controller.signal
  const assertCurrent=()=>{
    signal.throwIfAborted()
    if(engine.backgroundFolds.get(agent)!==state||engine.runtimeGeneration!==state.generation
      ||!engine.config.auto||currentPolicy(engine,agent)?.signature!==state.signature){
      state.controller.abort(Error('后台摘要的来源或配置已变化'))
      signal.throwIfAborted()
    }
    try{locateStableSpan(engine,agent.session,state.prepared)}
    catch(error){state.controller.abort(error);signal.throwIfAborted()}
  }
  state.attempt=0;state.failures=0
  for(;;){
    assertCurrent()
    state.attempt++;state.status='summarizing';state.retryAt=null;state.errorKind=null
    engine.compressionReporter.report(agent.session.id,'summarizing',{...state.selection,attempt:state.attempt,failures:state.failures})
    try{return await run({attempt:state.attempt,previousFailure:state.lastErrorKind})}
    catch(error){
      assertCurrent()
      state.failures++;state.errorKind=failureKind(error);state.lastErrorKind=state.errorKind
      if (terminalForkFailure(error)) { state.status='failed'; throw error }
      state.status='retrying'
      const delay=Math.min(300000,policy.summaryRetryCooldownMs*2**Math.min(4,state.failures-1))
      state.retryAt=Date.now()+delay
      engine.compressionReporter.report(agent.session.id,'retrying',{...state.selection,attempt:state.attempt,failures:state.failures,retryAt:state.retryAt,errorKind:state.errorKind})
      engine.ctx.logger?.warn?.(`后台分支摘要第 ${state.attempt} 次未完成（${state.errorKind}），${Math.ceil(delay/1000)} 秒后自动重试；原文保留`)
      await waitForRetry(delay,signal)
    }
  }
}
