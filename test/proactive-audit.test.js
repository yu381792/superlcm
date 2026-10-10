import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventEmitter,once} from 'node:events'
import {PassThrough} from 'node:stream'
import {spawn} from 'node:child_process'
import {ClaudeStore} from '../src/store.js'
import {summaryWork,buildHierarchy} from '../src/summarize.js'
import {scheduleSummary} from '../src/summary-scheduler.js'
import {summarizeWithClaudeCli} from '../src/claude-cli.js'
import {summarizeWithCodexCli} from '../src/codex-cli.js'
import {summarizeWithHermes,summarizeWithPi} from '../src/cli-writers.js'
const english='Please check the original project and keep all files unchanged. Deployment has not been authorized.'
function fixture(rows,kind='jsonl'){
 const dir=mkdtempSync(join(tmpdir(),'superlcm-failure 用户 # % ')),file=join(dir,'original'),store=new ClaudeStore(join(dir,'store'))
 writeFileSync(file,kind==='text'?rows:rows.map(JSON.stringify).join('\n')+'\n');store.ingest('s',file,kind)
 return {dir,file,store}
}
const dialects={
 claude:[{type:'assistant',message:{content:[{type:'tool_use',id:'c',name:'deploy',input:{command:'inspect only '.repeat(1000)}}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'c',is_error:true,content:'FAILED. Nothing was deployed.'}]}}],
 codex:[{type:'response_item',payload:{type:'function_call',call_id:'c',name:'inspect',arguments:'inspect '.repeat(1500)}},{type:'response_item',payload:{type:'function_call_output',call_id:'c',output:'FAILED. Nothing was deployed.'}}],
 pi:[{role:'assistant',content:[{type:'toolCall',id:'c',name:'inspect',arguments:'inspect '.repeat(1500)}]},{role:'toolResult',toolCallId:'c',isError:true,content:[{type:'text',text:'FAILED. Nothing was deployed.'}]}],
 hermes:[{role:'assistant',content:'Inspect only',tool_calls:[{id:'c',function:{name:'inspect',arguments:'inspect '.repeat(1500)}}]},{role:'tool',tool_call_id:'c',content:'FAILED. Nothing was deployed.'}],
 dsh:[{dsh_session:'s',event:{seq:0,type:'assistant/message',surfaceOp:'append',data:{message:{content:[{type:'tool-call',id:'c',name:'inspect',arguments:'inspect '.repeat(1500)}]}}}},{dsh_session:'s',event:{seq:1,type:'tool/result',surfaceOp:'append',data:{message:{toolCallId:'c',isError:true,content:[{type:'text',text:'FAILED. Nothing was deployed.'}]}}}}]
}
for(const [name,rows] of Object.entries(dialects))test(`${name} summary segment retains the requested tool action and its failed outcome together`,()=>{
 const {store}=fixture(rows);try{
  assert.equal(summaryWork(store,'s',{targetTokens:1000}).last,1)
  assert.match(summaryWork(store,'s',{targetTokens:1000}).content,/FAILED/)
  const pending=fixture(rows.slice(0,1));try{assert.equal(summaryWork(pending.store,'s',{targetTokens:1000}),null)}finally{pending.store.close()}
 }finally{store.close()}
})
test('string-encoded structured tool content preserves complete pairing',()=>{
 const rows=structuredClone(dialects.claude);for(const row of rows)row.message.content='\0json:'+JSON.stringify(row.message.content)
 const {store}=fixture(rows);try{const work=summaryWork(store,'s',{targetTokens:1000});assert.equal(work.last,1);assert.match(work.content,/FAILED/)}finally{store.close()}
})
test('parallel tool calls stay in one segment until both results arrive',()=>{
 const rows=[...dialects.claude.slice(0,1),{role:'assistant',content:[{type:'tool_use',id:'d',name:'check',input:{}}]},dialects.claude[1],{role:'user',content:[{type:'tool_result',tool_use_id:'d',content:'Other tool finished.'}]}]
 const {store}=fixture(rows);try{assert.equal(summaryWork(store,'s',{targetTokens:1000,batchSize:2}).last,3)}finally{store.close()}
})
test('text import anchors summary language to labeled user text, excluding assistant language',async()=>{
 const {store}=fixture('user:\n'+english+'\nassistant:\n'+'这是助手的中文回复，并不是用户语言。'.repeat(150)+'\n','text')
 try{
  assert.equal(summaryWork(store,'s',{batchSize:2,targetTokens:1000}).language.code,'en')
  await assert.rejects(buildHierarchy(store,'s',{model:'fixture',targetTokens:1000,batchSize:2,summarize:async()=> '# 当前状态\n这是错误语言的摘要。'.repeat(20)}),/language mismatch/)
  assert.equal(store.nodeRows('s',0).length,0)
 }finally{store.close()}
})
test('failed batches persist cooldown across process restarts and pause after three failed runs',async()=>{
 const {dir,store:first}=fixture([{role:'user',content:english.repeat(1800)}]);let store=first,calls=0,spawned=0,child
 store.setMetadata('s',{harness:'codex',externalId:'synthetic'});store.setGlobalSetting('api','fixture','openai','http://127.0.0.1:9/v1')
 const spawnProcess=()=>{spawned++;child=Object.assign(new EventEmitter(),{unref(){}});return child}
 const options={model:'fixture',apiKey:'',apiProvider:'openai',baseURL:'http://127.0.0.1:9/v1',fetchImpl:async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'I will deploy now.'},finish_reason:'stop'}]}))}}
 try{
  for(let attempt=0;attempt<3;attempt++){
   assert.equal(scheduleSummary(store,'s','api','fixture',{spawnProcess}),true)
   await assert.rejects(buildHierarchy(store,'s',options),/section heading/);child.emit('exit',1)
   store.close();store=new ClaudeStore(join(dir,'store'))
   for(let i=0;i<4;i++)assert.equal(scheduleSummary(store,'s','api','fixture',{spawnProcess}),false)
   const paused=await buildHierarchy(store,'s',options);assert.ok(['retry-backoff','failed-batch-paused'].includes(paused.stopped))
   store.db.prepare('UPDATE summary_retries SET until_ms=0').run()
  }
  assert.equal(calls,6);assert.equal(spawned,3);assert.equal(scheduleSummary(store,'s','api','fixture',{spawnProcess}),false)
  assert.equal((await buildHierarchy(store,'s',options)).stopped,'failed-batch-paused')
  const result=await buildHierarchy(store,'s',{...options,retryFailed:true,fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'# Current state\nAll original files remain unchanged. Deployment has not been authorized.'},finish_reason:'stop'}]}))})
  assert.ok(result.created);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM summary_retries').get().n,0)
 }finally{store.close()}
})
test('a changed model configuration admits a new attempt after a failed batch',async()=>{
 const {store}=fixture([{role:'user',content:english.repeat(1800)}]);try{
  await assert.rejects(buildHierarchy(store,'s',{model:'old',summarize:async()=>{throw Error('Synthetic failure')}}))
  store.setGlobalSetting('api','new','openai','http://127.0.0.1:9/v1')
  const result=await buildHierarchy(store,'s',{model:'new',summarize:async()=> '# Current state\nOriginal files remain unchanged. Deployment is unauthorized.'})
  assert.ok(result.created)
 }finally{store.close()}
})
for(const [name,writer] of [['Claude',summarizeWithClaudeCli],['Codex',summarizeWithCodexCli],['Hermes',summarizeWithHermes],['Pi',summarizeWithPi]]){
 for(const overflow of [false,true])test(`${name} ${overflow?'oversized output':'timeout'} settles even when the child ignores SIGTERM`,{timeout:5000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'summary-child-')),signals=[]
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(signal){signals.push(signal);if(signal==='SIGKILL')this.emit('close',null);return true}})
  const closed=once(child,'close'),start=Date.now()
  const promise=writer(english,{bin:'fake',cwd:dir,timeoutMs:1000,spawnProcess:()=>child})
  if(overflow)child.stdout.write('x'.repeat(1024*1024+1))
  await assert.rejects(promise,overflow?/exceeded/:/timed out/)
  assert.ok(Date.now()-start<1800);await closed;assert.deepEqual(signals,['SIGTERM','SIGKILL'])
 })
}

test('a real owned summary subprocess ignoring SIGTERM is forcibly reaped',{timeout:5000,skip:process.platform==='win32'?'Windows terminates SIGTERM directly; refusal is covered by the portable fake-child tests':false},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'real-summary-child-'));let child,closed
 const result=summarizeWithPi(english,{bin:'local-node-fixture',cwd:dir,timeoutMs:1000,spawnProcess:()=>{
  child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['pipe','pipe','pipe']});closed=once(child,'close');return child
 }})
 await assert.rejects(result,/timed out/)
 const [code,signal]=await closed;assert.equal(code,null);assert.equal(signal,'SIGKILL')
})
