import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { summaryWork,summarySettingsRevision,summaryEstimate } from './summarize.js'
import { enqueueSummaryRun, reserveSummaryRun, finishSummaryRun, recoverSummaryRuns, summaryConcurrency, activeSummaryRun } from './summary-runs.js'

export function summaryQueueRevision(store,session,{backend=null,env=process.env}={}) {
  return createHash('sha256').update(JSON.stringify([summarySettingsRevision(store,session,env),backend,backend==='api'?store.apiConfig(session,env):null])).digest('hex')
}
export function enqueueSummary(store,session,{backend=null,mode,model,origin='manual',env=process.env}={}) {
  recoverSummaryRuns(store,{env})
  if(!store.source(session)||store.isDeleted(session))throw Error('Unknown conversation')
  const explicit=backend!==null,chosen=store.effectiveSetting(session,env)
  mode=backend||mode||chosen.mode
  if(!['cli','api'].includes(mode))throw Error('Background summaries are disabled for this session')
  if(!explicit&&!store.integrationEnabled(store.metadata(session).harness))throw Error('Integration is disconnected')
  const api=explicit&&mode==='api'?store.apiConfig(session,env):null
  if(explicit&&mode==='api'&&!api)throw Error('No saved custom API; configure one in Settings first')
  model=api?.model||model||(mode===chosen.mode?chosen.model:null)||env.SUPERLCM_CLAUDE_MODEL||null
  if(mode==='api'&&(!model||(!api&&store.apiCredential(session,env)===null))){store.setStatus(session,'summary_unconfigured');return {added:false,unconfigured:true}}
  const work=summaryWork(store,session)
  if(!work)return {added:false,none:true}
  if(!['manual','bulk'].includes(origin)&&store.summaryRetry(session,work.batch_id,summarySettingsRevision(store,session,env)))return {added:false,cooldown:true}
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const active=activeSummaryRun(store,session)
    if(['manual','bulk'].includes(origin)&&active?.route==='host'&&active.state==='queued')finishSummaryRun(store,active.id,{state:'stopped',reason:'manual-takeover'})
    const result=enqueueSummaryRun(store,session,{backend:explicit?backend:null,model,origin,revision:summaryQueueRevision(store,session,{backend,env}),planned:summaryEstimate(store,session).calls})
    store.db.exec('COMMIT');return result
  }catch(error){store.db.exec('ROLLBACK');throw error}
}
export function drainSummaryQueue(store,{env=process.env,spawnProcess=spawn}={}) {
  recoverSummaryRuns(store,{env})
  let started=0
  for(let n=0;n<100;n++){
    const run=reserveSummaryRun(store,{limit:summaryConcurrency(env)})
    if(!run)break
    if(store.isDeleted(run.session)||(!run.backend&&!store.integrationEnabled(store.metadata(run.session).harness))||run.revision!==summaryQueueRevision(store,run.session,{backend:run.backend,env})){
      finishSummaryRun(store,run.id,{state:'stopped',reason:'settings-changed'});continue
    }
    const flags=['--run',run.id,...(run.backend?['--backend',run.backend]:[])]
    const setting=store.effectiveSetting(run.session,env)
    const options={detached:true,windowsHide:true,stdio:'ignore',env:{...env,SUPERLCM_HOME:store.dir,SUPERLCM_HOOK_WORKER:run.backend?'0':'1',SUPERLCM_SUMMARY_RUN_ID:run.id,SUPERLCM_SUMMARY_EXPECTED_MODE:setting.mode,SUPERLCM_SUMMARY_EXPECTED_MODEL:setting.model||''}}
    let child
    try{
      child=spawnProcess(process.execPath,[fileURLToPath(new URL('./cli.js',import.meta.url)),'summarize',run.session,...flags],options)
      if(Number.isSafeInteger(child.pid))store.db.prepare("UPDATE summary_runs SET pid=? WHERE id=? AND state='starting'").run(child.pid,run.id)
      const settle=(state,kind)=>{
        const fresh=new store.constructor(store.dir)
        try{
          const row=fresh.db.prepare('SELECT * FROM summary_runs WHERE id=?').get(run.id)
          if(row&&['starting','running'].includes(row.state)){
            finishSummaryRun(fresh,run.id,{state,reason:kind,detail:{kind,message:kind==='spawn'?'Summary worker could not start; retry manually after checking configuration.':'Summary worker exited before completing; retry manually or after the next turn.'}})
            if(row.owner)fresh.release(row.session,row.owner)
          }
          drainSummaryQueue(fresh,{env,spawnProcess})
        }finally{fresh.close()}
      }
      child.once?.('error',()=>settle('failed','spawn'))
      child.once?.('exit',()=>settle('lost','worker_lost'))
      child.unref?.();started++
    }catch(error){finishSummaryRun(store,run.id,{state:'failed',error:Object.assign(Error('Summary worker could not start'),{summaryKind:'spawn'})})}
  }
  return {started}
}
// Only live, settled turns call this; imports and startup replay never do.
export function scheduleSummary(store,session,mode,model,{env=process.env,spawnProcess=spawn}={}) {
  if(!store.integrationEnabled(store.metadata(session).harness)||!['cli','api'].includes(mode)||store.summarizing(session))return false
  if(mode==='cli'&&store.hostWriter(session))return false
  if(mode==='api'&&(!(model||env.SUPERLCM_CLAUDE_MODEL)||store.apiCredential(session,env)===null)) {
    store.setStatus(session,'summary_unconfigured');process.stderr.write('SuperLcm: api mode needs a model ID and a configured scoped API key\n');return false
  }
  const result=enqueueSummary(store,session,{mode,model,origin:'hook',env})
  if(result.added)drainSummaryQueue(store,{env,spawnProcess})
  return result.added
}
