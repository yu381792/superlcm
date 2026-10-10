import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ClaudeStore } from '../src/store.js'
import { summarizeWithModel, buildHierarchy, summaryWork } from '../src/summarize.js'
import { fitSummary, profileKey, readSummaryProfile, visibleOutputRoom, isReducedSummary, CAPPED_TAG } from '../src/summary-generation.js'
import { planCompaction } from '../src/compaction.js'
import { startWeb } from '../src/web.js'
const fixture = t => {
 const dir=mkdtempSync(join(tmpdir(),'superlcm-issues234-')),store=new ClaudeStore(join(dir,'store')),file=join(dir,'source.jsonl')
 writeFileSync(file,[{role:'user',content:'Never deploy without approval.'},{role:'assistant',content:'Unresolved work only.'}].map(JSON.stringify).join('\n')+'\n')
 store.ingest('s',file);store.setMetadata('s',{harness:'claude-code',externalId:'s'})
 t.after(()=>store.close());return {dir,store,file}
}
const reply=(content,finish='stop',extra={})=>new Response(JSON.stringify({choices:[{message:{content:finish==='stop'?(/^#/.test(content)?content:'# '+content):content},finish_reason:finish}],...extra}))
const options=(model,fetchImpl,extra={})=>({model,apiProvider:'openai',baseURL:'http://127.0.0.1:9',fetchImpl,...extra})
const reasoning={completion_tokens:2048,completion_tokens_details:{reasoning_tokens:2048}}

test('reasoning evidence adds headroom once and survives a store reopen without storing credentials',async t=>{
 const {store}=fixture(t),caps=[]
 let calls=0
 const opts=options('reasoner-persist',async(_url,request)=>{
  caps.push(JSON.parse(request.body).max_tokens);calls++
  return calls===1?reply('','length',{usage:reasoning}):reply('# A complete source-grounded summary.','stop',{usage:{completion_tokens:5000,completion_tokens_details:{reasoning_tokens:4500}}})
 },{profileStore:store})
 assert.equal(await summarizeWithModel('Synthetic source',opts),'# A complete source-grounded summary.')
 assert.equal(calls,2);assert.ok(caps[1]>caps[0])
 const reopened=new ClaudeStore(store.dir);t.after(()=>reopened.close())
 const saved=readSummaryProfile(profileKey('http://127.0.0.1:9/v1/chat/completions','reasoner-persist',null),reopened)
 assert.ok(saved.reasoning_room>=6548)
 let nextCap
 await summarizeWithModel('Synthetic source',options('reasoner-persist',async(_url,r)=>{nextCap=JSON.parse(r.body).max_tokens;return reply('# Next complete summary.')},{profileStore:reopened}))
 assert.ok(nextCap>=caps[1])
 const row=store.db.prepare('SELECT * FROM summary_model_profiles').get();assert.match(row.key,/^[a-f0-9]{64}$/)
})

test('CJK visible room follows source density, independent of hidden reasoning',()=>{
 assert.equal(visibleOutputRoom('中'.repeat(20000)),9000)
 assert.equal(visibleOutputRoom('English '.repeat(5000)),2048)
})

test('reasoning text evidence in JSON and SSE permits exactly one bounded retry',async()=>{
 for(const format of ['json','sse']){
  let calls=0
  const fetchImpl=async()=>{
   calls++
   if(calls>1)return reply('# Complete summary.')
   const chunk={choices:[{index:0,delta:{reasoning_content:'private reasoning'},message:{reasoning_content:'private reasoning',content:''},finish_reason:'length'}]}
   return format==='json'?new Response(JSON.stringify(chunk)):new Response('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  }
  assert.equal(await summarizeWithModel('Source',options('reason-text-'+format,fetchImpl)),'# Complete summary.')
  assert.equal(calls,2)
 }
})

test('no reasoning evidence means no retry; repeated evidence never triggers a third call',async()=>{
 let calls=0
 await assert.rejects(summarizeWithModel('Source',options('no-reason',async()=>{calls++;return reply('','length')})),/incomplete/)
 assert.equal(calls,1)
 calls=0
 await assert.rejects(summarizeWithModel('Source',options('still-limited',async()=>{calls++;return reply('','length',{usage:reasoning})})),/reasoning_tokens 2048, completion_tokens 2048/)
 assert.equal(calls,2)
})

test('profiles are scoped by endpoint, model and effort and never trust response model fields',async t=>{
 const {store}=fixture(t)
 await summarizeWithModel('Source',options('scope-a',async()=>reply('# Complete.','stop',{model:'credential-secret',usage:reasoning}),{profileStore:store}))
 assert.equal(readSummaryProfile(profileKey('http://127.0.0.1:9/v1/chat/completions','scope-b',null),store).reasoning_room,0)
 assert.equal(readSummaryProfile(profileKey('http://127.0.0.1:10/v1/chat/completions','scope-a',null),store).reasoning_room,0)
 assert.equal(readSummaryProfile(profileKey('http://127.0.0.1:9/v1/chat/completions','scope-a','high'),store).reasoning_room,0)
 assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT * FROM summary_model_profiles').all()),/secret|scope-a/)
})

test('OpenAI parameter negotiation also applies to the evidence retry',async()=>{
 const requests=[]
 await summarizeWithModel('Source',options('completion-negotiation',async(_url,r)=>{
  const b=JSON.parse(r.body);requests.push(b)
  if(requests.length===1)return new Response('Use max_completion_tokens',{status:400})
  if(requests.length===2)return reply('','length',{usage:reasoning})
  return reply('# Completed.')
 }))
 assert.equal(requests.length,3)
 assert.ok(requests[2].max_completion_tokens>requests[1].max_completion_tokens)
 assert.equal(requests[2].max_tokens,undefined)
})

test('length repair takes zero extra calls for compliant models and at most two for overshoot',async()=>{
 let calls=0
 assert.equal(await summarizeWithModel('Source',options('compliant',async()=>{calls++;return reply('# Complete.')})),'# Complete.')
 assert.equal(calls,1)
 calls=0
 const prompts=[]
 const result=await summarizeWithModel('Source',options('repair-twice',async(_url,r)=>{
  prompts.push(JSON.parse(r.body).messages.at(-1).content);calls++
  return reply(calls===1?'A'.repeat(15000):calls===2?'B'.repeat(9000):'# Repaired with critical constraints intact.')
 }))
 assert.equal(calls,3);assert.equal(result,'# Repaired with critical constraints intact.')
 assert.match(prompts[1],/about \d+%/);assert.match(prompts[1],/untrusted historical data/)
})

test('stubborn complete models stop early and produce a marked limited navigation node',async t=>{
 const {store}=fixture(t);let calls=0
 await buildHierarchy(store,'s',{model:'stubborn-cli',batchSize:2,summarize:async()=>{calls++;return '# Details\n'+'Detail line\n'.repeat(800)}})
 assert.equal(calls,2)
 const node=store.nodeRows('s',0)[0]
 assert.ok(node.summary.length<=6000);assert.match(node.summary,/records #0–#1/)
 assert.ok(isReducedSummary(node.summary));assert.equal(store.reducedSummaryCount('s'),1)
 assert.equal(store.exact('s',0),readFileSync(store.source('s').path,'utf8').split('\n')[0]+'\n')
 const events=store.eventRows('s'),messages=events.map(e=>({role:e.preview.split(': ')[0],text:e.preview.split(': ')[1]}))
 const decision=planCompaction({meta:{code:'s'},events,nodes:store.nodeRows('s',0),messages,tokens:250000})
 assert.equal(decision.use,false);assert.match(decision.reason,/navigation only/)
})

test('incomplete or empty repair cannot produce a capped node',async()=>{
 for(const content of ['', 'partial']){
  let calls=0
  await assert.rejects(summarizeWithModel('Source',options('repair-cut-'+content,async()=>{calls++;return calls===1?reply('X'.repeat(10000)):reply(content,'length')})),/incomplete/)
  assert.equal(calls,2)
 }
})

test('overshoot profile reduces the next requested length and preserves the final 6000 limit',async t=>{
 const {store}=fixture(t);let calls=0
 await summarizeWithModel('Source',options('verbose-profile',async()=>{calls++;return reply(calls===1?'A'.repeat(12000):'Complete repaired summary.')},{profileStore:store}))
 let prompt
 await summarizeWithModel('Source',options('verbose-profile',async(_url,r)=>{prompt=JSON.parse(r.body).messages.at(-1).content;return reply('Complete next summary.')},{profileStore:store}))
 assert.match(prompt,/no more than 2999 characters/)
})

test('merged reduced summaries retain degraded status even if the model omits the marker',async t=>{
 const {store,file}=fixture(t)
 appendFileSync(file,Array.from({length:6},(_,i)=>JSON.stringify({role:'user',content:'Long source '+i})).join('\n')+'\n');store.ingest('s',file)
 for(let i=0;i<4;i++)store.addNode({session:'s',id:'leaf'+i,level:0,first:i*2,last:i*2+1,children:[],summary:(i===0?CAPPED_TAG:'')+' complete source summary '.repeat(100),digest:'d'+i,model:'fixture'})
 assert.equal(summaryWork(store,'s',{fanout:4,targetTokens:20000}).reducedSources,true)
 await buildHierarchy(store,'s',{model:'merge-fixture',batchSize:2,fanout:4,targetTokens:20000,summarize:async()=> '# A complete merged summary without marker.'})
 assert.ok(isReducedSummary(store.nodeRows('s',1)[0].summary))
})

test('configuration changes prevent evidence retry or repair from making extra calls',async()=>{
 let allowed=true,calls=0
 await assert.rejects(summarizeWithModel('Source',options('cancel-retry',async()=>{calls++;allowed=false;return reply('','length',{usage:reasoning})},{shouldContinue:()=>allowed})),/cancelled/)
 assert.equal(calls,1)
})

test('actual compact-packet writes decline, exception and success diagnostics to console and doctor',async t=>{
 const {store,dir}=fixture(t),env={...process.env,SUPERLCM_HOME:store.dir,HOME:dir,CLAUDE_CONFIG_DIR:join(dir,'claude')}
 store.setTakeover({enabled:true,window:300000})
 const run=input=>JSON.parse(spawnSync(process.execPath,['src/cli.js','compact-packet','s'],{env,input,encoding:'utf8'}).stdout)
 const messages=[{role:'user',text:'Never deploy without approval.'},{role:'assistant',text:'Unresolved work only.'}]
 assert.equal(run(JSON.stringify({messages,tokens:250000,trigger:'auto'})).use,false)
 assert.equal(store.lastCompactionDiagnostic('s').code,'no_summaries')
 assert.equal(store.lastCompactionDiagnostic('s').trigger,'auto')
 assert.equal(run('bad SECRET CREDENTIAL json').error,true)
 assert.equal(store.lastCompactionDiagnostic('s').status,'error');assert.doesNotMatch(JSON.stringify(store.lastCompactionDiagnostic('s')),/SECRET|CREDENTIAL/)
 const diagnostics=spawnSync(process.execPath,['src/cli.js','doctor-local'],{env,encoding:'utf8'})
 assert.equal(diagnostics.status,0,diagnostics.stderr)
 assert.equal(JSON.parse(diagnostics.stdout).compaction_diagnostics[0].code,'planner_exception')
 store.addNode({session:'s',id:'ready',level:0,first:0,last:1,children:[],summary:'Effective constraints preserved.',digest:'fixture',model:'fixture'})
 // Add enough turns to retain two without retaining the entire context.
 const all=[...messages,{role:'user',text:'next task'},{role:'assistant',text:'next answer'},{role:'user',text:'latest task'}]
 // Unknown current messages are not silently accepted; use the source-backed sequence.
 appendFileSync(store.source('s').path,all.slice(2).map(m=>JSON.stringify({role:m.role,content:m.text})).join('\n')+'\n')
 assert.equal(run(JSON.stringify({messages:all,tokens:30000})).use,true)
 assert.equal(store.lastCompactionDiagnostic('s').status,'takeover')
 const web=await startWeb({store:new ClaudeStore(store.dir),env,discovery:async()=>[],catalog:async()=>({models:[]})});t.after(()=>web.close())
 const detail=await fetch(web.url+'api/conversation?session=s').then(r=>r.json())
 assert.equal(detail.last_compaction.status,'takeover');assert.equal(detail.last_compaction.through_record,1)
 assert.equal(detail.last_compaction.records,5)
})

test('mechanical fallback handles Unicode boundaries and includes its warning within the cap',async()=>{
 let repairs=0
 const summary=await fitSummary('😀'.repeat(6000),async()=>{repairs++;return '😀'.repeat(5999)},{task:{first:10,last:30}})
 assert.equal(repairs,1);assert.ok(summary.length<=6000)
 assert.match(summary,/records #10–#30/);assert.doesNotMatch(summary,/[\uD800-\uDBFF]$/)
})

test('configuration change during a CLI draft prevents any repair call and any node publication',async t=>{
 const {store}=fixture(t);let calls=0
 await assert.rejects(buildHierarchy(store,'s',{model:'cancel-cli',batchSize:2,summarize:async()=>{calls++;store.setGlobalSetting('off');return '# Details\n'+'X'.repeat(12000)}}),/cancelled/)
 assert.equal(calls,1);assert.equal(store.nodeRows('s',0).length,0)
})

test('Claude in-host writer repairs complete overshoot and validates each call against the current claim',async()=>{
 const {register}=await import('../hooks/compact-mod.js'),hooks=new Map();register((event,hook)=>hooks.set(event,hook))
 let claims=0,checks=0,calls=0,saved
 let done;const completed=new Promise(resolve=>{done=resolve})
 const $={plugin:{root:'.'},session:{id:async()=> 'host-overshoot-fixture',model:async()=> 'claude-fixture'},model:{complete:async opts=>{calls++;assert.equal(opts.maxTokens,9000);return {isAnswered:true,text:'Whole line\n'.repeat(800),stopReason:'end_turn'}}},process:{run:async(args,options)=>{
  const command=args[2]
  if(command==='summary-claim')return {stdout:JSON.stringify(++claims===1?{work:{batch_id:'b',system:'Policy',prompt:'Synthetic excerpt',maxTokens:9000,task:{first:1,last:4}}}:{})}
  if(command==='summary-check'){checks++;return {stdout:'{"valid":true}'}}
  if(command==='summary-save'){saved=JSON.parse(options.stdin);done();return {stdout:'{"saved":true,"more":false}'}}
  if(command==='summary-handoff'){done();return {stdout:'{}'}}
  return {stdout:'{}'}
 }}}
 await hooks.get('turn.complete')($,{},async()=>({}))
 await completed
 assert.equal(calls,2);assert.equal(checks,4);assert.ok(saved.isAnswered);assert.ok(isReducedSummary(saved.summary));assert.ok(saved.summary.length<=6000)
})

test('Claude in-host writer never caps incomplete text or makes a call after claim invalidation',async()=>{
 const {register}=await import('../hooks/compact-mod.js')
 for(const invalidated of [false,true]){
  const hooks=new Map();register((event,hook)=>hooks.set(event,hook))
  let calls=0,saves=0,errors=0,checks=0,done
  const completed=new Promise(resolve=>{done=resolve})
  const $={plugin:{root:'.'},session:{id:async()=> 'host-incomplete-'+invalidated,model:async()=> 'fixture'},model:{complete:async()=>{calls++;return {isAnswered:true,text:invalidated?'X'.repeat(12000):'partial answer',stopReason:invalidated?'end_turn':'max_tokens'}}},process:{run:async args=>{
   const command=args[2]
   if(command==='summary-claim')return {stdout:JSON.stringify({work:{batch_id:'b',system:'Policy',prompt:'Synthetic excerpt'}})}
   if(command==='summary-check')return {stdout:JSON.stringify({valid:++checks===1})}
   if(command==='summary-save'){saves++;return {stdout:'{}'}}
   if(command==='summary-host-error')errors++
   if(command==='summary-handoff')done()
   return {stdout:'{}'}
  }}}
  await hooks.get('turn.complete')($,{},async()=>({}));await completed
  assert.equal(calls,1);assert.equal(checks,2);assert.equal(saves,0);assert.equal(errors,1)
 }
})

test('closing takeover records native handling instead of leaving a stale successful diagnostic',t=>{
 const {store}=fixture(t)
 store.noteCompaction('s',{status:'takeover',code:'takeover',reason:'Synthetic success'})
 store.setTakeover({enabled:false})
 const run=spawnSync(process.execPath,['src/cli.js','compact-packet','s'],{env:{...process.env,SUPERLCM_HOME:store.dir},input:JSON.stringify({messages:[],tokens:1000}),encoding:'utf8'})
 assert.equal(run.status,0)
 assert.equal(store.lastCompactionDiagnostic('s').status,'native')
 assert.equal(store.lastCompactionDiagnostic('s').code,'disabled')
})

test('unsafe HTTP bodies, transport errors and malformed JSON never enter user diagnostics',async()=>{
 for(const fetchImpl of [
  async()=>new Response('SECRET SOURCE AND CREDENTIAL',{status:500}),
  async()=>new Response('SECRET SOURCE AND CREDENTIAL',{status:400}),
  async()=>{throw Error('SECRET SOURCE AND CREDENTIAL')},
  async()=>new Response('SECRET SOURCE AND CREDENTIAL',{headers:{'content-type':'application/json'}})
 ])await assert.rejects(summarizeWithModel('Source',options('safe-diagnostics',fetchImpl)),error=>error.summaryDiagnostic===true&&!/SECRET|CREDENTIAL/.test(error.message))
})

test('a real summary-check renews the lease and rejects stale setting revisions',t=>{
 const {store}=fixture(t),env={...process.env,SUPERLCM_HOME:store.dir}
 const {summarySettingsRevision}=summarySettings
 store.setGlobalSetting('cli')
 const work=summaryWork(store,'s',{batchSize:2})
 store.lease('s',20000,'host')
 store.db.prepare('INSERT INTO host_summary_claims(session,batch_id,revision) VALUES(?,?,?)').run('s',work.batch_id,summarySettingsRevision(store,'s'))
 const before=store.db.prepare('SELECT until_ms FROM leases WHERE session=?').get('s').until_ms
 const run=()=>JSON.parse(spawnSync(process.execPath,['src/cli.js','summary-check','s'],{env,input:JSON.stringify({batch_id:work.batch_id}),encoding:'utf8'}).stdout)
 assert.equal(run().valid,true)
 assert.ok(store.db.prepare('SELECT until_ms FROM leases WHERE session=?').get('s').until_ms>before+200000)
 store.setGlobalSetting('off')
 assert.notEqual(run().valid,true)
})

import * as summarySettings from '../src/summarize.js'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { summarizeWithHermes } from '../src/cli-writers.js'
import { summarizeWithCodexCli } from '../src/codex-cli.js'
const fakeProcess=output=>()=>{
 const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{}})
 queueMicrotask(()=>{child.stdout.end(output);child.stderr.end();child.emit('close',0)})
 return child
}
test('Hermes length termination and Codex missing final turn cannot enter repair or storage',async t=>{
 const {dir}=fixture(t)
 await assert.rejects(summarizeWithHermes('Source',{bin:'synthetic',cwd:join(dir,'hermes'),summaryTask:{allowOversize:true},spawnProcess:fakeProcess(JSON.stringify({type:'result',exit_code:0,text:'Partial summary',finish_reason:'length'})+'\n')}))
 const message=JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Partial summary'}})+'\n'
 await assert.rejects(summarizeWithCodexCli('Source',{bin:'synthetic',cwd:join(dir,'codex'),summaryTask:{allowOversize:true},spawnProcess:fakeProcess(message)}),/incomplete/)
 assert.equal(await summarizeWithCodexCli('Source',{bin:'synthetic',cwd:join(dir,'codex'),summaryTask:{allowOversize:true},spawnProcess:fakeProcess(message+JSON.stringify({type:'turn.completed'})+'\n')}),'Partial summary')
})

test('Claude module dependencies are pure JavaScript and contain no forbidden builtin imports',()=>{
 const root=new URL('../hooks/compact-mod.js',import.meta.url),seen=new Set()
 const scan=url=>{
  if(seen.has(url.href))return;seen.add(url.href)
  const source=readFileSync(url,'utf8')
  for(const [,specifier] of source.matchAll(/(?:import|export)[^;\n]*?from\s*['"]([^'"]+)['"]/g)){
   assert.ok(specifier.startsWith('.'),`Claude dependency ${specifier} must remain sandbox compatible`)
   scan(new URL(specifier,url))
  }
 }
 scan(root)
 assert.ok(seen.has(new URL('../src/summary-fitting.js',import.meta.url).href))
})

test('JSON cannot forge local stream completion evidence',async()=>{
 await assert.rejects(summarizeWithModel('Source',options('forged-complete',async()=>new Response(JSON.stringify({streamCompleted:true,choices:[{message:{content:'partial JSON'}}]})))),/no terminal finish reason/)
})

test('configuration changes also block HTTP parameter negotiation retries',async()=>{
 let allowed=true,calls=0
 await assert.rejects(summarizeWithModel('Source',options('cancel-negotiation',async()=>{calls++;allowed=false;return new Response('Use max_completion_tokens',{status:400})},{shouldContinue:()=>allowed})),/cancelled/)
 assert.equal(calls,1)
})

test('losing the API writer lease prevents an evidence retry before another billed request',async t=>{
 const {store}=fixture(t);let calls=0
 await assert.rejects(buildHierarchy(store,'s',{model:'api-lease-loss',apiKey:'',apiProvider:'openai',baseURL:'http://127.0.0.1:9',batchSize:2,fetchImpl:async()=>{
  calls++
  const current=store.db.prepare('SELECT owner FROM leases WHERE session=?').get('s').owner
  store.release('s',current);store.lease('s',300000,'other-writer')
  return reply('','length',{usage:reasoning})
 }}),/lost its lease/)
 assert.equal(calls,1);assert.equal(store.nodeRows('s',0).length,0)
 assert.equal(store.db.prepare('SELECT owner FROM leases WHERE session=?').get('s').owner,'other-writer')
})

test('the first evidence retry leaves room for the reported seven-thousand-token reasoning case',async()=>{
 let calls=0
 const result=await summarizeWithModel('Source',options('seven-k-reasoning',async(_url,r)=>{
  calls++;const cap=JSON.parse(r.body).max_tokens
  return cap<9000?reply('','length',{usage:{completion_tokens:cap,completion_tokens_details:{reasoning_tokens:cap}}}):reply('# Complete after reasoning.','stop',{usage:{completion_tokens:8000,completion_tokens_details:{reasoning_tokens:7000}}})
 }))
 assert.equal(result,'# Complete after reasoning.');assert.equal(calls,2)
})

test('a cancelled in-host writer does not report a failure against the new settings',t=>{
 const {store}=fixture(t)
 store.setGlobalSetting('cli');store.lease('s',300000,'host')
 store.db.prepare('INSERT INTO host_summary_claims(session,batch_id,revision) VALUES(?,?,?)').run('s','synthetic',summarySettings.summarySettingsRevision(store,'s'))
 store.setGlobalSetting('off')
 const run=spawnSync(process.execPath,['src/cli.js','summary-host-error','s'],{env:{...process.env,SUPERLCM_HOME:store.dir},encoding:'utf8'})
 assert.equal(run.status,0,run.stderr);assert.equal(store.source('s').status,'ok');assert.equal(store.summaryError('s'),null)
})
