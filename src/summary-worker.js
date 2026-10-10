import { buildHierarchy } from './summarize.js'
import { summarizeWith, writerTool, WRITER_CLI } from './cli-writers.js'
import { enqueueSummary, summaryQueueRevision } from './summary-scheduler.js'
import { reserveSummaryRun, finishSummaryRun, summaryConcurrency, enqueueSummaryRun } from './summary-runs.js'

export async function runSummaryWorker(store,session,{runId=null,backend=null,env=process.env}={}) {
  let run
  try {
    if(!runId){
      const origin=env.SUPERLCM_HOOK_WORKER==='1'?'hook':'manual',setting=store.effectiveSetting(session,env)
      if(origin==='hook'&&((env.SUPERLCM_SUMMARY_EXPECTED_MODE!==undefined&&env.SUPERLCM_SUMMARY_EXPECTED_MODE!==setting.mode)||(env.SUPERLCM_SUMMARY_EXPECTED_MODEL!==undefined&&env.SUPERLCM_SUMMARY_EXPECTED_MODEL!==(setting.model||'')))){
        const rejected=enqueueSummaryRun(store,session,{origin,model:setting.model,revision:summaryQueueRevision(store,session,{env})})
        if(rejected.added)finishSummaryRun(store,rejected.run.id,{state:'stopped',reason:'expected-settings-changed'})
        return {session,created:0,stopped:'expected-settings-changed'}
      }
      const queued=enqueueSummary(store,session,{backend,origin,env})
      if(!queued.run)return {session,created:0,stopped:queued.cooldown?'retry-backoff':queued.unconfigured?'unconfigured':'no-work'}
      if(!queued.added)return {session,busy:true,run_id:queued.run.id}
      runId=queued.run.id
      if(!reserveSummaryRun(store,{id:runId,limit:summaryConcurrency(env)}))return {session,queued:true,run_id:runId}
    }
    run=store.db.prepare('SELECT * FROM summary_runs WHERE id=? AND session=?').get(runId,session)
    if(!run||run.state!=='starting')return {session,stopped:'run-replaced'}
    backend=run.backend
    if(run.revision!==summaryQueueRevision(store,session,{backend,env}))throw Object.assign(Error('Summary settings changed before worker started'),{summaryKind:'cancelled'})
    const api=backend==='api'?store.apiConfig(session,env):null
    const setting=api?{mode:'api',...api}:backend?{mode:backend,model:run.model}:store.effectiveSetting(session,env)
    if(!backend&&!store.integrationEnabled(store.metadata(session).harness))throw Object.assign(Error('Summary integration cancelled'),{summaryKind:'cancelled'})
    if(!['api','cli'].includes(setting.mode))throw Object.assign(Error('Summary settings changed; background writing stopped'),{summaryKind:'cancelled'})
    const shouldContinue=()=>summaryQueueRevision(store,session,{backend,env})===run.revision
    const controller=new AbortController(),cancel=()=>controller.abort(Object.assign(Error('Summary worker cancelled'),{summaryKind:'cancelled'}))
    process.once('SIGTERM',cancel);process.once('SIGINT',cancel)
    try {
      const options={runId,shouldContinue,signal:controller.signal,retryFailed:run.origin==='manual'||run.origin==='bulk'}
      if(setting.mode==='api')return await buildHierarchy(store,session,{...options,model:setting.model||env.SUPERLCM_CLAUDE_MODEL,apiKey:api?api.apiKey:store.apiCredential(session,env),apiProvider:setting.api_provider||'anthropic',apiURL:setting.api_url||env.SUPERLCM_CLAUDE_API_URL,effort:setting.effort||setting.api_effort||null})
      const tool=writerTool(store.metadata(session).harness,env)
      if(!tool)throw Object.assign(Error('No configured summary executable'),{summaryKind:'spawn'})
      const chosen=setting.model||(tool==='claude-code'?env.SUPERLCM_CLAUDE_CLI_MODEL:tool==='codex'?env.SUPERLCM_CODEX_CLI_MODEL:'')||''
      return await buildHierarchy(store,session,{...options,model:`${WRITER_CLI[tool]}-cli:${chosen||'configured'}`,summarize:(text,call)=>summarizeWith(tool,text,{model:chosen,summaryTask:call.summaryTask,signal:call.signal})})
    }finally{process.removeListener('SIGTERM',cancel);process.removeListener('SIGINT',cancel)}
  }catch(error){
    if(runId)finishSummaryRun(store,runId,{state:error.summaryKind==='cancelled'?'stopped':'failed',error})
    throw error
  }
}
