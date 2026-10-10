import {existsSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {homedir} from 'node:os'
import {claudeTranscript} from './store.js'
import {buildHierarchy,summarySettingsRevision,summaryEstimate,summaryWork} from './summarize.js'
import {summarizeWith,writerTool,WRITER_CLI} from './cli-writers.js'
import {scheduleSummary} from './summary-scheduler.js'

export function generateBackground(store,session,setting,options={}) {
 const {mode,model,api_provider,api_url,effort,api_effort,oneOffApi}=setting
 if(mode==='api')return buildHierarchy(store,session,{model:model||process.env.SUPERLCM_CLAUDE_MODEL,apiKey:oneOffApi?oneOffApi.apiKey:store.apiCredential(session),apiProvider:api_provider||'anthropic',apiURL:api_url||process.env.SUPERLCM_CLAUDE_API_URL,effort:effort||api_effort||null,...options})
 const tool=writerTool(store.metadata(session).harness)
 if(!tool)throw Error('No installed tool can write summaries')
 const chosen=model||(tool==='claude-code'?process.env.SUPERLCM_CLAUDE_CLI_MODEL:tool==='codex'?process.env.SUPERLCM_CODEX_CLI_MODEL:'')||''
 return buildHierarchy(store,session,{model:`${WRITER_CLI[tool]}-cli:${chosen||'configured'}`,summarize:(text,call)=>summarizeWith(tool,text,{model:chosen,summaryTask:call.summaryTask,signal:call.signal}),...options})
}
// The first step can precede any Stop hook and even the first persisted prompt.
// Resolve only the main transcript with this exact ID under the native config root.
function firstTranscript(id,env) {
 if(!/^[a-zA-Z0-9_-]{1,200}$/.test(id))return null
 const root=join(env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),'projects'),found=[]
 if(!existsSync(root))return null
 for(const folder of readdirSync(root,{withFileTypes:true}))if(folder.isDirectory()){
  const file=join(root,folder.name,id+'.jsonl');if(existsSync(file))found.push(file)
 }
 return found.length===1?claudeTranscript(found[0],env):null
}
export function summaryTick(store,id,{env=process.env,spawnProcess}={}) {
 if(env.SUPERLCM_CLI_WORKER==='1'||!store.integrationEnabled('claude-code')||store.isDeleted(id))return {none:'disabled'}
 const source=store.source(id),file=source?.path||firstTranscript(id,env)
 if(!file||!existsSync(file))return {none:'not recorded yet'}
 if(source&&store.metadata(id).harness!=='claude-code')return {none:'different source harness'}
 store.ingest(id,file)
 if(!source)store.setMetadata(id,{harness:'claude-code',externalId:id})
 const setting=store.effectiveSetting(id,env),{mode,model}=setting
 if(['off','cli','api'].includes(mode))store.setSummaryMode(id,mode)
 const work=summaryWork(store,id),revision=summarySettingsRevision(store,id,env)
 if(!work||store.summaryRetry(id,work.batch_id,revision))return {none:'no eligible work'}
 if(mode==='cli'&&writerTool('claude-code',env)==='claude-code'){store.setHostWriter(id,true);return {host:true}}
 return {scheduled:scheduleSummary(store,id,mode,model,{env,...(spawnProcess?{spawnProcess}:{})})}
}
export const catchupDeadlineMs = (env=process.env) => {
 const n=env.SUPERLCM_CATCHUP_MS===undefined?75000:Number(env.SUPERLCM_CATCHUP_MS)
 return Number.isSafeInteger(n)&&n>=0?Math.min(n,240000):75000
}
export const pendingLeaves=(store,id)=>summaryEstimate(store,id).segments
export async function catchUp(store,id,{deadlineMs=catchupDeadlineMs(),maxPieces=4,generate=generateBackground}={}) {
 const deadline=Date.now()+deadlineMs,controller=new AbortController(),setting=store.effectiveSetting(id),revision=summarySettingsRevision(store,id)
 let timedOut=false
 const timer=setTimeout(()=>{timedOut=true;controller.abort(Error('Summary catch-up deadline reached'))},deadlineMs)
 const mayContinue=()=>!controller.signal.aborted&&Date.now()<deadline&&summarySettingsRevision(store,id)===revision
 let created=0
 try{
  while(mayContinue()&&created<maxPieces&&pendingLeaves(store,id)>0){
   if(store.summarizing(id)){await new Promise(r=>setTimeout(r,Math.min(100,Math.max(1,deadline-Date.now()))));continue}
   let expired
   const stop=new Promise(resolve=>{expired=()=>resolve(null);controller.signal.addEventListener('abort',expired,{once:true})})
   const run=Promise.resolve().then(()=>generate(store,id,setting,{signal:controller.signal,shouldContinue:mayContinue,leafOnly:true,maxPieces:maxPieces-created})).catch(()=>null)
   const result=await Promise.race([run,stop]);controller.signal.removeEventListener('abort',expired)
   if(!result)break
   created+=result.created||0
   if(result.stopped||!result.created)break
  }
 }finally{clearTimeout(timer);controller.abort(Error('Summary catch-up finished'))}
 return {created,elapsedMs:Math.max(0,deadlineMs-(deadline-Date.now())),expired:timedOut||Date.now()>=deadline}
}
