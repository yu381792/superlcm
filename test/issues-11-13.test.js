import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {DatabaseSync} from 'node:sqlite'
import {runInNewContext} from 'node:vm'
import {ClaudeStore} from '../src/store.js'
import {codexHeadless} from '../src/codex.js'
import {enqueueSummary,scheduleSummary,drainSummaryQueue} from '../src/summary-scheduler.js'
import {enqueueSummaryRun,reserveSummaryRun,bindSummaryRun,finishSummaryRun,progressSummaryRun,recoverSummaryRuns,summaryConcurrency} from '../src/summary-runs.js'
import {summaryHealth} from '../src/summary-health.js'
import {buildHierarchy,summaryWork,summarySettingsRevision} from '../src/summarize.js'
import {catchUp} from '../src/summary-background.js'
import {startWeb} from '../src/web.js'
import {runSummaryWorker} from '../src/summary-worker.js'

process.env.SUPERLCM_SEGMENT_MESSAGES='2'
const safeEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^SUPERLCM_|^CLAUDE_CONFIG_DIR$|^CODEX_HOME$|(?:API_KEY|TOKEN|SECRET|CREDENTIAL)/.test(k)))
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
const summary='# Synthetic state\nThe user authorized a dry run. The synthetic task remains pending approval.'
function fixture(t,n=1){
 const dir=mkdtempSync(join(tmpdir(),'superlcm-11-13-')),store=new ClaudeStore(join(dir,'store'))
 const env={...safeEnv(),HOME:dir,USERPROFILE:dir,SUPERLCM_HOME:store.dir,SUPERLCM_SEGMENT_MESSAGES:'2',SUPERLCM_CLAUDE_CLI_BIN:process.execPath,CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex')}
 store.setHarnessSetting('claude-code','cli','synthetic-host')
 const add=(id,{headless=false,harness='claude-code',header=null}={})=>{
  const file=join(dir,id+'.jsonl'),rows=Array.from({length:6},(_,i)=>({role:i%2?'assistant':'user',content:'Synthetic dry-run progress '+i}))
  writeFileSync(file,[...(header?[header]:[]),...rows].map(JSON.stringify).join('\n')+'\n')
  store.ingest(id,file);store.setMetadata(id,{harness,externalId:id,name:'Synthetic '+id,nameSource:'manual',...(header?{}:{headless})});return file
 }
 for(let i=0;i<n;i++)add('s'+i)
 t.after(()=>store.close())
 const children=[],spawnProcess=(...args)=>{const child=Object.assign(new EventEmitter(),{pid:process.pid,args,unref(){}});children.push(child);return child}
 const cli=(command,id='s0',input={},flags=[])=>{const r=spawnSync(process.execPath,['src/cli.js',command,id,...flags],{env,input:JSON.stringify(input),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)}
 return {dir,store,env,add,children,spawnProcess,cli}
}
function startRun(store,id,owner='synthetic-owner',options={}){
 const run=enqueueSummaryRun(store,id,options).run;assert.ok(reserveSummaryRun(store,{id:run.id}));assert.ok(bindSummaryRun(store,run.id,{owner,pid:process.pid}));assert.ok(store.lease(id,300000,owner));return run
}
async function webFixture(t,f){
 const web=await startWeb({store:new ClaudeStore(f.store.dir),env:f.env,spawnWorker:f.spawnProcess,discovery:async()=>[],catalog:async()=>({models:[]})})
 t.after(()=>web.close())
 const get=path=>fetch(web.url+path).then(r=>r.json())
 const post=async(path,body)=>{const r=await fetch(web.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()}}
 return {web,get,post}
}
function detailPage(detail,{request=async()=>({}),refresh=async()=>{}}={}){
 const code=readFileSync(new URL('../src/web-client.js',import.meta.url),'utf8'),elements=new Map(),calls=[],views=[]
 const node=(html='')=>({innerHTML:html,cache:new Map(),children:new Map(),classList:{remove(){}},querySelector(selector){
  if(!this.children.has(selector))this.children.set(selector,node());return this.children.get(selector)
 },querySelectorAll(selector){
  if(!['[data-generate]','[data-goto]','[data-b]'].includes(selector))return []
  const attribute=selector.slice(1,-1),html=selector==='[data-b]'&&this.children.get('#genOpts')?.innerHTML||this.innerHTML,key=selector+'\n'+html
  if(!this.cache.has(key)){
   const buttons=[]
   for(const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)){
    if(!new RegExp('\\b'+attribute+'(?:=|\\s|$)').test(match[1]))continue
    const dataset={};for(const data of match[1].matchAll(/data-([a-z]+)="([^"]*)"/g))dataset[data[1]]=data[2]
    buttons.push({dataset,textContent:match[2],disabled:false})
   }
   this.cache.set(key,buttons)
  }
  return this.cache.get(key)
 }})
 const element=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id)}
 const context={state:{sel:detail.source.session,detail,open:new Set(),children:new Map()},$:element,esc:String,fmt:String,t:(key,p={})=>key.replace(/\{([^}]+)\}/g,(_,k)=>p[k]),toolName:()=> 'Claude',ago:()=> '刚刚',mark:()=>'',TRASH:'',stripHtml:()=>'',nodeHtml:()=>'<div>Synthetic saved summary</div>',openRename(){},openContinue(){},openDelete(){},show:view=>views.push(view),settingsSection:section=>views.push(section),act:fn=>fn(),loadDetail:async()=>{await refresh(context)},api:async(path,body)=>{calls.push({path,body});return request(path,body)},overlay:(html,bind)=>{context.modal=node(html);bind(context.modal)},closeOverlay:()=>{context.modal=null}}
 const program=code.slice(code.indexOf('const SUMMARY_LABELS='),code.indexOf('\nasync function api('))+'\n'+code.slice(code.indexOf('const BACKENDS ='),code.indexOf('function nodeHtml('))+'\n'+code.slice(code.indexOf('function bindDetail()'),code.indexOf('// Follow child identities:'))+'\nrenderDetail()'
 runInNewContext(program,context)
 return {context,calls,views,html:()=>element('#detail').innerHTML,generate:()=>element('#detail').querySelectorAll('[data-generate]'),settings:()=>element('#detail').querySelectorAll('[data-goto]'),render:()=>runInNewContext('renderDetail()',context)}
}
const queuedHostDetail=({saved=false,backends=['api'],route='host',state='queued',summarizing=true}={})=>({source:{session:'s0',harness:'claude-code',name:'Synthetic',code:'abc'},records:6,summarized_to:saved?2:0,summary_count:saved?1:0,nodes:saved?[{id:'synthetic',summary}]:[],bands:[],setting:{mode:'cli'},backends,writer_tool:'claude-code',estimate:{calls:3,records:6},summary_health:{state,active:true,run:{route,state,created_parts:0,planned_parts:3,current_first:null,model:'fake',queued_ms:Date.now()}},summarizing})

test('one durable queue deduplicates sessions and admits at most three workers',t=>{
 const f=fixture(t,6)
 for(let i=0;i<6;i++)assert.equal(scheduleSummary(f.store,'s'+i,'cli','synthetic-host',{env:f.env,spawnProcess:f.spawnProcess}),true)
 assert.equal(f.children.length,3);assert.equal(f.store.db.prepare("SELECT count(*) n FROM summary_runs WHERE state='queued'").get().n,3)
 assert.equal(scheduleSummary(f.store,'s0','cli','synthetic-host',{env:f.env,spawnProcess:f.spawnProcess}),false)
 assert.equal(f.children.length,3);assert.equal(summaryConcurrency({}),3);assert.equal(summaryConcurrency({SUPERLCM_SUMMARY_CONCURRENCY:'0'}),3)
})

test('independent processes compete atomically for the same global capacity and session',async t=>{
 const f=fixture(t,8),script=join(f.dir,'compete.mjs')
 writeFileSync(script,`import {ClaudeStore} from ${JSON.stringify(new URL('../src/store.js',import.meta.url).href)};import {enqueueSummaryRun,reserveSummaryRun} from ${JSON.stringify(new URL('../src/summary-runs.js',import.meta.url).href)};const s=new ClaudeStore(process.argv[2]);const q=enqueueSummaryRun(s,process.argv[3]);const reserved=reserveSummaryRun(s,{id:q.run.id});console.log(JSON.stringify({added:q.added,reserved:!!reserved}));s.close()`)
 const run=id=>new Promise((resolve,reject)=>{let out='',err='';const c=spawn(process.execPath,[script,f.store.dir,id],{env:f.env,stdio:['ignore','pipe','pipe']});c.stdout.on('data',x=>out+=x);c.stderr.on('data',x=>err+=x);c.once('error',reject);c.once('exit',code=>code?reject(Error(err)):resolve(JSON.parse(out)))})
 const rows=await Promise.all(Array.from({length:8},(_,i)=>run('s'+i)))
 assert.equal(rows.filter(x=>x.reserved).length,3)
 const same=await Promise.all(Array.from({length:6},()=>run('s7')))
 assert.equal(same.filter(x=>x.added).length,0)
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM summary_runs WHERE session='s7'").get().n,1)
})

test('interactive work precedes headless work and a waiting host does not starve headless workers',t=>{
 const f=fixture(t,1);f.add('headless',{headless:true});f.add('waiting-host')
 enqueueSummary(f.store,'headless',{env:f.env});enqueueSummary(f.store,'s0',{env:f.env});enqueueSummaryRun(f.store,'waiting-host',{route:'host',revision:summarySettingsRevision(f.store,'waiting-host',f.env)})
 drainSummaryQueue(f.store,{env:{...f.env,SUPERLCM_SUMMARY_CONCURRENCY:'1'},spawnProcess:f.spawnProcess})
 assert.equal(f.children[0].args[1][2],'s0')
 finishSummaryRun(f.store,f.store.latestSummaryRun('s0').id,{state:'done'})
 drainSummaryQueue(f.store,{env:{...f.env,SUPERLCM_SUMMARY_CONCURRENCY:'1'},spawnProcess:f.spawnProcess})
 assert.equal(f.children[1].args[1][2],'headless');assert.equal(f.store.latestSummaryRun('waiting-host').state,'queued')
})

test('synchronous spawn failure and early child exit persist safe terminal states',t=>{
 const f=fixture(t,2)
 enqueueSummary(f.store,'s0',{env:f.env});drainSummaryQueue(f.store,{env:f.env,spawnProcess:()=>{throw Error('SECRET synthetic upstream text')}})
 assert.equal(f.store.latestSummaryRun('s0').state,'failed');assert.equal(f.store.latestSummaryRun('s0').error_kind,'spawn');assert.doesNotMatch(f.store.summaryError('s0'),/SECRET/)
 enqueueSummary(f.store,'s1',{env:f.env});drainSummaryQueue(f.store,{env:f.env,spawnProcess:f.spawnProcess});f.children[0].emit('exit',1)
 assert.equal(f.store.latestSummaryRun('s1').state,'lost');assert.equal(summaryHealth(f.store,'s1').needs_attention,true)
})

test('child callbacks reopen a closed parent store and cannot mark a newer run failed',t=>{
 const f=fixture(t),parent=new ClaudeStore(f.store.dir)
 enqueueSummary(parent,'s0',{env:f.env});drainSummaryQueue(parent,{env:f.env,spawnProcess:f.spawnProcess});const old=parent.latestSummaryRun('s0')
 parent.close();finishSummaryRun(f.store,old.id,{state:'lost'})
 const newer=startRun(f.store,'s0','new-owner');finishSummaryRun(f.store,newer.id,{owner:'new-owner',state:'done'});f.store.release('s0','new-owner')
 f.children[0].emit('error',Error('SECRET'));f.children[0].emit('exit',1)
 assert.equal(f.store.latestSummaryRun('s0').id,newer.id);assert.equal(f.store.latestSummaryRun('s0').state,'done');assert.equal(f.store.source('s0').status,'ok')
})

test('restart recovery frees dead and overdue starting reservations without losing queued work',t=>{
 const f=fixture(t,3)
 const a=enqueueSummaryRun(f.store,'s0').run,b=enqueueSummaryRun(f.store,'s1').run;enqueueSummary(f.store,'s2',{env:f.env})
 reserveSummaryRun(f.store,{id:a.id});reserveSummaryRun(f.store,{id:b.id})
 f.store.db.prepare('UPDATE summary_runs SET pid=? WHERE id=?').run(987654321,a.id);f.store.db.prepare('UPDATE summary_runs SET heartbeat_ms=0,pid=? WHERE id=?').run(process.pid,b.id)
 assert.equal(recoverSummaryRuns(f.store,{isAlive:pid=>pid===process.pid}),2)
 drainSummaryQueue(f.store,{env:f.env,spawnProcess:f.spawnProcess});assert.equal(f.children.length,1);assert.equal(f.children[0].args[1][2],'s2')
})

test('live or reused PID with expired or replaced lease releases capacity after bounded grace',t=>{
 const f=fixture(t,2),a=startRun(f.store,'s0','old-owner'),b=startRun(f.store,'s1','other-old')
 f.store.release('s0','old-owner');f.store.release('s1','other-old');f.store.lease('s1',300000,'replacement')
 const now=Date.now();f.store.db.prepare('UPDATE summary_runs SET heartbeat_ms=? WHERE id IN (?,?)').run(now,a.id,b.id)
 assert.equal(recoverSummaryRuns(f.store,{now:now+100,isAlive:()=>true}),0)
 assert.equal(recoverSummaryRuns(f.store,{now:now+31000,isAlive:()=>true}),2)
 assert.equal(f.store.ownsLease('s1','replacement'),true);assert.equal(f.store.latestSummaryRun('s0').state,'lost')
})

test('terminal status and safe diagnostics stay atomic against a competing connection',t=>{
 const f=fixture(t),other=new ClaudeStore(f.store.dir);t.after(()=>other.close());other.db.exec('PRAGMA busy_timeout=0')
 const old=startRun(f.store,'s0','old'),setStatus=f.store.setStatus.bind(f.store);let contended=false
 f.store.setStatus=(id,status)=>{assert.equal(f.store.db.isTransaction,true);assert.throws(()=>enqueueSummaryRun(other,id),/locked/);contended=true;return setStatus(id,status)}
 finishSummaryRun(f.store,old.id,{owner:'old',state:'failed',detail:{kind:'transport',message:'Synthetic old failure'}})
 f.store.setStatus=setStatus;assert.equal(contended,true);f.store.release('s0','old')
 const newer=startRun(other,'s0','new');finishSummaryRun(other,newer.id,{owner:'new',state:'done'});other.release('s0','new')
 assert.equal(finishSummaryRun(f.store,old.id,{owner:'old',state:'failed'}),false)
 assert.equal(f.store.source('s0').status,'ok');assert.equal(f.store.summaryError('s0'),null)
})

test('finish reuses an existing transaction and rolls back a failed status update',t=>{
 const f=fixture(t),a=startRun(f.store,'s0','owner')
 f.store.db.exec('BEGIN IMMEDIATE');finishSummaryRun(f.store,a.id,{owner:'owner',state:'done'});assert.equal(f.store.db.isTransaction,true);f.store.db.exec('ROLLBACK');assert.equal(f.store.latestSummaryRun('s0').state,'running')
 const status=f.store.setStatus;f.store.setStatus=()=>{throw Error('synthetic disk error')}
 assert.throws(()=>finishSummaryRun(f.store,a.id,{owner:'owner',state:'done'}),/disk/)
 f.store.setStatus=status;assert.equal(f.store.db.isTransaction,false);assert.equal(f.store.latestSummaryRun('s0').state,'running')
})

test('all inline and catch-up writers count global capacity before requesting a model',async t=>{
 const f=fixture(t,4);for(let i=0;i<3;i++)startRun(f.store,'s'+i,'owner'+i)
 let calls=0;const generate=()=>{calls++;return summary}
 assert.equal((await buildHierarchy(f.store,'s3',{model:'fake',summarize:generate})).stopped,'capacity')
 const result=await catchUp(f.store,'s3',{deadlineMs:1000,generate:(store,id,setting,options)=>buildHierarchy(store,id,{...options,model:'fake',summarize:generate})})
 assert.equal(result.created,0);assert.equal(calls,0)
 const r=spawnSync(process.execPath,['src/cli.js','summarize','s3'],{env:f.env,encoding:'utf8',timeout:10000})
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).queued,true);assert.equal(f.store.latestSummaryRun('s3').state,'queued')
})

test('running progress and late lost-owner results are fenced from the next run',async t=>{
 const f=fixture(t),entered=deferred(),response=deferred();let receivedSignal
 const running=buildHierarchy(f.store,'s0',{model:'fake',leaseHeartbeatMs:5,leaseDurationMs:500,summarize:async(_,options)=>{receivedSignal=options.signal;entered.resolve();return response.promise}})
 await entered.promise
 const old=f.store.latestSummaryRun('s0');assert.equal(old.state,'running');assert.deepEqual([old.current_first,old.current_last,old.created_parts],[0,1,0])
 f.store.release('s0',old.owner);finishSummaryRun(f.store,old.id,{owner:old.owner,state:'stopped'})
 const newer=startRun(f.store,'s0','next-owner');finishSummaryRun(f.store,newer.id,{owner:'next-owner',state:'done'});f.store.release('s0','next-owner')
 await pause(15);assert.equal(receivedSignal.aborted,true);response.resolve(summary);await assert.rejects(running,/lease|ownership/)
 assert.equal(f.store.nodeRows('s0',0).length,0);assert.equal(f.store.source('s0').status,'ok');assert.equal(f.store.latestSummaryRun('s0').id,newer.id)
 assert.equal(progressSummaryRun(f.store,old.id,old.owner,{created:99}),false)
})

test('successful retry clears failure while automatic turns retain batch cooldown',async t=>{
 const f=fixture(t),work=summaryWork(f.store,'s0'),revision=summarySettingsRevision(f.store,'s0')
 const failed=startRun(f.store,'s0','failed-owner');finishSummaryRun(f.store,failed.id,{owner:'failed-owner',state:'failed',error:Error('SECRET')});f.store.release('s0','failed-owner');f.store.failSummaryBatch('s0',work.batch_id,revision)
 assert.equal(scheduleSummary(f.store,'s0','cli','synthetic-host',{env:f.env,spawnProcess:f.spawnProcess}),false)
 const manual=enqueueSummary(f.store,'s0',{origin:'manual',env:f.env});assert.equal(manual.added,true);reserveSummaryRun(f.store,{id:manual.run.id})
 const result=await buildHierarchy(f.store,'s0',{runId:manual.run.id,model:'fake',retryFailed:true,maxPieces:1,summarize:async()=>summary})
 assert.equal(result.created,1);assert.equal(f.store.latestSummaryRun('s0').state,'done');assert.equal(f.store.source('s0').status,'ok');assert.equal(f.store.summaryError('s0'),null)
})

test('host UUID claims share capacity, preserve soft target, and finish on save or release',t=>{
 const f=fixture(t,4);for(let i=0;i<3;i++)startRun(f.store,'s'+i,'owner'+i)
 assert.match(f.cli('summary-claim','s3').none,/queue/);assert.equal(f.store.latestSummaryRun('s3').state,'queued')
 finishSummaryRun(f.store,f.store.latestSummaryRun('s0').id,{owner:'owner0',state:'done'});f.store.release('s0','owner0')
 const claim=f.cli('summary-claim','s3').work;assert.ok(claim.claim_id);assert.equal(claim.task.maxChars,6000);assert.ok(claim.task.requestChars>0)
 assert.equal(f.cli('summary-check','s3',{batch_id:claim.batch_id}).valid,false)
 assert.match(f.cli('summary-save','s3',{batch_id:claim.batch_id,summary}).error,/claim ID required/);assert.equal(f.store.latestSummaryRun('s3').state,'running')
 assert.equal(f.cli('summary-save','s3',{batch_id:claim.batch_id,claim_id:claim.claim_id,summary}).saved,true);assert.equal(f.store.latestSummaryRun('s3').state,'done')
 const next=f.cli('summary-claim','s3').work;f.cli('summary-release','s3',{batch_id:next.batch_id,claim_id:next.claim_id});assert.equal(f.store.latestSummaryRun('s3').state,'stopped')
})

test('missing claim preserves the actual rejection and stale handoff never releases new ownership',t=>{
 const f=fixture(t)
 assert.match(f.cli('summary-save','s0',{batch_id:'fake',summary}).error,/no summary claimed/)
 const old=f.cli('summary-claim').work;f.cli('summary-release','s0',{batch_id:old.batch_id,claim_id:old.claim_id})
 f.store.setHarnessSetting('claude-code','cli','new-synthetic-host')
 const next=f.cli('summary-claim').work
 f.cli('summary-handoff','s0',{});f.cli('summary-host-error','s0',{batch_id:old.batch_id,claim_id:old.claim_id})
 assert.equal(f.cli('summary-check','s0',{batch_id:next.batch_id,claim_id:next.claim_id}).valid,true)
 assert.equal(f.store.latestSummaryRun('s0').state,'running');f.cli('summary-release','s0',{batch_id:next.batch_id,claim_id:next.claim_id})
})

test('Codex classification reads a bounded complete long metadata line and excludes exec and subagent sources',t=>{
 const f=fixture(t,0)
 for(const [id,meta,expected] of [['exec',{originator:'codex_exec',instructions:'x'.repeat(90000)},true],['source',{source:'exec'},true],['sub',{source:{subagent:{parent_thread_id:'synthetic'}}},true],['cli',{originator:'codex_cli_rs',source:'cli'},false]]){
  const path=f.add(id,{harness:'codex',header:{type:'session_meta',payload:meta}});assert.equal(codexHeadless(path),expected);assert.equal(f.store.metadata(id).headless,expected)
 }
 assert.equal(codexHeadless(join(f.dir,'missing')),false)
})

test('historical Codex metadata migrates once with bounded batches and preserves title, source and settings',t=>{
 const dir=mkdtempSync(join(tmpdir(),'superlcm-headless-migrate-')),source=join(dir,'old.jsonl'),home=join(dir,'store');mkdirSync(home)
 const original=JSON.stringify({type:'session_meta',payload:{originator:'codex_exec',instructions:'x'.repeat(32000)}})+'\n'+JSON.stringify({role:'user',content:'Synthetic old task'})+'\n';writeFileSync(source,original)
 const db=new DatabaseSync(join(home,'lcm.sqlite'));db.exec("CREATE TABLE sources(session TEXT PRIMARY KEY,path TEXT NOT NULL,kind TEXT NOT NULL,offset INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'ok');CREATE TABLE session_origins(session TEXT PRIMARY KEY,harness TEXT NOT NULL,external_id TEXT,display_name TEXT,name_source TEXT);")
 for(let i=0;i<70;i++){db.prepare('INSERT INTO sources(session,path,kind,status) VALUES(?,?,?,?)').run('old'+i,source,'jsonl','summary_error');db.prepare('INSERT INTO session_origins VALUES(?,?,?,?,?)').run('old'+i,'codex','external'+i,'Keep title '+i,'manual')};db.close()
 const store=new ClaudeStore(home);t.after(()=>store.close())
 assert.equal(store.db.prepare('SELECT count(*) n FROM session_origins WHERE headless_scanned=1').get().n,64)
 store.setHarnessSetting('codex','off');store.listSessions(100,0,undefined,'attention')
 assert.equal(store.metadata('old69').headless,true);assert.equal(store.metadata('old0').name,'Keep title 0');assert.equal(store.effectiveSetting('old0').mode,'off');assert.equal(readFileSync(source,'utf8'),original)
 assert.equal(store.listSessions(100,0,undefined,'attention').total,0);assert.equal(store.backfillHeadless(),0)
})

test('Web exposes queued then starting, observes failures and groups headless outside attention',async t=>{
 const f=fixture(t,1);f.add('exec',{headless:true,harness:'codex'});f.store.setStatus('s0','summary_error');f.store.setStatus('exec','summary_error')
 const w=await webFixture(t,f),list=await w.get('api/conversations?view=attention');assert.equal(list.total,1);assert.equal(list.headless_count,1)
 const posted=await w.post('api/summarize',{session:'s0',backend:'cli'});assert.equal(posted.status,200);assert.equal(posted.data.started,false);assert.equal(posted.data.queued,true);assert.equal(posted.data.summary_health.state,'starting');assert.equal(f.children.length,1)
 const detail=await w.get('api/conversation?session=s0');assert.equal(detail.summarizing,true);assert.equal(detail.summary_error_detail,null)
 f.children[0].emit('exit',1);const ended=await w.get('api/conversation?session=s0');assert.equal(ended.summary_health.state,'lost');assert.equal(ended.summary_health.needs_attention,true);assert.equal(ended.summary_runs.length,1)
 assert.equal((await w.get('api/conversations?view=headless')).sessions[0].session,'exec')
})

test('bulk retry requires scoped preview and exact count, rejects changed settings and duplicate confirmation',async t=>{
 const f=fixture(t,2);f.add('exec',{headless:true,harness:'codex'});for(const id of ['s0','s1','exec'])f.store.setStatus(id,'summary_error')
 const w=await webFixture(t,f)
 for(const body of [{view:'all',backend:'cli'},{view:'attention',backend:'cli',sessions:['exec']},{view:'headless',backend:'cli',sessions:['s0']},{view:'attention',backend:'cli',sessions:['s0','s0']},{view:'attention',backend:'cli',sessions:Array(101).fill('s0')}])assert.equal((await w.post('api/summarize-bulk-preview',body)).status,400)
 const a=(await w.post('api/summarize-bulk-preview',{view:'attention',backend:'cli',sessions:['s0','s1']})).data;assert.equal(a.count,2);assert.equal(f.children.length,0)
 assert.equal((await w.post('api/summarize-bulk',{token:a.token,confirm:true,expect_count:1})).status,400)
 f.store.setHarnessSetting('claude-code','cli','changed-model');assert.equal((await w.post('api/summarize-bulk',{token:a.token,confirm:true,expect_count:2})).status,400)
 const b=(await w.post('api/summarize-bulk-preview',{view:'attention',backend:'cli',sessions:['s0','s1']})).data
 const done=await w.post('api/summarize-bulk',{token:b.token,confirm:true,expect_count:2});assert.equal(done.status,200);assert.equal(done.data.queued,2);assert.equal(f.children.length,2)
 assert.equal((await w.post('api/summarize-bulk',{token:b.token,confirm:true,expect_count:2})).status,400);assert.equal(f.children.length,2)
})

test('real DOM rendering shows queued progress, safe causes and explicit ended-session retry wording',()=>{
 const code=readFileSync(new URL('../src/web-client.js',import.meta.url),'utf8'),elements=new Map()
 const element=id=>{if(!elements.has(id))elements.set(id,{querySelectorAll:()=>[],innerHTML:''});return elements.get(id)}
 const detail={source:{session:'s',harness:'claude-code',name:'Synthetic',code:'abc'},records:6,summarized_to:0,summary_count:0,bands:[],setting:{mode:'cli'},backends:['cli'],estimate:{calls:3},summary_health:{state:'queued',active:true,run:{created_parts:0,planned_parts:3,current_first:null,model:'fake',queued_ms:Date.now()}},summarizing:true}
 const context={state:{detail,open:new Set(),children:new Map()},$:element,esc:String,fmt:String,t:(key,p={})=>key.replace(/\{([^}]+)\}/g,(_,k)=>p[k]),toolName:()=> 'Claude',ago:()=> '刚刚',mark:()=>'',TRASH:'',stripHtml:()=>'',generateButton:()=>'<button>重试</button>',bindDetail(){},nodeHtml(){}}
 const program=code.slice(code.indexOf('const SUMMARY_LABELS='),code.indexOf('\nasync function api('))+'\n'+code.slice(code.indexOf('function renderDetail()'),code.indexOf('function nodeHtml('))+'\nrenderDetail()'
 runInNewContext(program,context);assert.match(element('#detail').innerHTML,/摘要已排队|0 \/ 3/);assert.doesNotMatch(element('#detail').innerHTML,/重试/)
 detail.summarizing=false;detail.summary_health={state:'failed',active:false,needs_attention:true,retry_hint:'next_turn_or_manual',run:{...detail.summary_health.run,error_message:'Synthetic safe failure'}}
 runInNewContext('renderDetail()',context);assert.match(element('#detail').innerHTML,/会话已结束时请手动重试/);assert.match(element('#detail').innerHTML,/Synthetic safe failure/)
})

test('the actual detail polling continues for queued and starting records without a lease',async()=>{
 const code=readFileSync(new URL('../src/web-client.js',import.meta.url),'utf8'),start=code.indexOf('async function loadDetail('),end=code.indexOf('const pct = (x, total)'),timers=[]
 const detail={session:'s',summary_health:{active:true,state:'queued'},summarizing:false}
 const context={state:{sel:'s',detail:null,detailSeq:0},api:async()=>detail,q:encodeURIComponent,renderDetail(){},clearTimeout(){},setTimeout:(fn,ms)=>{timers.push(ms);return 1},act:fn=>fn(),setHash(){}}
 await runInNewContext(code.slice(start,end)+'\nloadDetail()',context);assert.deepEqual(timers,[3000])
 detail.summary_health.state='starting';await runInNewContext('loadDetail()',context);assert.deepEqual(timers,[3000,3000])
})

test('queued host is stopped on settings changes and explicit API retry atomically replaces an idle host',t=>{
 const f=fixture(t,2),blocker=startRun(f.store,'s0','blocker');f.env.SUPERLCM_SUMMARY_CONCURRENCY='1'
 assert.match(f.cli('summary-claim','s1').none,/queue/);const old=f.store.latestSummaryRun('s1');assert.equal(old.route,'host')
 f.store.setHarnessSetting('claude-code','off');drainSummaryQueue(f.store,{env:f.env,spawnProcess:f.spawnProcess})
 assert.equal(f.store.latestSummaryRun('s1').state,'stopped');assert.equal(summaryHealth(f.store,'s1',{env:f.env}).active,false);assert.equal(f.children.length,0)
 f.store.setGlobalSetting('api','fake-api','openai','http://127.0.0.1:9/v1');f.store.setHarnessSetting('claude-code','cli','synthetic-host')
 assert.match(f.cli('summary-claim','s1').none,/queue/);const queued=f.store.latestSummaryRun('s1')
 const replacement=enqueueSummary(f.store,'s1',{backend:'api',origin:'manual',env:f.env});assert.equal(replacement.added,true);assert.equal(replacement.run.route,'worker');assert.equal(replacement.run.backend,'api')
 assert.equal(f.store.db.prepare('SELECT state,stop_reason FROM summary_runs WHERE id=?').get(queued.id).stop_reason,'manual-takeover')
 finishSummaryRun(f.store,blocker.id,{owner:'blocker',state:'done'});f.store.release('s0','blocker');drainSummaryQueue(f.store,{env:f.env,spawnProcess:f.spawnProcess})
 assert.equal(f.children.length,1);assert.equal(f.children[0].args[1].at(-1),'api')
})

test('legacy automatic workers without run ID preserve cooldown and manual retry remains possible',async t=>{
 const f=fixture(t);f.store.setHarnessSetting('claude-code','api','fake-api','openai','http://127.0.0.1:9/v1')
 const work=summaryWork(f.store,'s0'),revision=summarySettingsRevision(f.store,'s0',f.env);f.store.failSummaryBatch('s0',work.batch_id,revision)
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:summary},finish_reason:'stop'}]}))})
 const stopped=await runSummaryWorker(f.store,'s0',{env:{...f.env,SUPERLCM_HOOK_WORKER:'1'}})
 assert.equal(stopped.stopped,'retry-backoff');assert.equal(calls,0);assert.ok(f.store.summaryRetry('s0',work.batch_id,revision));assert.equal(f.store.latestSummaryRun('s0'),null)
 const manual=await runSummaryWorker(f.store,'s0',{env:{...f.env,SUPERLCM_HOOK_WORKER:'0'}})
 assert.ok(manual.created>0);assert.ok(calls>0);assert.equal(f.store.latestSummaryRun('s0').origin,'manual')
})

test('legacy expected model and mode mismatch stop before model execution and preserve a newer active run',async t=>{
 const f=fixture(t);f.store.setHarnessSetting('claude-code','api','new-model','openai','http://127.0.0.1:9/v1');let calls=0
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('must not request')})
 for(const expected of [{SUPERLCM_SUMMARY_EXPECTED_MODEL:'old-model'},{SUPERLCM_SUMMARY_EXPECTED_MODE:'cli'}]){
  const result=await runSummaryWorker(f.store,'s0',{env:{...f.env,SUPERLCM_HOOK_WORKER:'1',...expected}})
  assert.equal(result.stopped,'expected-settings-changed');assert.equal(f.store.latestSummaryRun('s0').state,'stopped');assert.equal(f.store.latestSummaryRun('s0').origin,'hook')
 }
 const next=enqueueSummary(f.store,'s0',{origin:'manual',env:f.env}).run
 await runSummaryWorker(f.store,'s0',{env:{...f.env,SUPERLCM_HOOK_WORKER:'1',SUPERLCM_SUMMARY_EXPECTED_MODEL:'old-model'}})
 assert.equal(f.store.latestSummaryRun('s0').id,next.id);assert.equal(f.store.latestSummaryRun('s0').state,'queued');assert.equal(calls,0);assert.equal(f.store.source('s0').status,'ok')
})

test('bulk confirmation rejects source growth and changed estimates with or without ingest',async t=>{
 const f=fixture(t,0),file=f.add('exec',{headless:true,harness:'codex'}),w=await webFixture(t,f)
 const a=(await w.post('api/summarize-bulk-preview',{view:'headless',backend:'cli',sessions:['exec']})).data;assert.equal(a.count,1)
 appendFileSync(file,Array.from({length:14},(_,i)=>JSON.stringify({role:i%2?'assistant':'user',content:'Synthetic new progress '+i})).join('\n')+'\n')
 assert.equal((await w.post('api/summarize-bulk',{token:a.token,confirm:true,expect_count:1})).status,400);assert.equal(f.children.length,0)
 f.store.ingest('exec',file)
 assert.ok(summaryHealth(f.store,'exec').estimate.calls>a.calls)
 assert.equal((await w.post('api/summarize-bulk',{token:a.token,confirm:true,expect_count:1})).status,400);assert.equal(f.children.length,0)
 const b=(await w.post('api/summarize-bulk-preview',{view:'headless',backend:'cli',sessions:['exec']})).data
 assert.ok(b.calls>a.calls);assert.equal((await w.post('api/summarize-bulk',{token:b.token,confirm:true,expect_count:1})).status,200);assert.equal(f.children.length,1)
})

test('archived exec metadata migrates through verified originals and unreadable metadata remains unconfirmed',t=>{
 const f=fixture(t,0),file=f.add('archived-exec',{harness:'codex',header:{type:'session_meta',payload:{originator:'codex_exec',instructions:'x'.repeat(32000)}}}),original=readFileSync(file,'utf8')
 f.store.db.prepare('UPDATE sources SET path=? WHERE session=?').run(join(f.dir,'native-unavailable.jsonl'),'archived-exec')
 f.store.db.prepare('UPDATE session_origins SET headless=0,headless_scanned=1,headless_scan_version=1 WHERE session=?').run('archived-exec')
 const reopened=new ClaudeStore(f.store.dir);t.after(()=>reopened.close());assert.equal(reopened.metadata('archived-exec').headless,true);assert.equal(reopened.listSessions(10,0,undefined,'headless').total,1);assert.equal(reopened.exact('archived-exec',0),original.split('\n')[0]+'\n')
 const archivePath=f.store.archivePath;f.store.archivePath=()=>join(f.dir,'archive-unavailable.raw')
 f.store.db.prepare('UPDATE session_origins SET headless=0,headless_scanned=0 WHERE session=?').run('archived-exec');f.store.backfillHeadless()
 assert.equal(f.store.db.prepare('SELECT headless_scanned FROM session_origins WHERE session=?').get('archived-exec').headless_scanned,0)
 f.store.archivePath=archivePath;f.store.backfillHeadless();assert.equal(f.store.metadata('archived-exec').headless,true);assert.equal(readFileSync(file,'utf8'),original)
})

test('queued host detail offers confirmed background takeover with API for empty and saved summary states',async()=>{
 for(const saved of [false,true]){
  const ui=detailPage(queuedHostDetail({saved})),buttons=ui.generate()
  assert.equal(buttons.length,1);assert.match(buttons[0].textContent,/转到后台生成/)
  assert.match(ui.html(),/摘要正在等待原会话继续/);assert.equal(ui.calls.length,0)
  buttons[0].onclick()
  assert.equal(ui.calls.length,0,'opening the method dialog must not enqueue or call a model')
  assert.match(ui.context.modal.innerHTML,/自定义 API|确认转到后台/)
  assert.match(ui.context.modal.innerHTML,/确认后，将由你选择的后台方式接替排队中的摘要/)
  await ui.context.modal.querySelector('#genGo').onclick()
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].path,'/api/summarize');assert.equal(ui.calls[0].body.backend,'api');assert.equal(ui.calls[0].body.session,'s0')
 }
})

test('queued host without a background backend links to setup and exposes no generation action',()=>{
 for(const saved of [false,true]){
  const ui=detailPage(queuedHostDetail({saved,backends:[]}))
  assert.equal(ui.generate().length,0);assert.match(ui.html(),/本机没有可用的摘要生成方式/)
  assert.equal(ui.settings().length,1);ui.settings()[0].onclick();assert.deepEqual(ui.views,['settings','summary']);assert.equal(ui.calls.length,0)
 }
})

test('queued worker and starting or running writers never receive duplicate generation actions',()=>{
 for(const saved of [false,true])for(const state of ['queued','starting','running'])for(const route of state==='queued'?['worker']:['host','worker'])for(const summarizing of [false,true]){
  const ui=detailPage(queuedHostDetail({saved,state,route,summarizing}))
  assert.equal(ui.generate().length,0,JSON.stringify({saved,state,route,summarizing}));assert.equal(ui.calls.length,0);assert.doesNotMatch(ui.html(),/转到后台生成/)
 }
})

test('the actual detail button and method confirmation atomically replace a real queued host via Web API',async t=>{
 const f=fixture(t,2);f.env.SUPERLCM_SUMMARY_CONCURRENCY='1'
 f.store.setGlobalSetting('api','fake-api','openai','http://127.0.0.1:9/v1');const blocker=startRun(f.store,'s1','blocker')
 assert.match(f.cli('summary-claim','s0').none,/queue/);const host=f.store.latestSummaryRun('s0')
 finishSummaryRun(f.store,blocker.id,{owner:'blocker',state:'done'});f.store.release('s1','blocker')
 const w=await webFixture(t,f),detail=await w.get('api/conversation?session=s0')
 assert.equal(detail.summary_health.state,'queued');assert.equal(detail.summary_health.run.route,'host');assert.ok(detail.backends.includes('api'))
 const ui=detailPage(detail,{request:async(path,body)=>{const reply=await w.post(path.replace(/^\//,''),body);assert.equal(reply.status,200);return reply.data},refresh:async context=>{context.state.detail=await w.get('api/conversation?session=s0')}})
 assert.equal(ui.generate().length,1);ui.generate()[0].onclick();assert.equal(f.children.length,0);assert.equal(f.store.latestSummaryRun('s0').id,host.id)
 const apiButton=ui.context.modal.querySelectorAll('[data-b]').find(b=>b.dataset.b==='api');assert.ok(apiButton);apiButton.onclick()
 assert.equal(f.children.length,0);await ui.context.modal.querySelector('#genGo').onclick()
 const replacement=f.store.latestSummaryRun('s0');assert.notEqual(replacement.id,host.id);assert.equal(replacement.route,'worker');assert.equal(replacement.backend,'api');assert.equal(replacement.state,'starting');assert.equal(f.children.length,1)
 const previous=f.store.db.prepare('SELECT state,stop_reason FROM summary_runs WHERE id=?').get(host.id);assert.equal(previous.state,'stopped');assert.equal(previous.stop_reason,'manual-takeover')
 ui.render();assert.equal(ui.generate().length,0,'replacement starts once and its refreshed page offers no duplicate action')
})
