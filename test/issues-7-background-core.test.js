import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore} from '../src/store.js'
import {buildHierarchy,summaryWork} from '../src/summarize.js'
import {catchUp,catchupDeadlineMs} from '../src/summary-background.js'
const good='# Current state\nThe inspection remains unfinished. Deployment is not authorized. Exact details are preserved in the original records.'
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'superlcm-background-core-')),store=new ClaudeStore(join(dir,'store')),file=join(dir,'source.jsonl')
 writeFileSync(file,Array.from({length:64},(_,i)=>JSON.stringify({role:i%2?'assistant':'user',content:'Synthetic record '+i+' inspection only; deployment is not authorized.'})).join('\n')+'\n')
 store.ingest('s',file);store.setMetadata('s',{harness:'claude-code',externalId:'s'});store.setHarnessSetting('claude-code','cli','fixture')
 t.after(()=>store.close());return store
}
test('raw leaf coverage precedes merges and leaf-only work does not generate a merge',t=>{
 const store=fixture(t)
 for(let i=0;i<4;i++)store.addNode({session:'s',id:'old'+i,level:0,first:2*i,last:2*i+1,children:[],summary:good.repeat(20),digest:'old'+i,model:'fixture'})
 assert.equal(summaryWork(store,'s').level,0)
 store.addNode({session:'s',id:'rest',level:0,first:8,last:63,children:[],summary:good.repeat(20),digest:'rest',model:'fixture'})
 assert.equal(summaryWork(store,'s',{leafOnly:true}),null)
 assert.equal(summaryWork(store,'s').level,1)
})
test('catchup stops at four leaf pieces without merging or overwriting source',async t=>{
 const store=fixture(t),original=store.exact('s',0);let calls=0
 const result=await catchUp(store,'s',{deadlineMs:500,maxPieces:4,generate:(s,id,setting,options)=>buildHierarchy(s,id,{...options,model:'fixture',batchSize:2,summarize:async()=>{calls++;return good}})})
 assert.equal(result.created,4);assert.equal(calls,4);assert.equal(store.nodeRows('s',0).length,4);assert.equal(store.nodeRows('s',1).length,0)
 assert.equal(store.exact('s',0),original)
})
test('deadline returns promptly and ignores a noncooperating late model reply',async t=>{
 const store=fixture(t);let resolve,entered,generation
 const started=new Promise(r=>{entered=r})
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()})
 const run=catchUp(store,'s',{deadlineMs:25,generate:(s,id,setting,options)=>{
  generation=buildHierarchy(s,id,{...options,model:'fixture',summarize:()=>new Promise(r=>{resolve=r;entered()})})
  return generation
 }})
 await started;t.mock.timers.tick(25)
 const result=await run;assert.equal(result.expired,true);assert.equal(store.nodeRows('s',0).length,0)
 resolve(good);await assert.rejects(generation,/deadline reached/)
 assert.equal(store.nodeRows('s',0).length,0);assert.equal(store.summarizing('s'),false)
})
test('settings changed during catchup discard the reply and suppress additional calls',async t=>{
 const store=fixture(t);let calls=0,entered,reply
 // Anchor cancellation after model entry. Synchronous planning under concurrent
 // test load must not consume this settings-change test's wall-clock budget.
 const now=Date.now();t.mock.method(Date,'now',()=>now)
 const started=new Promise(r=>{entered=r}),response=new Promise(r=>{reply=r})
 const run=catchUp(store,'s',{deadlineMs:100,generate:(s,id,setting,options)=>buildHierarchy(s,id,{...options,model:'fixture',summarize:async()=>{calls++;entered();return response}})})
 await started;store.setHarnessSetting('claude-code','off');reply(good)
 const result=await run
 assert.equal(result.created,0);assert.equal(calls,1);assert.equal(store.nodeRows('s',0).length,0)
})
test('an active failure cooldown blocks catchup without another model call',async t=>{
 const store=fixture(t);const {summarySettingsRevision}=await import('../src/summarize.js'),work=summaryWork(store,'s')
 store.failSummaryBatch('s',work.batch_id,summarySettingsRevision(store,'s'));let calls=0
 const result=await catchUp(store,'s',{deadlineMs:100,generate:(s,id,setting,options)=>buildHierarchy(s,id,{...options,model:'fixture',summarize:async()=>{calls++;return good}})})
 assert.equal(result.created,0);assert.equal(calls,0)
})
test('catchup deadline configuration is bounded and has an explicit disabled value',()=>{
 assert.equal(catchupDeadlineMs({}),75000);assert.equal(catchupDeadlineMs({SUPERLCM_CATCHUP_MS:'0'}),0)
 assert.equal(catchupDeadlineMs({SUPERLCM_CATCHUP_MS:'999999'}),240000);assert.equal(catchupDeadlineMs({SUPERLCM_CATCHUP_MS:'-1'}),75000)
})
test('an aborted CLI generation settles immediately and kills only its own noncooperating child',async()=>{
 const {EventEmitter,once}=await import('node:events'),{PassThrough}=await import('node:stream'),{summarizeWithPi}=await import('../src/cli-writers.js')
 const controller=new AbortController(),signals=[],child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(signal){signals.push(signal);if(signal==='SIGKILL')this.emit('close',null);return true}})
 const closed=once(child,'close'),dir=mkdtempSync(join(tmpdir(),'summary-aborted-child-'))
 const promise=summarizeWithPi('Only inspect; do not deploy.',{bin:'fixture',cwd:dir,signal:controller.signal,spawnProcess:()=>child})
 controller.abort(Error('Synthetic catchup cancelled'))
 await assert.rejects(promise,/catchup cancelled/);await closed
 assert.deepEqual(signals,['SIGTERM','SIGKILL'])
 let spawns=0
 assert.throws(()=>summarizeWithPi('Only inspect.',{bin:'fixture',cwd:dir,signal:controller.signal,spawnProcess:()=>{spawns++}}),/catchup cancelled/)
 assert.equal(spawns,0)
})
