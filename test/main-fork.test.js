import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {DatabaseSync} from 'node:sqlite'
import {forkTreePlan,parseForkTree} from '../src/fork-summary.js'
import {summarizeClaudeFork,summarizeCodexFork} from '../src/native-fork.js'
import {migrateSummaryModes} from '../src/summary-migration.js'
import {semanticKind,semanticLevel,granularFrontier} from '../dsh/tree-semantics.js'
const env={...process.env,SUPERLCM_CLAUDE_CLI_BIN:process.execPath,SUPERLCM_CODEX_CLI_BIN:process.execPath}
function fake(handler){return (bin,args,options)=>{
  const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null})
  child.kill=()=>{if(child.exitCode===null){child.exitCode=0;queueMicrotask(()=>child.emit('close',0))}return true}
  handler(child,args,options);return child
}}
const emit=(child,item)=>child.stdout.write(JSON.stringify(item)+'\n')
test('legacy rolling overview ancestry remains readable without becoming granularity layers',()=>{
 const nodes=new Map(),store={getNode:(_session,id)=>nodes.get(id)}
 for(let i=0;i<4;i++)nodes.set('leaf-'+i,{kind:'leaf',summary:[{type:'text',text:'Original decision '+i}],childIds:[]})
 nodes.set('merged',{kind:'condensed',summary:[{type:'text',text:'Summary of four original decisions.'}],childIds:[...nodes.keys()]})
 let root='merged'
 for(let i=0;i<24;i++){
  nodes.set('new-'+i,{kind:'leaf',summary:[{type:'text',text:'New decision '+i}],childIds:[]})
  nodes.set('overview-'+i,{kind:'condensed',summary:[{type:'text',text:'Unique checkpoint decision '+i}],childIds:[root,'new-'+i]});root='overview-'+i
 }
 assert.equal(semanticKind(store,'synthetic',root),'overview')
 assert.equal(semanticLevel(store,'synthetic',root),3)
 assert.deepEqual(granularFrontier(store,'synthetic',root),['merged',...Array.from({length:24},(_,i)=>'new-'+i)])
 assert.equal(nodes.get('overview-0').summary[0].text,'Unique checkpoint decision 0')
 nodes.set('cycle',{summary:[],childIds:['cycle']})
 assert.throws(()=>semanticLevel(store,'synthetic','cycle'),/cycle/)
})

test('incremental fork merges four equal blocks across calls and keeps overviews out of later leaves',()=>{
 let frontier=[];const counts=[]
 for(let round=0;round<64;round++){
  const leaves=[...frontier.map((n,index)=>({index,firstMessage:index-frontier.length,lastMessage:index-frontier.length,frozenSummary:n.summary,frozenLevel:n.semanticLevel,units:n.units,kind:n.kind})),{firstMessage:round,lastMessage:round,units:[round]}]
  const options={fanout:4,incremental:true},plan=forkTreePlan(leaves,4,options)
  const text=JSON.stringify({blocks:plan.filter(n=>n.frozenSummary===undefined).map(n=>({index:n.index,summary:'# State\nSynthetic complete historical state '+round+'.'}))})
  const tree=parseForkTree(text,leaves,undefined,options)
  for(const n of tree){if(n.children.length)n.units=n.children.flatMap(i=>tree[i].units);if(n.frozenSummary!==undefined)assert.equal(n.summary,n.frozenSummary)}
  const owned=new Set(tree.flatMap(n=>n.children)),next=tree.filter(n=>n.kind!=='overview'&&!owned.has(n.index))
  const root=tree.at(-1)
  // The overview owns frontier members for reading, but is never carried as a leaf.
  frontier=root.kind==='overview'?root.children.map(i=>tree[i]):next
  assert.deepEqual(frontier.flatMap(n=>n.units),Array.from({length:round+1},(_,i)=>i))
  assert.ok(frontier.every(n=>n.kind!=='overview'))
  if([4,16,64].includes(round+1))counts.push({blocks:round+1,rootLevel:root.semanticLevel})
 }
 assert.deepEqual(counts,[{blocks:4,rootLevel:1},{blocks:16,rootLevel:2},{blocks:64,rootLevel:3}])
})

test('one response must supply a bounded complete summary tree',()=>{
 const leaves=Array.from({length:9},(_,index)=>({index,firstMessage:index*2,lastMessage:index*2+1}))
 const plan=forkTreePlan(leaves,4);assert.equal(plan.length,12);assert.equal(plan.at(-1).level,2)
 const blocks=plan.map(n=>({index:n.index,summary:'# Historical constraints\nPending inspection; verify the originals.'}))
 const tree=parseForkTree(JSON.stringify({blocks}),leaves,undefined,{fanout:4,targetTokens:1000})
 assert.deepEqual(tree.at(-1).children,[9,10,8]);assert.equal(tree.at(-1).lastMessage,17)
 assert.throws(()=>parseForkTree(JSON.stringify({blocks:blocks.slice(0,9)}),leaves),/层级缺失/)
 assert.throws(()=>parseForkTree(JSON.stringify({blocks}),leaves,undefined,{targetTokens:1}),/预算/)
})
test('migration retires host mode while preserving explicit CLI models and API settings',()=>{
 const db=new DatabaseSync(':memory:')
 for(const name of ['summary_policies','summary_preferences','global_summary_settings','harness_summary_settings']){
   db.exec(`CREATE TABLE ${name}(id TEXT PRIMARY KEY,mode TEXT CHECK(mode IN ('agent','cli','api','off'))${name==='summary_policies'?'':',model TEXT,api_ref TEXT'})`)
   if(name==='summary_policies')db.prepare(`INSERT INTO ${name} VALUES(?,?)`).run('one','agent')
   else{db.prepare(`INSERT INTO ${name} VALUES(?,?,?,?)`).run('one','cli','old-model',null);db.prepare(`INSERT INTO ${name} VALUES(?,?,?,?)`).run('api','api','fixture-luna','saved-api')}
 }
 migrateSummaryModes(db);migrateSummaryModes(db)
 for(const name of ['summary_policies','summary_preferences','global_summary_settings','harness_summary_settings']){
   assert.equal(db.prepare(`SELECT mode FROM ${name} WHERE id='one'`).get().mode,name==='summary_policies'?'main-fork':'cli')
   if(name!=='summary_policies')assert.deepEqual({...db.prepare(`SELECT mode,model,api_ref FROM ${name} WHERE id='api'`).get()},{mode:'api',model:'fixture-luna',api_ref:'saved-api'})
 }
 db.close()
})
test('Claude resumes a native fork, inherits settings and records real usage',async()=>{
 let seen
 const result=await summarizeClaudeFork('original-session','SUMMARY DIRECTIVE',{env,spawnProcess:fake((child,args,options)=>{
   seen={args,options};child.stdin.on('finish',()=>{emit(child,{type:'result',subtype:'success',result:'# Summary\nHistorical inspection.',session_id:'fork-session',usage:{cache_read_input_tokens:300000},stop_reason:'end_turn'});child.kill()})
 })})
 assert.equal(result.branchId,'fork-session');assert.equal(result.usage.cache_read_input_tokens,300000)
 assert.ok(seen.args.includes('--fork-session'));assert.ok(seen.args.includes('original-session'))
 assert.ok(seen.args.includes('--include-partial-messages'))
 assert.ok(!seen.args.some(a=>['--system-prompt','--model','--tools'].includes(a)))
 assert.equal(seen.options.env.SUPERLCM_CLI_WORKER,'1');assert.match(seen.args.at(-1),/PreToolUse/)
})
for(const fault of ['tool','truncated','missing'])test('Claude rejects '+fault+' without saving',async()=>{
 await assert.rejects(summarizeClaudeFork('source','summary',{env,spawnProcess:fake(child=>child.stdin.on('finish',()=>{
   if(fault==='tool')emit(child,{type:'assistant',message:{content:[{type:'tool_use',id:'bad',name:'Bash'}]}})
   else if(fault==='truncated')emit(child,{type:'result',result:'# Incomplete',stop_reason:'max_tokens'})
   child.kill()
 }))}),/工具|截断|回执/)
})
function rpcSpawn(requests,{tool=false,silent=false}={}){return fake(child=>{
 let input='';child.stdin.on('data',data=>{input+=data.toString();for(let index;(index=input.indexOf('\n'))>=0;){const line=input.slice(0,index);input=input.slice(index+1);const msg=JSON.parse(line);requests.push(msg);if(!msg.id||silent)continue
  if(msg.method==='initialize')emit(child,{id:msg.id,result:{}})
  if(msg.method==='thread/fork')emit(child,{id:msg.id,result:{thread:{id:'branch'},model:'same-model'}})
  if(msg.method==='turn/start'){
   emit(child,{id:msg.id,result:{turn:{id:'turn'}}})
   if(tool){emit(child,{id:99,method:'item/commandExecution/requestApproval',params:{threadId:'branch'}});continue}
   emit(child,{method:'thread/tokenUsage/updated',params:{threadId:'branch',tokenUsage:{last:{inputTokens:300001,cachedInputTokens:300000}}}})
   emit(child,{method:'item/completed',params:{threadId:'branch',item:{type:'agentMessage',text:'# Summary\nHistorical inspection.'}}})
   emit(child,{method:'turn/completed',params:{threadId:'branch',turn:{id:'turn',status:'completed'}}})
  }
 }})
})}
test('Codex creates one ephemeral native fork and inherits model and reasoning',async()=>{
 const requests=[],result=await summarizeCodexFork('main-thread','summary',{env,spawnProcess:rpcSpawn(requests)})
 assert.equal(result.usage.cachedInputTokens,300000);assert.equal(result.model,'same-model')
 const fork=requests.find(r=>r.method==='thread/fork').params,start=requests.find(r=>r.method==='turn/start').params
 assert.equal(fork.threadId,'main-thread');assert.equal(fork.ephemeral,true);assert.ok(fork.config.hooks.PreToolUse)
 assert.equal(fork.model,undefined);assert.equal(fork.baseInstructions,undefined)
 assert.deepEqual(start,{threadId:'branch',input:[{type:'text',text:'summary',text_elements:[]}]})
})
test('Codex denies tool approval and cancels a stuck startup',async()=>{
 await assert.rejects(summarizeCodexFork('main','summary',{env,spawnProcess:rpcSpawn([],{tool:true})}),/工具或授权/)
 await assert.rejects(summarizeCodexFork('main','summary',{env,timeoutMs:20,spawnProcess:rpcSpawn([],{silent:true})}),/超时/)
})
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore} from '../src/store.js'
import {planMainFork,generateMainFork} from '../src/main-fork.js'
import {enqueueSummary,scheduleSummary} from '../src/summary-scheduler.js'
import {estimateSummaryTokens} from '../src/summary-tokens.js'
import {runSummaryWorker} from '../src/summary-worker.js'
import {planCompaction} from '../src/compaction.js'

const until=async predicate=>{const start=Date.now();while(!predicate()){if(Date.now()-start>5000)throw Error('Native fork fixture did not settle');await new Promise(setImmediate)}}
function archive(t,{count=4,size=100,harness='claude-code'}={}){
 const dir=mkdtempSync(join(tmpdir(),'superlcm-native-fork-')),store=new ClaudeStore(join(dir,'index')),file=join(dir,'history.jsonl')
 const row=i=>JSON.stringify({type:i%2?'assistant':'user',uuid:'entry-'+i,message:{content:[{type:'text',text:'Original evidence '+i+' '+'.'.repeat(size)}]}})+'\n'
 writeFileSync(file,Array.from({length:count},(_,i)=>row(i)).join(''));store.ingest('session',file)
 store.setMetadata('session',{harness,externalId:'native-source'});store.setGlobalSetting('main-fork')
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});return {store,file,row}
}
const treeAnswer=plan=>JSON.stringify({blocks:plan.tree.map(n=>({index:n.index,summary:'# Historical evidence\nThe user constraints remain active. Inspection is pending; verify original records.'}))})

for(const harness of ['claude-code','codex'])test(harness+' archives a complete tree above its planning estimate without regenerating',async t=>{
 const {store}=archive(t,{harness})
 const plan=planMainFork(store,'session',{force:true,env:{}})
 const summary='# Historical evidence\n'+'Preserve the original user constraints and pending work. '.repeat(180)
 assert.ok(estimateSummaryTokens(summary)>plan.targetTokens)
 let calls=0
 const result=await generateMainFork(store,'session',{env:{},queuedPlan:plan,summarize:async()=>{calls++;return {text:JSON.stringify({blocks:plan.tree.map(n=>({index:n.index,summary}))}),model:'current-model'}}})
 assert.equal(calls,1);assert.equal(result.created,plan.tree.length)
 assert.equal(store.nodeRows('session',0)[0].summary,summary.trim())
})

for(const kind of ['bytes','tokens'])test('an archived root beyond the replacement '+kind+' limit cannot be injected into the live context',()=>{
 const events=[{ordinal:0,preview:'user: old request'},{ordinal:1,preview:'assistant: old answer'},{ordinal:2,preview:'user: current request'}]
 const messages=events.map(e=>({role:e.preview.split(': ')[0],text:e.preview.split(': ')[1],size:1000}))
 const nodes=[{id:'root',level:0,first:0,last:1,summary:'# Historical state\n'+(kind==='bytes'?'x'.repeat(300000):'中'.repeat(50000))}]
 const plan=planCompaction({meta:{code:'fixture'},events,nodes,messages,tokens:80000,window:100000,keepTokens:0})
 assert.equal(plan.use,false);assert.match(plan.reason,/safe size|too large/)
})

test('all mandatory summary roots must fit before their covered messages can be removed',()=>{
 const texts=['user: first request','assistant: first answer','user: second request','assistant: second answer','user: current request']
 const events=texts.map((preview,ordinal)=>({preview,ordinal})),messages=texts.map(t=>({role:t.split(': ')[0],text:t.split(': ')[1],size:1000}))
 const nodes=[{id:'first',level:0,first:0,last:1,summary:'# Preserved first range'}, {id:'second',level:0,first:2,last:3,summary:'# Essential second range\n'+'x'.repeat(300000)}]
 assert.equal(planCompaction({meta:{code:'fixture'},events,nodes,messages,tokens:80000,window:100000,keepTokens:0}).use,false)
})

test('old three-failure cooldown does not permanently suppress native background branches',t=>{
 const {store}=archive(t,{count:24,size:16000}),plan=planMainFork(store,'session',{force:false,env:{}})
 for(let i=0;i<3;i++)store.failSummaryBatch('session',plan.digest,plan.revision)
 assert.equal(enqueueSummary(store,'session',{origin:'hook',env:{}}).added,true)
})

test('Claude accepts its final completion receipt without waiting for child shutdown',async()=>{
 const result=await summarizeClaudeFork('source','summary',{env,timeoutMs:20,spawnProcess:fake(child=>child.stdin.on('finish',()=>{
  emit(child,{type:'result',subtype:'success',result:'# Historical state\nPreserve original constraints.',stop_reason:'end_turn'})
 }))})
 assert.match(result.text,/Historical state/)
})

test('native transport still rejects responses above its independent byte limit',async()=>{
 await assert.rejects(summarizeClaudeFork('source','summary',{env,spawnProcess:fake(child=>child.stdin.on('finish',()=>child.stdout.write('x'.repeat(8*1024*1024+1))))}),error=>error.summaryKind==='length')
})

test('native branch default allows ten minutes per attempt',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let settled=false
 const job=summarizeClaudeFork('source','summary',{env,spawnProcess:fake(()=>{})})
 job.then(()=>{settled=true},()=>{settled=true})
 try{
  t.mock.timers.tick(180001);await new Promise(setImmediate)
  assert.equal(settled,false,'the old three-minute deadline must not discard a large branch')
  t.mock.timers.tick(600000)
  await assert.rejects(job,error=>error.summaryKind==='timeout')
 }finally{t.mock.timers.reset()}
})

test('Claude native fork renews its ten-minute idle timer only for meaningful stream output',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let child,progress=0
 const job=summarizeClaudeFork('source','summary',{env,progress:()=>progress++,spawnProcess:fake(c=>{child=c})})
 try{
  for(let i=0;i<3;i++){
   t.mock.timers.tick(540000)
   emit(child,{type:'stream_event',event:{type:'content_block_delta',delta:{type:i%2?'thinking_delta':'text_delta',...(i%2?{thinking:'thinking'}:{text:'evidence'})}}})
   await new Promise(setImmediate)
  }
  emit(child,{type:'result',subtype:'success',result:'# History\nSynthetic evidence.',stop_reason:'end_turn'})
  assert.match((await job).text,/Synthetic evidence/);assert.equal(progress,3)
 }finally{t.mock.timers.reset()}
})

test('Claude native fork does not renew its idle timer for whitespace or lifecycle events',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let child,progress=0
 const job=summarizeClaudeFork('source','summary',{env,progress:()=>progress++,spawnProcess:fake(c=>{child=c})})
 const rejected=assert.rejects(job,error=>error.summaryKind==='timeout')
 try{
  t.mock.timers.tick(540000)
  emit(child,{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'  '}}})
  emit(child,{type:'stream_event',event:{type:'message_start'}});await new Promise(setImmediate)
  t.mock.timers.tick(60001);await rejected;assert.equal(progress,0)
 }finally{t.mock.timers.reset()}
})

test('Codex native fork renews its idle timer on active branch text and reasoning',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let child,started=false,progress=0
 const job=summarizeCodexFork('source','summary',{env,progress:()=>progress++,spawnProcess:fake(c=>{
  child=c;let input='';c.stdin.on('data',data=>{input+=data.toString();for(let i;(i=input.indexOf('\n'))>=0;){
   const item=JSON.parse(input.slice(0,i));input=input.slice(i+1);if(!item.id)continue
   if(item.method==='initialize')emit(c,{id:item.id,result:{}})
   if(item.method==='thread/fork')emit(c,{id:item.id,result:{thread:{id:'branch'}}})
   if(item.method==='turn/start'){emit(c,{id:item.id,result:{}});started=true}
  }})
 })})
 try{
  await until(()=>started)
  for(const method of ['item/agentMessage/delta','item/reasoning/textDelta','item/reasoning/summaryTextDelta']){
   t.mock.timers.tick(540000);emit(child,{method,params:{threadId:'branch',delta:'progress'}});await new Promise(setImmediate)
  }
  emit(child,{method:'item/completed',params:{threadId:'branch',item:{type:'agentMessage',text:'# History\nSynthetic evidence.'}}})
  emit(child,{method:'turn/completed',params:{threadId:'branch',turn:{status:'completed'}}})
  assert.match((await job).text,/Synthetic evidence/);assert.equal(progress,3)
 }finally{t.mock.timers.reset()}
})

test('native background worker forwards progress to its outer idle timer',async t=>{
 const {store}=archive(t),plan=planMainFork(store,'session',{force:true,env:{}})
 t.mock.timers.enable({apis:['setTimeout','setInterval']});let touch,release
 const gate=new Promise(resolve=>release=resolve),job=generateMainFork(store,'session',{env:{},queuedPlan:plan,summarize:async(_h,_s,_p,options)=>{touch=options.progress;await gate;return {text:treeAnswer(plan),model:'synthetic'}}})
 try{
  await until(()=>!!touch)
  for(let i=0;i<3;i++){t.mock.timers.tick(540000);touch();await new Promise(setImmediate)}
  release();assert.equal((await job).calls,1)
 }finally{release();await job.catch(()=>{});t.mock.timers.reset()}
})

test('native background worker retries beyond three failures without another foreground turn',async t=>{
 const {store,file,row}=archive(t),counter=join(file,'..','attempt-count.json'),bin=join(file,'..','fake-claude.mjs')
 writeFileSync(bin,`#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs'\nconst file=${JSON.stringify(counter)};let n=0;try{n=JSON.parse(readFileSync(file))}catch{}\nwriteFileSync(file,JSON.stringify(++n));let prompt='';for await(const part of process.stdin)prompt+=part;writeFileSync(file+'.prompt-'+n,prompt)\nconst plan=JSON.parse(prompt.split('\\n').find(s=>s.startsWith('[{"index":')))\nconst text=JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical evidence\\nOriginal user constraints and pending work remain active.'}))})\nconsole.log(JSON.stringify(n===1?{type:'result',is_error:true,result:'rate_limit_error secret-credential'}:n===2?{type:'result',subtype:'success',result:'{\"blocks\":[]}',stop_reason:'end_turn'}:n===3?{type:'result',subtype:'success',result:'{broken',stop_reason:'end_turn'}:{type:'result',subtype:'success',result:text,stop_reason:n===4?'max_tokens':'end_turn'}))\n`,{mode:0o700})
 t.mock.timers.enable({apis:['setTimeout','setInterval']})
 const scoped={...env,SUPERLCM_CLAUDE_CLI_BIN:bin}
 let error,finished=false
 const job=runSummaryWorker(store,'session',{env:scoped})
 job.then(()=>{finished=true},e=>{error=e;finished=true})
 try{
  for(let i=1;i<=4;i++){
   await until(()=>finished||store.latestSummaryRun('session')?.error_message?.includes('第 '+i+' 次未完成'))
   assert.equal(error,undefined,'a failed attempt must not terminate the background worker')
   assert.equal(finished,false)
   const run=store.latestSummaryRun('session')
   assert.equal(run.state,'running');assert.ok(!run.error_message.includes('secret-credential'))
   assert.equal(run.error_kind,['rate_limit','response_invalid','response_invalid','stream_cutoff'][i-1])
   assert.equal(store.nodeRows('session',0).length,0)
   if(i===2){appendFileSync(file,row(4));store.ingest('session',file)}
   t.mock.timers.tick(30000*2**(i-1))
  }
  const result=await job
  const {readFileSync}=await import('node:fs')
  assert.equal(result.calls,5);assert.equal(JSON.parse(readFileSync(counter)),5)
  const first=readFileSync(counter+'.prompt-1','utf8'),last=readFileSync(counter+'.prompt-5','utf8')
  assert.equal(last.slice(0,first.length),first,'retries retain the original plan and only append correction instructions')
  assert.match(last,/previous response failed summary validation/)
  assert.equal(store.latestSummaryRun('session').state,'done')
  assert.equal(store.nodeRows('session',0).length,1)
  assert.ok(store.nodeRows('session',0).every(n=>n.last<4))
 }finally{
  store.setGlobalSetting('off');t.mock.timers.tick(10000)
  await job.catch(()=>{});t.mock.timers.reset()
 }
})

test('an attempt timeout does not end the job and a late response cannot publish',async t=>{
 const {store}=archive(t),plan=planMainFork(store,'session',{force:true,env:{}})
 let calls=0,release
 const gate=new Promise(resolve=>release=resolve)
 t.mock.timers.enable({apis:['setTimeout','setInterval']})
 const controller=new AbortController(),job=generateMainFork(store,'session',{env:{},signal:controller.signal,retry:true,queuedPlan:plan,summarize:async()=>{calls++;return calls===1?gate:{text:treeAnswer(plan),model:'current'}}})
 job.catch(()=>{})
 try{
  await until(()=>calls===1)
  t.mock.timers.tick(600001);await new Promise(setImmediate)
  release({text:treeAnswer(plan),model:'obsolete'});await new Promise(setImmediate)
  assert.equal(store.nodeRows('session',0).length,0)
  t.mock.timers.tick(30000)
  const result=await job
  assert.equal(result.calls,2);assert.equal(calls,2)
  assert.equal(store.nodeRows('session',0)[0].model,'current')
 }finally{controller.abort();await job.catch(()=>{});t.mock.timers.reset()}
})

test('retrying publication reuses the completed native summary without another model call',async t=>{
 const {store}=archive(t),plan=planMainFork(store,'session',{force:true,env:{}}),controller=new AbortController()
 let calls=0,failed=false
 const prepare=store.db.prepare.bind(store.db)
 store.db.prepare=(sql,...args)=>{
  if(!failed&&sql==='INSERT OR IGNORE INTO nodes VALUES(?,?,?,?,?,?,?,?,?)'){failed=true;throw Error('temporary SQLite write failure')}
  return prepare(sql,...args)
 }
 t.mock.timers.enable({apis:['setTimeout','setInterval']})
 const job=generateMainFork(store,'session',{env:{},retry:true,queuedPlan:plan,signal:controller.signal,summarize:async()=>{calls++;return {text:treeAnswer(plan),model:'current'}}})
 job.catch(()=>{})
 try{
  await until(()=>failed);await new Promise(setImmediate)
  assert.equal(store.nodeRows('session',0).length,0)
  t.mock.timers.tick(30000)
  const result=await job
  assert.equal(calls,1);assert.equal(result.calls,1);assert.equal(result.created,plan.tree.length)
 }finally{controller.abort();await job.catch(()=>{});t.mock.timers.reset()}
})

for(const change of ['settings','source','lease','cancel'])test('retry stops when '+change+' invalidates the frozen native branch',async t=>{
 const {store}=archive(t),plan=planMainFork(store,'session',{force:true,env:{}}),controller=new AbortController()
 let calls=0
 t.mock.timers.enable({apis:['setTimeout','setInterval']})
 const job=generateMainFork(store,'session',{env:{},retry:true,queuedPlan:plan,signal:controller.signal,summarize:async()=>{calls++;throw Error('temporary provider failure')}})
 job.catch(()=>{})
 try{
  await until(()=>calls===1);await new Promise(setImmediate)
  if(change==='settings')store.setGlobalSetting('off')
  if(change==='source')store.db.prepare('UPDATE events SET digest=? WHERE session=? AND ordinal=?').run('changed','session',plan.originals[0].ordinal)
  if(change==='lease')store.db.prepare('UPDATE leases SET owner=? WHERE session=?').run('new-owner','session')
  if(change==='cancel')controller.abort(Error('cancelled'))
  t.mock.timers.tick(30000)
  await assert.rejects(job)
  assert.equal(calls,1);assert.equal(store.nodeRows('session',0).length,0)
 }finally{controller.abort();await job.catch(()=>{});t.mock.timers.reset()}
})
test('queued fork freezes source, saves all levels atomically, and keeps appended originals',async t=>{
 const {store,file,row}=archive(t),queued=enqueueSummary(store,'session',{env:{}})
 const plan=JSON.parse(store.db.prepare('SELECT plan FROM fork_summary_plans WHERE run_id=?').get(queued.run.id).plan)
 appendFileSync(file,row(4));store.ingest('session',file);let calls=0
 const result=await generateMainFork(store,'session',{env:{},queuedPlan:plan,summarize:async()=>{calls++;return {text:treeAnswer(plan),model:'current-model',usage:{cacheRead:300000}}}})
 assert.equal(calls,1);assert.equal(result.created,plan.tree.length)
 assert.ok(store.nodeRows('session',0).every(n=>n.last<4));assert.match(store.exact('session',4),/Original evidence 4/)
 assert.equal(JSON.parse(store.db.prepare('SELECT usage FROM fork_summary_receipts').get().usage).cacheRead,300000)
})
test('setting changes and missing source cannot publish a partial fork tree',async t=>{
 const {store}=archive(t),plan=planMainFork(store,'session',{force:true,env:{}})
 await assert.rejects(generateMainFork(store,'session',{env:{},summarize:async()=>{store.setGlobalSetting('off');return {text:treeAnswer(plan),model:'obsolete'}}}),/已变化/)
 assert.equal(store.nodeRows('session',0).length,0);assert.equal(store.summarizing('session'),false)
 store.setGlobalSetting('main-fork')
 await assert.rejects(generateMainFork(store,'session',{env:{},summarize:async()=>({text:'{"error":"missing_source"}',model:'current'})}),/缺失/)
 assert.equal(store.nodeRows('session',0).length,0)
})
test('native automatic branches require known 70% usage and deduplicate a live session',t=>{
 const {store}=archive(t,{count:24,size:16000});let spawns=0
 const options={env:{},window:100000,spawnProcess:()=>{spawns++;return Object.assign(new EventEmitter(),{pid:process.pid,unref(){}})}}
 assert.equal(scheduleSummary(store,'session','main-fork',null,{...options,tokens:69000}),false)
 assert.equal(scheduleSummary(store,'session','main-fork',null,{...options,tokens:0,window:0}),false)
 assert.equal(scheduleSummary(store,'session','main-fork',null,{...options,tokens:70000}),true)
 assert.equal(scheduleSummary(store,'session','main-fork',null,{...options,tokens:71000}),false)
 assert.equal(spawns,1)
})

test('Claude replacement cannot initiate a synchronous rescue in background-branch mode',async()=>{
 const {prepareClaudeRescue}=await import('../src/claude-rescue-store.js')
 const store={effectiveSetting:()=>({mode:'main-fork'}),get db(){throw Error('replacement must not create generation work')}}
 const result=prepareClaudeRescue(store,'fixture',{})
 assert.equal(result.use,false);assert.equal(result.work,undefined)
})

test('Claude preparation precedes a separately configured replacement threshold',async()=>{
 const {forkPreparationThreshold}=await import('../src/main-fork.js')
 const store={takeover:()=>({enabled:true,window:300000}),metadata:()=>({harness:'claude-code'})}
 assert.equal(forkPreparationThreshold(store,'s',1000000),262500)
 assert.equal(forkPreparationThreshold(store,'s',200000),140000)
 store.metadata=()=>({harness:'codex'});assert.equal(forkPreparationThreshold(store,'s',1000000),700000)
})

 test('Claude optional summary model is passed only to the fork invocation',async()=>{
  let selected
  const spawnProcess=fake((child,args)=>{selected=args;child.stdin.on('finish',()=>{emit(child,{type:'result',subtype:'success',result:'complete summary',model:'chosen'});child.exitCode=0;child.emit('close',0)})})
  const result=await summarizeClaudeFork('source','summary directive',{env,model:'chosen',spawnProcess})
  assert.ok(selected.includes('--fork-session'));assert.equal(selected[selected.indexOf('--model')+1],'chosen');assert.equal(result.model,'chosen')
 })
