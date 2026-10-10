import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore} from '../src/store.js'
import {adaptiveSummaryTask,fitSummary,profileKey,readSummaryProfile,updateSummaryProfile} from '../src/summary-generation.js'
import {summaryTaskTail,checkedSummary,SUMMARY_MAX_CHARS} from '../src/summary-policy.js'
import {readOpenAICompletion,summaryFailure,STREAM_COMPLETE} from '../src/summary-response.js'
import {summarizeWithModel} from '../src/summarize.js'
import {classifySummaryError,summaryErrorDetail,upstreamSummaryCause} from '../src/summary-errors.js'
const sse=body=>new Response(body,{headers:{'content-type':'text/event-stream'}})
const complete=(text='# Current state\nThe synthetic inspection is unfinished.')=>new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}))
const options=(model,fetchImpl,extra={})=>({model,fetchImpl,apiProvider:'openai',baseURL:'http://127.0.0.1:9',...extra})
const storeFixture=t=>{const store=new ClaudeStore(join(mkdtempSync(join(tmpdir(),'superlcm-issues1012-')),'store'));t.after(()=>store.close());return store}
test('issue10 soft prompt target never lowers the hard acceptance limit',async()=>{
 const task=adaptiveSummaryTask({requireHeading:true},{overshoot:1.696}),draft='# '+'x'.repeat(4498)
 assert.equal(task.requestChars,3537);assert.equal(task.maxChars,6000)
 assert.match(summaryTaskTail(task),/no more than 3537 characters/)
 let calls=0;assert.equal(await fitSummary(draft,async()=>{calls++;return '# Repaired'},{task}),draft);assert.equal(calls,0)
 assert.equal(checkedSummary(draft,task),draft)
})
test('issue10 both high and default learned ratios accept hard-limit boundary',async()=>{
 for(const overshoot of [1,2,8]){
  const task=adaptiveSummaryTask({}, {overshoot})
  assert.equal((await fitSummary('# '+'x'.repeat(5998),()=>{throw Error('Unexpected repair')},{task})).length,6000)
  let calls=0;await fitSummary('# '+'x'.repeat(5999),async()=>{calls++;return '# Repaired'},{task});assert.equal(calls,1)
 }
})
test('issue10 repaired complete drafts remain subject to hard limit and reduced marker',async()=>{
 const task=adaptiveSummaryTask({}, {overshoot:4})
 const result=await fitSummary('# '+'x'.repeat(9000),async()=> '# '+'y'.repeat(8000),{task})
 assert.ok(result.length<=SUMMARY_MAX_CHARS);assert.match(result,/SuperLcm reduced navigation/)
})
test('issue10 learned overshoot rises immediately and decays gradually',()=>{
 const key='issue10-memory';assert.equal(updateSummaryProfile(key,{overshoot:4}).overshoot,4)
 assert.equal(updateSummaryProfile(key,{overshoot:1}).overshoot,3.55)
 for(let i=0;i<20;i++)updateSummaryProfile(key,{overshoot:1})
 assert.ok(readSummaryProfile(key).overshoot<1.2)
 assert.equal(updateSummaryProfile(key,{overshoot:20}).overshoot,8)
})
test('issue10 persisted learning survives reopen and reasoning-only updates do not decay it',t=>{
 const store=storeFixture(t),key='issue10-persisted'
 updateSummaryProfile(key,{overshoot:4,reasoning_room:4000},store)
 assert.equal(updateSummaryProfile(key,{reasoning_room:5000},store).overshoot,4)
 assert.equal(updateSummaryProfile(key,{overshoot:1},store).overshoot,3.55)
 const second=new ClaudeStore(store.dir);t.after(()=>second.close())
 assert.equal(readSummaryProfile(key,second).overshoot,3.55)
 assert.equal(readSummaryProfile(key,second).reasoning_room,5000)
 for(const value of [NaN,Infinity,-1,0])assert.equal(updateSummaryProfile(key,{overshoot:value},second).overshoot,3.55)
})
test('issue10 real API fitting accepts a response above its learned request target',async t=>{
 const store=storeFixture(t),key=profileKey('http://127.0.0.1:9/v1/chat/completions','issue10-api',null)
 updateSummaryProfile(key,{overshoot:1.696},store);let calls=0,prompt
 const draft='# '+'x'.repeat(4498)
 const result=await summarizeWithModel('Synthetic source',options('issue10-api',async(_url,r)=>{calls++;prompt=JSON.parse(r.body).messages.at(-1).content;return complete(draft)},{profileStore:store}))
 assert.equal(result,draft);assert.equal(calls,1);assert.match(prompt,/no more than 3537 characters/)
})
test('issue12 unknown usage differs from measured zero and measured positive',()=>{
 assert.match(summaryFailure('Synthetic','configured',null).message,/reasoning_tokens unknown, completion_tokens unknown/)
 assert.match(summaryFailure('Synthetic','configured',null,{reasoning_tokens:0,completion_tokens:0}).message,/reasoning_tokens 0, completion_tokens 0/)
 assert.match(summaryFailure('Synthetic','configured',null,{reasoning_tokens:-1,completion_tokens:8}).message,/reasoning_tokens unknown, completion_tokens 8/)
})
for(const [name,body,kind,pattern] of [
 ['empty','', 'stream_empty',/no completion data/],
 ['keepalive',': ping\n\n','stream_empty',/no completion data/],
 ['cutoff','data: '+JSON.stringify({choices:[{delta:{content:'# Unfinished'}}]})+'\n\n','stream_cutoff',/cut off before its final event/],
 ['error without data','event: error\n\n','upstream',/upstream error/],
])test('issue12 distinct stream diagnostics: '+name,async()=>{
 await assert.rejects(readOpenAICompletion(sse(body),'configured'),e=>e.summaryKind===kind&&pattern.test(e.message))
})
test('issue12 cutoff keeps actual provider usage without inventing missing reasoning count',async()=>{
 const body='data: '+JSON.stringify({choices:[{delta:{content:'# Partial'}}],usage:{completion_tokens:14}})+'\n\n'
 await assert.rejects(readOpenAICompletion(sse(body),'configured'),/reasoning_tokens unknown, completion_tokens 14/)
})
test('issue12 upstream causes are recognizable while private free text is withheld',async()=>{
 for(const [message,kind] of [['Rate limit exceeded','rate_limit'],['Invalid API key','auth'],['Insufficient quota','quota'],['Service unavailable','upstream'],['Context window limit exceeded','length'],['arbitrary','upstream']]){
  const body='event: error\ndata: '+JSON.stringify({error:{message:message+' SECRET SOURCE sk-private-value'}})+'\n\n'
  await assert.rejects(readOpenAICompletion(sse(body),'configured'),e=>e.summaryKind===kind&&!/SECRET|private-value/.test(e.message))
 }
 assert.equal(upstreamSummaryCause({error:{code:'rate_limit_exceeded',message:'SECRET'}}).kind,'rate_limit')
})
test('issue12 mislabeled JSON completion is bounded and never proves stream completion',async()=>{
 const body=JSON.stringify({choices:[{message:{content:'# Complete'},finish_reason:'stop'}]})
 const result=await readOpenAICompletion(sse(body),'configured')
 assert.equal(result.choices[0].message.content,'# Complete');assert.equal(result[STREAM_COMPLETE],undefined)
 assert.equal(await summarizeWithModel('Synthetic',options('json-sse',async()=>sse(body))),'# Complete')
 await assert.rejects(summarizeWithModel('Synthetic',options('json-sse-missing',async()=>sse(JSON.stringify({streamCompleted:true,choices:[{message:{content:'# Partial'}}]})))),/no terminal finish reason/)
 await assert.rejects(readOpenAICompletion(sse('{"choices":[],"padding":"'+'x'.repeat(1024*1024)+'"}'),'configured'),/size limit/)
})
test('issue12 upstream JSON errors retain safe causes',async()=>{
 await assert.rejects(summarizeWithModel('Synthetic',options('json-error',async()=>new Response(JSON.stringify({error:{code:'invalid_api_key',message:'SECRET'}})))),e=>e.summaryKind==='auth'&&!e.message.includes('SECRET'))
})
test('issue12 each retry receives a full independent request timeout',async()=>{
 const signals=[];let calls=0
 const fetchImpl=async(_url,r)=>{signals.push(r.signal);await new Promise(resolve=>setTimeout(resolve,200));r.signal.throwIfAborted();calls++;return calls===1?complete('No Markdown heading'):complete()}
 const result=await summarizeWithModel('Synthetic',options('fresh-timeouts',fetchImpl,{timeoutMs:300}))
 assert.match(result,/Current state/);assert.equal(calls,2);assert.notEqual(signals[0],signals[1])
})
test('issue12 outer cancellation still bounds the whole retry sequence',async()=>{
 const controller=new AbortController();let calls=0
 await assert.rejects(summarizeWithModel('Synthetic',options('outer-cancel',async()=>{calls++;controller.abort(Error('Synthetic outer deadline'));return complete('No Markdown heading')},{signal:controller.signal})),e=>e.summaryKind==='cancelled')
 assert.equal(calls,1)
})
test('issue12 hanging response body is cancelled on its request timeout',async()=>{
  let cancelled=false
  const stream=new ReadableStream({start(){},cancel(){cancelled=true}})
  // A real fetch keeps its socket alive. Keep the synthetic transport alive
  // long enough for AbortSignal.timeout's deliberately unref'ed timer.
  const keepAlive=setTimeout(()=>{},1000)
  try{await assert.rejects(summarizeWithModel('Synthetic',options('hung-body',async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}),{timeoutMs:30})),e=>e.summaryKind==='timeout');assert.equal(cancelled,true)}finally{clearTimeout(keepAlive)}
})
test('issue12 startup and host failures get safe stable kinds',()=>{
 assert.equal(classifySummaryError(Object.assign(Error('SECRET executable'),{code:'ENOENT'})),'spawn')
 assert.equal(summaryErrorDetail(Error('Host summary failed')).kind,'host')
 assert.equal(summaryErrorDetail(Error('Summary writer lost its lease')).kind,'worker_lost')
 assert.doesNotMatch(summaryErrorDetail(Error('SECRET upstream body')).message,/SECRET/)
})
test('issue12 parameter-negotiation error bodies obey timeout and size limits',async()=>{
 let cancelled=false
 const keepAlive=setTimeout(()=>{},1000)
 try{
  const stream=new ReadableStream({start(){},cancel(){cancelled=true}})
  await assert.rejects(summarizeWithModel('Synthetic',options('hung-400-body',async()=>new Response(stream,{status:400}),{timeoutMs:30})),e=>e.summaryKind==='timeout')
  assert.equal(cancelled,true)
 }finally{clearTimeout(keepAlive)}
 await assert.rejects(summarizeWithModel('Synthetic',options('huge-400-body',async()=>new Response('x'.repeat(1024*1024+1),{status:400}))),e=>e.summaryKind==='response_invalid'&&/size limit/.test(e.message))
})
