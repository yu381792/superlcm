import {existsSync,readdirSync,openSync,fstatSync,readSync,closeSync} from 'node:fs'
import {join} from 'node:path'
import {homedir} from 'node:os'
import {claudeTranscript} from './store.js'
import {buildHierarchy,summarySettingsRevision,summaryEstimate,summaryWork} from './summarize.js'
import {summarizeWith,writerTool,hostWriterTool,WRITER_CLI} from './cli-writers.js'
import {scheduleSummary,mainForkDue} from './summary-scheduler.js'
import {RECENT_CHARS} from './compaction.js'
import {claudeCompactAt} from './takeover.js'

// 缓存过期压缩: a prompt cache lives for its lifetime (1h or 5m) after the last request that read or wrote it.
// Past that, the next prompt writes the whole context to the cache again, so a takeover compaction then costs no
// cache: only the smaller packet is written. It is worth it from COLD_SHARE of the compaction window.
// Expiry is decided from evidence, never from a timer alone: the last main-thread response in the transcript, the
// lifetime its cache writes used, and every other request the module saw billed to the session (a fork by
// SuperLcm or another mod, such as a keep-warm ping; see hooks/compact-mod.js), saved with noteCacheTouch.
export const COLD_SHARE=.4, COLD_MARGIN_MS=120000
const HOUR=3600000,FIVE_MINUTES=300000
// The newest main-thread response in a transcript (rows may be appended out of order around a compaction), its
// context size, whether a compaction followed it, and the longest cache lifetime its responses wrote: a turn that
// writes only 5-minute entries leaves a prefix cached for an hour.
export function lastMainResponse(file,{tailBytes=4*1024*1024}={}) {
 let text
 try{
  const fd=openSync(file,'r')
  try{const size=fstatSync(fd).size,start=Math.max(0,size-tailBytes),buf=Buffer.alloc(size-start);readSync(fd,buf,0,buf.length,start);text=buf.toString('utf8')}
  finally{closeSync(fd)}
 }catch{return null}
 let at=0,tokens=0,boundary=0,ttl=null
 for(const line of text.split('\n')){
  if(!line.includes('"assistant"')&&!line.includes('compact_boundary'))continue
  let r;try{r=JSON.parse(line)}catch{continue}
  const ms=Date.parse(r.timestamp)
  if(r.isSidechain||!Number.isFinite(ms))continue
  if(r.type==='system'&&r.subtype==='compact_boundary'){boundary=Math.max(boundary,ms);continue}
  let u=r.type==='assistant'&&r.message?.model!=='<synthetic>'?r.message?.usage:null
  if(!u)continue
  const sum=x=>(x.input_tokens||0)+(x.cache_read_input_tokens||0)+(x.cache_creation_input_tokens||0)
  if(!sum(u)&&Array.isArray(u.iterations)&&u.iterations.length)u=u.iterations.at(-1)
  const wrote=u.cache_creation||{}
  if(wrote.ephemeral_1h_input_tokens>0)ttl=HOUR
  else if(wrote.ephemeral_5m_input_tokens>0)ttl??=FIVE_MINUTES
  if(ms<at)continue
  at=ms;tokens=sum(u)+(u.output_tokens||0)
 }
 return at?{at,tokens,compactedSince:boundary>at,ttl}:null
}
// When this session's main cache was last read, its lifetime, and when it runs out.
export function cacheExpiry(store,id) {
 const file=store.source(id)?.path,last=file&&lastMainResponse(file)
 if(!last)return null
 const seen=store.cacheTouch(id),touched=Math.max(last.at,seen?.at||0),ttl=last.ttl||HOUR
 return {...last,touched,ttl,expiresAt:touched+ttl+COLD_MARGIN_MS,tried:seen?.tried===last.at}
}
const compactionOff=(store,id,env)=>env.SUPERLCM_CLI_WORKER==='1'||!store.integrationEnabled('claude-code')||store.isDeleted(id)||store.metadata(id).harness!=='claude-code'?{none:'disabled'}
 :store.takeover().enabled?null:{none:'takeover off'}
export function coldCompactionDue(store,id,{env=process.env,tokens=0,window=0,touched=0,now=Date.now()}={}) {
 const off=compactionOff(store,id,env)
 if(off)return off
 const takeover=store.takeover()
 if(touched>0)store.noteCacheTouch(id,Math.min(touched,now))
 const cache=cacheExpiry(store,id)
 if(!cache)return {none:'no response yet'}
 if(cache.compactedSince)return {none:'already compacted'}
 // One that SuperLcm skipped is not tried again until the session is used again.
 if(cache.tried)return {none:'already tried'}
 if(now<cache.expiresAt)return {none:'cache still warm',dueAt:cache.expiresAt,ttl:cache.ttl}
 const limit=claudeCompactAt(takeover,window,env),size=Math.max(tokens,cache.tokens)
 return size>=limit*COLD_SHARE?{compact:true,tokens:size}:{none:'context small'}
}
// 回合末压缩: a takeover compaction inside a turn (Claude Code's threshold reached between tool calls, or a prompt
// too long) shows its packet in the Claude app as if the person typed it. Claude Code streams a module's packet to
// the app as a plain user message, and a module cannot mark it as the compaction summary, as Claude Code's own is.
// A /compact at a turn boundary goes to the app as a replay, which it does not draw. So when the next turn would
// likely cross the threshold (the context plus what the turn just ended added, at least END_ROOM of the
// threshold), the module compacts at the end of this one. A compaction still needed inside a turn is answered by
// the takeover as before.
export const END_ROOM=.15
export function endCompactionDue(store,id,{env=process.env,tokens=0,window=0,grew=0}={}) {
 const off=compactionOff(store,id,env)
 if(off)return off
 const limit=claudeCompactAt(store.takeover(),window,env)
 if(!(tokens>0)||!(limit>0))return {none:'no context size'}
 if(tokens<limit*COLD_SHARE)return {none:'context small'}
 return tokens+Math.max(grew,limit*END_ROOM)>=limit?{compact:true,tokens}:{none:'room for the next turn'}
}

export function flushUnderPressure(store,id,{env=process.env,tokens=0,window=0}={}) {
 const takeover=store.takeover(),limit=claudeCompactAt(takeover,window,env)
 if(!takeover.enabled||!Number.isFinite(tokens)||tokens<limit*.5)return false
 const estimate=summaryEstimate(store,id)
 if(estimate.segments||estimate.tail_chars<RECENT_CHARS/2)return false
 store.setSummaryFlush(id,store.db.prepare('SELECT MAX(ordinal) AS o FROM events WHERE session=?').get(id)?.o??-1)
 return true
}

export function generateBackground(store,session,setting,options={}) {
 const {mode,model,api_provider,api_url,effort,api_effort,oneOffApi}=setting
 if(mode==='api')return buildHierarchy(store,session,{model:model||process.env.SUPERLCM_CLAUDE_MODEL,apiKey:oneOffApi?oneOffApi.apiKey:store.apiCredential(session),apiProvider:api_provider||'anthropic',apiURL:api_url||process.env.SUPERLCM_CLAUDE_API_URL,effort:effort||api_effort||null,fallbacks:oneOffApi?[]:store.apiFallbacks(session),...options})
 const tool=writerTool(store.metadata(session).harness)
 if(!tool)throw Error('No installed tool can write summaries')
 const chosen=model||(tool==='claude-code'?process.env.SUPERLCM_CLAUDE_CLI_MODEL:tool==='codex'?process.env.SUPERLCM_CODEX_CLI_MODEL:'')||''
 return buildHierarchy(store,session,{model:`${WRITER_CLI[tool]}-cli:${chosen||'configured'}`,summarize:(text,call)=>summarizeWith(tool,text,{model:chosen,summaryTask:call.summaryTask,signal:call.signal}),...options})
}
// The first step can precede any Stop hook and even the first persisted prompt.
// Resolve only the main transcript with this exact ID under the native config root.
export function firstTranscript(id,env=process.env) {
 if(!/^[a-zA-Z0-9_-]{1,200}$/.test(id))return null
 const root=join(env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),'projects'),found=[]
 if(!existsSync(root))return null
 for(const folder of readdirSync(root,{withFileTypes:true}))if(folder.isDirectory()){
  const file=join(root,folder.name,id+'.jsonl');if(existsSync(file))found.push(file)
 }
 return found.length===1?claudeTranscript(found[0],env):null
}
// fork: the calling module can run $.model.fork, which reads the whole history from the main thread's cache.
export function summaryTick(store,id,{env=process.env,spawnProcess,tokens=0,window=0,fork=false}={}) {
 if(env.SUPERLCM_CLI_WORKER==='1'||!store.integrationEnabled('claude-code')||store.isDeleted(id))return {none:'disabled'}
 const source=store.source(id),file=source?.path||firstTranscript(id,env)
 if(!file||!existsSync(file))return {none:'not recorded yet'}
 if(source&&store.metadata(id).harness!=='claude-code')return {none:'different source harness'}
 if(store.ingest(id,file,'jsonl',{automatic:true}).skipped)return {none:'deleted'}
 if(!source)store.setMetadata(id,{harness:'claude-code',externalId:id})
 const setting=store.effectiveSetting(id,env),{mode,model}=setting
 if(['off','cli','api','main-fork'].includes(mode))store.setSummaryMode(id,mode)
 if(['cli','api'].includes(mode))flushUnderPressure(store,id,{env,tokens,window})
 if(mode==='main-fork'&&fork){
  store.setHostForker(id,true)
  return mainForkDue(store,id,{env,tokens,window})&&!store.summarizing(id)?{fork:true}:{none:'no eligible work'}
 }
 if(mode==='main-fork')return {scheduled:scheduleSummary(store,id,mode,null,{env,tokens,window,...(spawnProcess?{spawnProcess}:{})})}
 const work=summaryWork(store,id),revision=summarySettingsRevision(store,id,env)
 if(!work||store.summaryRetry(id,work.batch_id,revision))return {none:'no eligible work'}
 if(mode==='cli'&&hostWriterTool('claude-code',env)==='claude-code'){store.setHostWriter(id,true);return {host:true}}
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
