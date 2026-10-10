import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { summaryWork,summarySettingsRevision } from './summarize.js'

const starting=new Map()
// Only live, settled turns call this; imports and startup replay never do.
export function scheduleSummary(store,session,mode,model,{env=process.env,spawnProcess=spawn}={}) {
  if(!store.integrationEnabled(store.metadata(session).harness)||!['cli','api'].includes(mode)||store.summarizing(session))return false
  if(mode==='cli'&&store.hostWriter(session))return false
  if(mode==='api'&&(!(model||env.SUPERLCM_CLAUDE_MODEL)||store.apiCredential(session,env)===null)) {
    store.setStatus(session,'summary_unconfigured');process.stderr.write('SuperLcm: api mode needs a model ID and a configured scoped API key\n');return false
  }
  const key=store.dir+'\0'+session
  const work=summaryWork(store,session)
  if(Date.now()-(starting.get(key)||0)<10000||!work||store.summaryRetry(session,work.batch_id,summarySettingsRevision(store,session,env)))return false
  starting.set(key,Date.now())
  const child=spawnProcess(process.execPath,[fileURLToPath(new URL('./cli.js',import.meta.url)),'summarize',session],{
    detached:true,windowsHide:true,stdio:'ignore',env:{...env,SUPERLCM_HOME:store.dir,SUPERLCM_HOOK_WORKER:'1',SUPERLCM_SUMMARY_EXPECTED_MODE:mode,SUPERLCM_SUMMARY_EXPECTED_MODEL:model||''}
  })
  child.on('error',()=>starting.delete(key));child.once('exit',()=>starting.delete(key));child.unref();return true
}
