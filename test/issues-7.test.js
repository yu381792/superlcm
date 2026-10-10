import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { ClaudeStore, claudeTranscript } from '../src/store.js'
import { summaryTick, catchUp, catchupDeadlineMs, pendingLeaves } from '../src/summary-background.js'
import { summaryWork, summarySettingsRevision, buildHierarchy } from '../src/summarize.js'
import { register } from '../hooks/compact-mod.js'
process.env.SUPERLCM_SEGMENT_MESSAGES='2'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => { let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve} }
const flush = async () => { for(let n=0;n<8;n++)await new Promise(r=>setImmediate(r)) }
let serial=0
const text = '# Current state\nThe user permitted a dry-run only. Deployment remains pending. The synthetic tool reported failure.'
const answered = () => ({isAnswered:true,text,stopReason:'end_turn'})
const hooks = () => {const out=new Map();register((name,hook)=>out.set(name,hook));return out}
function hostFixture({run,complete=async()=>answered()}={}) {
  const id='issue7-host-'+(++serial),commands=[],modelCalls=[],h=hooks()
  const $={plugin:{root:'.'},session:{id:async()=>id,model:async()=> 'synthetic-host',usage:async()=>({context:{tokens:240000,window:300000}})},model:{complete:async opts=>{modelCalls.push(opts);return complete(opts)}},process:{run:async(args,opts)=>{
    const command=args[2],entry={command,args,opts,input:opts.stdin?JSON.parse(opts.stdin):null};commands.push(entry)
    const result=await run?.(entry)
    return {stdout:JSON.stringify(result??{})}
  }}}
  return {$,id,h,commands,modelCalls}
}
const work = n => ({work:{batch_id:'batch-'+n,claim_id:'claim-'+n,system:'Synthetic policy',prompt:'Synthetic source',model:'synthetic-host',task:{level:0,requireHeading:true},maxTokens:2048}})
const messages = [{role:'user',text:'Synthetic task'},{role:'assistant',text:'Synthetic progress'},{role:'user',text:'Synthetic current request'}]
function fixture(t,{rows=6,large=false,mode='cli'}={}) {
  const dir=mkdtempSync(join(tmpdir(),'superlcm-issue7-')),config=join(dir,'claude'),project=join(config,'projects','synthetic')
  mkdirSync(project,{recursive:true})
  const file=join(project,'synthetic-session.jsonl'),store=new ClaudeStore(join(dir,'store'))
  const records=Array.from({length:rows},(_,i)=>({role:i%2?'assistant':'user',content:(i%2?'Synthetic progress ':'Please preserve files and wait for approval ')+i+(large?' x'.repeat(7000):'')}))
  writeFileSync(file,records.map(JSON.stringify).join('\n')+'\n')
  store.ingest('synthetic-session',file);store.setMetadata('synthetic-session',{harness:'claude-code',externalId:'synthetic-session'})
  store.setHarnessSetting('claude-code',mode,mode==='cli'?'synthetic-host':null)
  t.after(()=>store.close())
  const safeEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^SUPERLCM_|^CLAUDE_CONFIG_DIR$|(?:API_KEY|TOKEN|SECRET|CREDENTIAL)/.test(key)))
  const env={...safeEnv,SUPERLCM_HOME:store.dir,CLAUDE_CONFIG_DIR:config,SUPERLCM_SEGMENT_MESSAGES:'2',SUPERLCM_CLAUDE_CLI_BIN:process.execPath}
  const run=(command,input='',flags=[])=>{
    const r=spawnSync(process.execPath,['src/cli.js',command,'synthetic-session',...flags],{env,input:typeof input==='string'?input:JSON.stringify(input),encoding:'utf8',timeout:8000})
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim())
  }
  return {dir,config,file,store,env,run,records,id:'synthetic-session'}
}

test('turn.step observes a long turn immediately and preserves the exact next event',async()=>{
  const blocked=deferred(),seen=deferred()
  const f=hostFixture({run:async({command})=>{if(command==='summary-tick'){seen.resolve();await blocked.promise;return {host:true}}if(command==='summary-claim')return work(1);if(command==='summary-check')return {valid:true};if(command==='summary-save')return {saved:true,more:false}}})
  const event={turnId:'long-synthetic-turn',index:50,messageCount:200},out={unchanged:true}
  assert.equal(f.h.get('turn.step')(f.$,event,e=>{assert.equal(e,event);return out}),out)
  await seen.promise
  assert.equal(f.modelCalls.length,0)
  blocked.resolve();await flush()
  assert.equal(f.modelCalls.length,1)
  assert.equal(f.commands.filter(c=>c.command==='summary-save').length,1)
})

test('turn.step is throttled per session for 45 seconds and excludes subagents',async t=>{
  let now=1000000;t.mock.method(Date,'now',()=>now)
  const f=hostFixture(),other=hostFixture(),next=e=>e
  for(let i=0;i<10;i++)f.h.get('turn.step')(f.$,{index:i},next)
  await flush();assert.equal(f.commands.length,1)
  now+=44999;f.h.get('turn.step')(f.$,{},next);await flush();assert.equal(f.commands.length,1)
  now++;f.h.get('turn.step')(f.$,{},next);await flush();assert.equal(f.commands.length,2)
  other.h.get('turn.step')(other.$,{},next);await flush();assert.equal(other.commands.length,1)
  f.h.get('turn.step')(f.$,{agentId:'synthetic-child'},next)
  await f.h.get('turn.complete')(f.$,{agentId:'synthetic-child'},next)
  await f.h.get('session.end')(f.$,{agentId:'synthetic-child'},next)
  assert.equal(f.commands.length,2)
})

test('turn.step keeps an unfinished tick exclusive even after the throttle expires',async t=>{
  let now=1000000;t.mock.method(Date,'now',()=>now)
  const blocked=deferred(),f=hostFixture({run:async({command})=>{if(command==='summary-tick')await blocked.promise}})
  f.h.get('turn.step')(f.$,{},e=>e);await flush()
  now+=90000;f.h.get('turn.step')(f.$,{},e=>e);await flush()
  assert.equal(f.commands.length,1);blocked.resolve();await flush()
})

test('host catch-up writes at most four leaves then replans once',async()=>{
  let claims=0
  const f=hostFixture({run:async entry=>{
    if(entry.command==='compact-packet')return entry.input.afterCatchup?{use:true,start:1,packet:'Synthetic summary packet'}:{use:false,catchup:{host:true,deadlineMs:1000}}
    if(entry.command==='summary-claim'){assert.ok(entry.args.includes('--leaf'));assert.ok(entry.args.includes('--deadline'));return work(++claims)}
    if(entry.command==='summary-check')return {valid:true}
    if(entry.command==='summary-save')return {saved:true,more:true}
  }})
  const out=await f.h.get('session.compact')(f.$,{messages,trigger:'auto'},()=>assert.fail('Expected takeover'))
  await flush()
  assert.equal(out.messages[0].text,'Synthetic summary packet');assert.equal(f.modelCalls.length,4)
  const plans=f.commands.filter(c=>c.command==='compact-packet')
  assert.equal(plans.length,2);assert.equal(plans[1].input.afterCatchup,true)
  assert.equal(plans[0].opts.timeoutMs,270000);assert.equal(plans[1].opts.timeoutMs,60000)
  assert.ok(plans[1].input.catchupMs>=0)
  assert.ok(f.modelCalls.every(c=>c.timeoutMs>0&&c.timeoutMs<=1000))
})

test('catch-up timeout falls back while a late host result is never saved or retried',async()=>{
  const late=deferred()
  const f=hostFixture({complete:()=>late.promise,run:async entry=>{
    if(entry.command==='compact-packet')return entry.input.afterCatchup?{use:false}:{use:false,catchup:{host:true,deadlineMs:25}}
    if(entry.command==='summary-claim')return work(1)
    if(entry.command==='summary-check')return {valid:true}
  }})
  const before=Date.now(),native={native:true}
  assert.equal(await f.h.get('session.compact')(f.$,{messages},()=>native),native)
  assert.ok(Date.now()-before<500)
  assert.equal(f.modelCalls.length,1);assert.ok(f.modelCalls[0].timeoutMs<=25)
  await f.h.get('turn.complete')(f.$,{},()=>({}));await flush()
  assert.equal(f.modelCalls.length,1)
  assert.equal(f.commands.filter(c=>c.command==='summary-release').length,0)
  late.resolve(answered());await flush()
  assert.equal(f.commands.filter(c=>c.command==='summary-save').length,0)
  assert.equal(f.commands.filter(c=>c.command==='summary-release').length,1)
  assert.equal(f.commands.filter(c=>c.command==='summary-host-error'||c.command==='summary-handoff').length,0)
})

test('catch-up can bound an existing writer without starting a second request',async()=>{
  const late=deferred(),started=deferred()
  const f=hostFixture({complete:()=>{started.resolve();return late.promise},run:async entry=>{
    if(entry.command==='compact-packet')return entry.input.afterCatchup?{use:false}:{use:false,catchup:{host:true,deadlineMs:20}}
    if(entry.command==='summary-claim')return work(1)
    if(entry.command==='summary-check')return {valid:true}
  }})
  await f.h.get('turn.complete')(f.$,{},()=>({}));await started.promise
  await f.h.get('session.compact')(f.$,{messages},()=>({native:true}))
  assert.equal(f.modelCalls.length,1)
  late.resolve(answered());await flush()
  assert.equal(f.commands.filter(c=>c.command==='summary-save').length,0)
})

test('host cancellation prevents saving a late reply and any subsequent model call',async()=>{
  const controller=new AbortController(),late=deferred(),started=deferred()
  const f=hostFixture({complete:()=>{started.resolve();return late.promise},run:async entry=>{
    if(entry.command==='compact-packet')return entry.input.afterCatchup?{use:false}:{use:false,catchup:{host:true,deadlineMs:1000}}
    if(entry.command==='summary-claim')return work(1)
    if(entry.command==='summary-check')return {valid:true}
  }})
  const run=f.h.get('session.compact')(f.$,{messages,signal:controller.signal},()=>({native:true}))
  await started.promise;controller.abort();await run
  await f.h.get('turn.complete')(f.$,{},()=>({}));await flush()
  assert.equal(f.modelCalls.length,1)
  late.resolve(answered());await flush()
  assert.equal(f.commands.filter(c=>c.command==='summary-save').length,0)
})

test('session.end defers worker handoff until an outstanding host request has settled',async()=>{
  const late=deferred(),started=deferred()
  const f=hostFixture({complete:()=>{started.resolve();return late.promise},run:async({command})=>{
    if(command==='summary-claim')return work(1)
    if(command==='summary-check')return {valid:true}
  }})
  await f.h.get('turn.complete')(f.$,{},()=>({}));await started.promise
  await f.h.get('session.end')(f.$,{},()=>({ended:true}));await flush()
  assert.equal(f.commands.filter(c=>c.command==='summary-handoff'||c.command==='summary-release').length,0)
  late.resolve(answered());await flush()
  assert.equal(f.commands.filter(c=>c.command==='summary-save').length,0)
  assert.equal(f.commands.filter(c=>c.command==='summary-handoff').length,1)
  assert.equal(f.modelCalls.length,1)
})

test('a late step observation cannot start host work after the session has ended',async()=>{
  const late=deferred(),seen=deferred()
  const f=hostFixture({run:async({command})=>{if(command==='summary-tick'){seen.resolve();await late.promise;return {host:true}}if(command==='summary-claim')return work(1)}})
  f.h.get('turn.step')(f.$,{},e=>e);await seen.promise
  await f.h.get('session.end')(f.$,{},e=>e)
  late.resolve();await flush()
  await f.h.get('turn.complete')(f.$,{},e=>e);await flush()
  assert.equal(f.commands.filter(c=>c.command==='summary-claim').length,0)
  assert.equal(f.modelCalls.length,0)
})

test('settings invalidation after the host response prevents repair and publication',async()=>{
  let checks=0
  const f=hostFixture({complete:async()=>({isAnswered:true,text:'# State\n'+'Pending approval. '.repeat(1000),stopReason:'end_turn'}),run:async({command})=>{
    if(command==='summary-claim')return work(1)
    if(command==='summary-check')return {valid:++checks===1}
  }})
  await f.h.get('turn.complete')(f.$,{},()=>({}));await flush()
  assert.equal(f.modelCalls.length,1);assert.equal(checks,2)
  assert.equal(f.commands.filter(c=>c.command==='summary-save').length,0)
})

test('compaction input carries exact tool call and result IDs',async()=>{
  const f=hostFixture({run:async()=>({use:false})})
  const toolMessages=[{role:'assistant',text:'',toolUses:[{id:'a'},{tool_use_id:'b'},{call_id:'c'}]},{role:'user',text:'',toolResults:[{tool_use_id:'a'},{id:'b'}]},{role:'user',text:'',toolResultIds:['c']}]
  await f.h.get('session.compact')(f.$,{messages:toolMessages},()=>({}))
  const sent=f.commands[0].input.messages
  assert.deepEqual(sent[0].toolUses,[{tool_use_id:'a'},{tool_use_id:'b'},{tool_use_id:'c'}])
  assert.deepEqual(sent[1].toolResultIds,['a','b']);assert.deepEqual(sent[2].toolResultIds,['c'])
})

test('the real hook module runs in a VM without process or builtin module imports',()=>{
  const script = `
    import assert from 'node:assert/strict'
    import {readFileSync} from 'node:fs'
    import {resolve,dirname} from 'node:path'
    import {createContext,SourceTextModule,runInContext} from 'node:vm'
    const context=createContext({AbortController,setTimeout,clearTimeout})
    assert.equal(runInContext('typeof process',context),'undefined')
    const modules=new Map(),imports=[]
    function load(file){
      if(modules.has(file))return modules.get(file)
      const module=new SourceTextModule(readFileSync(file,'utf8'),{context,identifier:file})
      modules.set(file,module);return module
    }
    const root=load(resolve('hooks/compact-mod.js'))
    await root.link((specifier,parent)=>{
      imports.push(specifier)
      assert.ok(specifier.startsWith('.'),'Builtin imports are forbidden: '+specifier)
      return load(resolve(dirname(parent.identifier),specifier))
    })
    await root.evaluate()
    const hooks=new Map();root.namespace.register((name,hook)=>hooks.set(name,hook))
    const calls=[],messages=[{role:'user',text:'Synthetic task'},{role:'assistant',text:'Synthetic current state'},{role:'user',text:'Keep files intact.'}]
    const $={plugin:{root:'.'},session:{id:async()=> 'vm-synthetic-session',usage:async()=>({context:{tokens:100,window:300000}})},process:{run:async(args,options)=>{
      calls.push({command:args[2],options})
      return {stdout:JSON.stringify(args[2]==='compact-packet'?{use:true,start:1,packet:'Synthetic VM packet'}:{})}
    }}}
    const out=await hooks.get('session.compact')($,{messages},()=>assert.fail('The VM must replace the context'))
    assert.equal(out.messages[0].text,'Synthetic VM packet')
    assert.equal(calls[0].options.timeoutMs,270000)
    const event={index:99,turnId:'long-vm-turn'}
    assert.equal(hooks.get('turn.step')($,event,e=>e),event)
    for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0))
    assert.ok(calls.some(c=>c.command==='summary-tick'))
    assert.equal(runInContext('typeof process',context),'undefined')
    process.stdout.write(JSON.stringify({replaced:true,ticked:true,imports:imports.length}))
  `
  const result=spawnSync(process.execPath,['--experimental-vm-modules','--input-type=module','-'],{input:script,encoding:'utf8',timeout:5000})
  assert.equal(result.status,0,result.stderr)
  const out=JSON.parse(result.stdout);assert.equal(out.replaced,true);assert.equal(out.ticked,true);assert.ok(out.imports>0)
})

test('claudeTranscript uses the supplied config root and rejects a different root',t=>{
  const f=fixture(t)
  assert.equal(claudeTranscript(f.file,f.env),realpathSync(f.file))
  const other=join(f.dir,'other');mkdirSync(join(other,'projects'),{recursive:true})
  assert.throws(()=>claudeTranscript(f.file,{CLAUDE_CONFIG_DIR:other}),/inside the Claude projects directory/)
})

test('summary-tick ingests new main-turn records and chooses the host writer',t=>{
  const f=fixture(t,{rows:2})
  appendFileSync(f.file,JSON.stringify({role:'assistant',content:'Synthetic long-turn progress'})+'\n')
  assert.equal(f.run('summary-tick').host,true)
  assert.equal(f.store.stats(f.id).records,3);assert.equal(f.store.hostWriter(f.id),true)
})

test('summaryTick discovers only the main transcript inside the explicitly supplied synthetic root',t=>{
  const f=fixture(t),other=join(f.config,'projects','unindexed');mkdirSync(other,{recursive:true})
  const id='new-synthetic-turn'
  writeFileSync(join(other,id+'.jsonl'),f.records.map(JSON.stringify).join('\n')+'\n')
  assert.equal(summaryTick(f.store,id,{env:f.env}).host,true)
  assert.equal(f.store.stats(id).records,6)
  assert.equal(summaryTick(f.store,'../outside',{env:f.env}).none,'not recorded yet')
})

test('summaryTick schedules API work with a fake process and respects off and retry cooldown',t=>{
  const f=fixture(t),env={...f.env},spawns=[]
  f.store.setHarnessSetting('claude-code','api','synthetic-api','openai','http://127.0.0.1:9')
  const spawnProcess=(...args)=>{spawns.push(args);return {on(){},once(){},unref(){}}}
  assert.equal(summaryTick(f.store,f.id,{env,spawnProcess}).scheduled,true);assert.equal(spawns.length,1)
  assert.equal(spawns[0][2].env.SUPERLCM_SUMMARY_EXPECTED_MODE,'api')
  f.store.setHarnessSetting('claude-code','off')
  summaryTick(f.store,f.id,{env,spawnProcess});assert.equal(spawns.length,1)
  f.store.setHarnessSetting('claude-code','cli','synthetic-host')
  const prior=process.env.SUPERLCM_SEGMENT_MESSAGES;process.env.SUPERLCM_SEGMENT_MESSAGES='2'
  try{const batch=summaryWork(f.store,f.id);f.store.failSummaryBatch(f.id,batch.batch_id,summarySettingsRevision(f.store,f.id,env));assert.equal(summaryTick(f.store,f.id,{env,spawnProcess}).host,undefined)}finally{if(prior===undefined)delete process.env.SUPERLCM_SEGMENT_MESSAGES;else process.env.SUPERLCM_SEGMENT_MESSAGES=prior}
})

test('host claims respect leaf-only selection, failure cooldown and setting changes',t=>{
  const f=fixture(t),claim=f.run('summary-claim','',['--leaf']).work
  assert.equal(claim.task.level,0);assert.ok(claim.claim_id)
  assert.equal(f.run('summary-check',{batch_id:claim.batch_id,claim_id:claim.claim_id}).valid,true)
  f.run('summary-host-error',{batch_id:claim.batch_id,claim_id:claim.claim_id})
  f.run('summary-release',{batch_id:claim.batch_id,claim_id:claim.claim_id})
  assert.equal(f.run('summary-claim','',['--leaf']).none,'summary retry cooldown')
  f.store.setHarnessSetting('claude-code','cli','different-synthetic-model')
  const next=f.run('summary-claim','',['--leaf']).work;assert.ok(next)
  f.store.setHarnessSetting('claude-code','off')
  assert.ok(f.run('summary-save',{batch_id:next.batch_id,claim_id:next.claim_id,summary:text}).none)
  assert.equal(f.store.nodeRows(f.id,0).length,0)
})

test('late host saves and expired checks are refused by the persisted claim deadline',async t=>{
  const f=fixture(t),claim=f.run('summary-claim','',['--leaf','--deadline',String(Date.now()+500)]).work
  assert.ok(claim)
  f.store.db.prepare('UPDATE host_summary_claims SET deadline_ms=? WHERE session=?').run(Date.now()-1,f.id)
  assert.equal(f.run('summary-check',{batch_id:claim.batch_id,claim_id:claim.claim_id}).valid,false)
  assert.match(f.run('summary-save',{batch_id:claim.batch_id,claim_id:claim.claim_id,summary:text}).error,/deadline/)
  assert.equal(f.store.nodeRows(f.id,0).length,0)
})

test('an old host claim cannot release or invalidate a newer claim',t=>{
  const f=fixture(t),old=f.run('summary-claim').work
  f.store.release(f.id,'host')
  const next=f.run('summary-claim').work
  assert.notEqual(old.claim_id,next.claim_id)
  f.run('summary-release',{batch_id:old.batch_id,claim_id:old.claim_id})
  assert.equal(f.store.ownsLease(f.id,'host'),true)
  f.run('summary-handoff',{batch_id:old.batch_id,claim_id:old.claim_id})
  assert.equal(f.store.ownsLease(f.id,'host'),true);assert.equal(f.store.hostWriter(f.id),true)
  assert.match(f.run('summary-save',{batch_id:old.batch_id,claim_id:old.claim_id,summary:text}).error,/claim replaced/)
  assert.equal(f.store.ownsLease(f.id,'host'),true)
  assert.equal(f.run('summary-save',{batch_id:next.batch_id,claim_id:next.claim_id,summary:text}).saved,true)
})

test('missing UUID requests cannot publish or disturb a new claim after a model setting change',t=>{
  const f=fixture(t),old=f.run('summary-claim').work
  f.store.setHarnessSetting('claude-code','cli','new-synthetic-model');f.store.release(f.id,'host')
  const next=f.run('summary-claim').work
  assert.equal(old.batch_id,next.batch_id);assert.notEqual(old.claim_id,next.claim_id)
  const late={batch_id:old.batch_id,summary:text,model:'synthetic-host'}
  assert.equal(f.run('summary-check',late).valid,false)
  assert.equal(f.run('summary-check',{...late,claim_id:old.claim_id}).valid,false)
  assert.match(f.run('summary-save',late).error,/claim ID required.*reload/)
  f.run('summary-release',late);f.run('summary-host-error',late);f.run('summary-handoff',late)
  assert.equal(f.store.ownsLease(f.id,'host'),true);assert.equal(f.store.hostWriter(f.id),true)
  assert.equal(f.store.summaryError(f.id),null);assert.equal(f.store.summaryRetry(f.id,next.batch_id,summarySettingsRevision(f.store,f.id)),null)
  assert.equal(f.store.nodeRows(f.id,0).length,0)
  assert.equal(f.run('summary-check',{batch_id:next.batch_id,claim_id:next.claim_id}).valid,true)
  assert.equal(f.run('summary-save',{batch_id:next.batch_id,claim_id:next.claim_id,summary:text}).saved,true)
})

test('migrated empty-ID host claims retain the old protocol only under the same revision',t=>{
  const f=fixture(t),batch=summaryWork(f.store,f.id,{batchSize:2}),revision=summarySettingsRevision(f.store,f.id)
  const legacy=()=>{
    f.store.db.prepare("INSERT INTO host_summary_claims(session,batch_id,revision,claim_id) VALUES(?,?,?,'') ON CONFLICT(session) DO UPDATE SET batch_id=excluded.batch_id,revision=excluded.revision,claim_id='' ").run(f.id,batch.batch_id,revision)
    f.store.lease(f.id,300000,'host');f.store.setHostWriter(f.id,true)
  }
  legacy();assert.equal(f.run('summary-check',{batch_id:batch.batch_id}).valid,true)
  f.run('summary-release',{batch_id:batch.batch_id});assert.equal(f.store.ownsLease(f.id,'host'),false)
  legacy();f.store.setHarnessSetting('claude-code','cli','changed-synthetic-model')
  assert.equal(f.run('summary-check',{batch_id:batch.batch_id}).valid,false)
  f.run('summary-release',{batch_id:batch.batch_id});f.run('summary-host-error');f.run('summary-handoff')
  assert.equal(f.store.ownsLease(f.id,'host'),true);assert.equal(f.store.summaryError(f.id),null)
  f.store.setHarnessSetting('claude-code','cli','synthetic-host')
  assert.equal(f.run('summary-save',{batch_id:batch.batch_id,summary:text}).saved,true)
})

test('empty and malformed host stdin fail safely without publishing any node',t=>{
  const f=fixture(t),claim=f.run('summary-claim').work
  for(const input of ['', 'invalid JSON', 'null', '[]']){
    assert.ok(f.run('summary-check',input).error)
    assert.ok(f.run('summary-save',input).error)
    assert.equal(f.store.nodeRows(f.id,0).length,0)
  }
  f.store.setHarnessSetting('claude-code','off')
  assert.deepEqual(f.run('summary-host-error'),{})
  assert.deepEqual(f.run('summary-host-error','bad SECRET source'),{})
  assert.equal(f.store.summaryError(f.id),null)
  assert.equal(f.store.ownsLease(f.id,'host'),true)
  assert.ok(claim.claim_id)
})

test('compact-packet offers host catch-up only for the first eligible small backlog',t=>{
  const f=fixture(t,{large:true});f.store.setTakeover({enabled:true})
  const input={messages:f.records.map(r=>({role:r.role,text:r.content.slice(0,2000),size:r.content.length+200})),tokens:240000,window:300000}
  const first=f.run('compact-packet',input)
  assert.deepEqual(first.catchup,{host:true,deadlineMs:75000,maxPieces:4})
  const second=f.run('compact-packet',{...input,afterCatchup:true,catchupMs:10})
  assert.equal(second.catchup,undefined)
  const history=f.store.compactionHistory(f.id)
  assert.deepEqual(history.map(r=>r.stage),['catchup','first'])
  assert.equal(history[0].catchup_ms,10);assert.equal(history[0].pending,3)
  f.store.setHarnessSetting('claude-code','off')
  assert.equal(f.run('compact-packet',input).catchup,undefined)
})

test('compact-packet declines catch-up for more than four complete leaves',t=>{
  const f=fixture(t,{rows:10,large:true});f.store.setTakeover({enabled:true})
  const out=f.run('compact-packet',{messages:f.records.map(r=>({role:r.role,text:r.content.slice(0,2000)})),tokens:240000})
  assert.equal(out.catchup,undefined)
})

test('inline success records the initial decline and inline stage without launching catch-up',t=>{
  const f=fixture(t);f.store.setTakeover({enabled:true})
  const input={messages:f.records.map(r=>({role:r.role,text:r.content,size:r.content.length+200})),tokens:30000}
  const out=f.run('compact-packet',input)
  assert.equal(out.inline,true);assert.equal(out.catchup,undefined)
  assert.deepEqual(f.store.compactionHistory(f.id).map(r=>r.stage),['inline','first'])
  assert.equal(f.store.compactionHistory(f.id)[1].code,'no_summaries')
})

test('diagnostic history retains only the latest fifty rows per session and keeps the legacy interface',t=>{
  const f=fixture(t)
  assert.deepEqual(f.store.compactionHistory(f.id),[]);assert.equal(f.store.lastCompactionDiagnostic(f.id),null)
  for(let i=0;i<55;i++)f.store.noteCompaction(f.id,{status:'native',code:'coverage_lag',reason:'Synthetic diagnostic '+i,records:100,through:i,before:200000,after:120000,pending:3,catchupMs:10,stage:i%3===0?'first':i%3===1?'inline':'catchup'})
  f.store.noteCompaction('other-synthetic-session',{status:'native',code:'disabled',reason:'Synthetic other session'})
  const history=f.store.compactionHistory(f.id)
  assert.equal(history.length,50);assert.equal(history[0].reason,'Synthetic diagnostic 54');assert.equal(history.at(-1).reason,'Synthetic diagnostic 5')
  assert.equal(history[0].coverage_lag,45);assert.equal(history[0].pending,3);assert.equal(history[0].before,200000);assert.equal(history[0].after,120000)
  assert.equal(f.store.lastCompactionDiagnostic(f.id).reason,history[0].reason)
  assert.equal(f.store.lastCompactionDiagnostic(f.id).before_tokens,200000)
  assert.equal(f.store.compactionHistory('other-synthetic-session').length,1)
  assert.equal(f.store.compactionStats(f.id).total,50)
})

test('catch-up defaults to 75 seconds and uses at most four leaf pieces',async t=>{
  assert.equal(catchupDeadlineMs({}),75000);assert.equal(catchupDeadlineMs({SUPERLCM_CATCHUP_MS:'0'}),0);assert.equal(catchupDeadlineMs({SUPERLCM_CATCHUP_MS:'999999'}),240000)
  const f=fixture(t,{rows:12}),prior=process.env.SUPERLCM_SEGMENT_MESSAGES;process.env.SUPERLCM_SEGMENT_MESSAGES='2'
  try{
    let calls=0
    const result=await catchUp(f.store,f.id,{deadlineMs:1000,generate:async(store,id,setting,opts)=>buildHierarchy(store,id,{...opts,model:'synthetic-cli',summarize:async(_text,options)=>{calls++;assert.equal(options.summaryTask.level,0);return text}})})
    assert.equal(result.created,4);assert.equal(calls,4);assert.equal(pendingLeaves(f.store,f.id),2)
  }finally{if(prior===undefined)delete process.env.SUPERLCM_SEGMENT_MESSAGES;else process.env.SUPERLCM_SEGMENT_MESSAGES=prior}
})

test('API catch-up uses a local fake endpoint, respects the deadline and never writes a late result',{timeout:5000},async t=>{
  const f=fixture(t,{large:true}),seen=deferred(),reply=deferred();let requests=0
  const server=createServer(async(req,res)=>{
    requests++;seen.resolve();let raw='';for await(const part of req)raw+=part
    assert.ok(JSON.parse(raw).messages.length)
    await reply.promise
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{reply.resolve();server.closeAllConnections();server.close()})
  f.store.setHarnessSetting('claude-code','api','synthetic-api','openai','http://127.0.0.1:'+server.address().port)
  f.store.setTakeover({enabled:true});f.env.SUPERLCM_CATCHUP_MS='500'
  const input=JSON.stringify({messages:f.records.map(r=>({role:r.role,text:r.content.slice(0,2000),size:r.content.length+200})),tokens:240000})
  const child=spawn(process.execPath,['src/cli.js','compact-packet',f.id],{env:f.env,stdio:['pipe','pipe','pipe']})
  let output='',error='';child.stdout.on('data',b=>{output+=b});child.stderr.on('data',b=>{error+=b});child.stdin.end(input)
  const completed=new Promise(resolve=>child.once('exit',code=>resolve(code)))
  await Promise.race([seen.promise,completed.then(()=>{throw Error('Synthetic catch-up ended before its API request started')})])
  assert.equal(await completed,0,error)
  assert.equal(JSON.parse(output).catchup,true);assert.equal(requests,1);assert.equal(f.store.nodeRows(f.id,0).length,0)
  reply.resolve();await pause(30)
  assert.equal(f.store.nodeRows(f.id,0).length,0)
  assert.equal(f.store.compactionHistory(f.id)[0].stage,'catchup')
})

test('API catch-up saves complete fake replies and generates leaves only before replanning',{timeout:5000},async t=>{
  const f=fixture(t,{large:true});let requests=0
  const server=createServer(async(req,res)=>{
    requests++;let raw='';for await(const part of req)raw+=part
    const body=JSON.parse(raw);assert.ok(body.messages[1].content.includes('semantic depth=0'))
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()})
  f.store.setHarnessSetting('claude-code','api','synthetic-api','openai','http://127.0.0.1:'+server.address().port)
  f.store.setTakeover({enabled:true});f.env.SUPERLCM_CATCHUP_MS='1000'
  const child=spawn(process.execPath,['src/cli.js','compact-packet',f.id],{env:f.env,stdio:['pipe','pipe','pipe']})
  let output='',error='';child.stdout.on('data',b=>{output+=b});child.stderr.on('data',b=>{error+=b})
  child.stdin.end(JSON.stringify({messages:f.records.map(r=>({role:r.role,text:r.content.slice(0,2000),size:r.content.length+200})),tokens:240000}))
  const code=await new Promise(resolve=>child.once('exit',resolve))
  assert.equal(code,0,error);assert.equal(JSON.parse(output).catchup,true)
  assert.equal(requests,3);assert.equal(f.store.nodeRows(f.id,0).length,3);assert.equal(f.store.nodeRows(f.id,1).length,0)
  assert.equal(f.store.compactionHistory(f.id)[0].stage,'catchup')
})
