import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizePiFork,piForkPlan } from '../src/pi-fork.js'
import {makePiSnapshot} from '../src/pi-snapshot.js'
import { forkHash, parseForkSummary } from '../src/fork-summary.js'
import { estimatePiRequest, limitPiOutput, piCompletionBudget, piOutputReserve, piWindowSafety } from '../src/pi-request.js'
import { estimateSummaryTokens } from '../src/summary-tokens.js'
const first={role:'user',content:'Please inspect /tmp/fixture; never deploy.',timestamp:1}
const second={role:'assistant',content:[{type:'text',text:'Inspection pending.'}],timestamp:2}
const messages=[{role:'system',content:'System',toolsAdded:[{name:'read',parameters:{type:'object'}}]},first,second]
const payload={model:'fixture',messages:[{role:'system',content:'System'},{role:'user',content:first.content},{role:'assistant',content:'Inspection pending.'}],tools:[{type:'function',function:{name:'read'}}],max_tokens:2048,prompt_cache_key:'main-session',temperature:.2}
const snapshot={session_id:'main-session',sourceMessages:[first,second],source:'source',tokensBefore:10000}
const capture={payload,messages,model:{provider:'fixture',id:'fixture',contextWindow:1000000,maxTokens:2048},reasoning:'high'}
test('Pi persisted system/tool state stays outside the summary source and native-prefix indices',async()=>{
 const system={role:'system',content:'',sections:{rules:'Deployment requires permission.'},toolsAdded:[{name:'read',parameters:{type:'object'}}],timestamp:0}
 const oldUser={role:'user',content:'Inspect the project without deployment. '.repeat(200),timestamp:1}
 const oldAssistant={role:'assistant',content:[{type:'text',text:'Inspection remains incomplete. '.repeat(100)}],timestamp:2}
 const tail={role:'user',content:'Keep this exact current request. '.repeat(100),timestamp:3}
 const rows=[system,oldUser,oldAssistant,tail].map((m,i)=>({sourceEntry:{id:'e'+i,type:i?'message':'system'},messages:[m]}))
 const ctx={model:capture.model,getContextUsage:()=>({tokens:10000}),sessionManager:{buildSessionProjection:()=>({entries:rows}),getSessionId:()=> 'native-system',getSessionFile:()=> '/synthetic.jsonl',getLeafId:()=> 'e3'}}
 const selected=makePiSnapshot(ctx,{summaryMode:'main-fork',ratio:.8},{compaction:{keepRecentTokens:512}})
 assert.deepEqual(selected.sourceMessages,[oldUser,oldAssistant])
 assert.deepEqual(selected.sourceEntryIds,['e1','e2'])
 const plan=await piForkPlan(selected,{messages:[system,oldUser,oldAssistant,tail]})
 assert.equal(plan[0].firstMessage,1);assert.equal(plan.at(-1).lastMessage,2)
 assert.deepEqual(plan.flatMap(n=>n.entryIds),['e1','e2'])
 // Excluding system state must not weaken the dialogue prefix check.
 await assert.rejects(piForkPlan(selected,{messages:[system,{...oldUser,content:'changed'},oldAssistant,tail]}),/归档选区/)
})
test('Pi branch keeps all nested timers alive only for meaningful stream output',async t=>{
 const gates=[];let started,progress=0
 const begun=new Promise(resolve=>started=resolve)
 const response={stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection remains pending.'}]})}]}
 const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,options){
  options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]})
  return {async *[Symbol.asyncIterator](){
   started()
   for(let i=0;i<3;i++){await new Promise(resolve=>gates.push(resolve));yield {type:'thinking_delta',delta:'continued reasoning'}}
  },result:async()=>response}
 }}}
 const until=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(setImmediate)}throw Error('Pi stream did not advance')}
 let work
 try{
  t.mock.timers.enable({apis:['setTimeout','Date']})
  work=summarizePiFork(ctx,snapshot,capture,{stage:async()=>{},timeoutMs:600000,progress:()=>progress++})
  await begun;await until(()=>gates.length===1)
  for(let i=0;i<3;i++){
   t.mock.timers.tick(540000);gates.shift()();await until(()=>progress===i+1)
   if(i<2)await until(()=>gates.length===1)
  }
  const result=await work
  assert.equal(progress,3);assert.ok(result.blocks[0].summary.includes('Inspection remains pending'))
 }finally{for(const release of gates)release();t.mock.timers.reset();await work}
})

test('Pi empty deltas do not delay the idle timeout',async t=>{
 let started,release,emitted=false,progress=0
 const begun=new Promise(resolve=>started=resolve)
 const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,options){
  options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]})
  return {async *[Symbol.asyncIterator](){
   started();await new Promise(resolve=>release=resolve)
   yield {type:'thinking_delta',delta:'   '};emitted=true;await new Promise(()=>{})
  },result:async()=>{throw Error('incomplete stream cannot complete')}}
 }}}
 const until=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(setImmediate)}throw Error('Pi stream did not advance')}
 let work
 try{
  t.mock.timers.enable({apis:['setTimeout','Date']})
  work=summarizePiFork(ctx,snapshot,capture,{stage:async()=>{},timeoutMs:600000,progress:()=>progress++})
  const rejected=assert.rejects(work,/timed out/)
  await begun;t.mock.timers.tick(540000);release();await until(()=>emitted)
  t.mock.timers.tick(60001);await rejected;assert.equal(progress,0)
 }finally{release?.();t.mock.timers.reset()}
})

for(const excess of [.01,.07])test('Pi accepts a complete tree '+Math.round(excess*100)+'% above its planning goal within the sent output limit',async()=>{
 let goal,actual,output
 const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,options){
  const prompt=_c.messages.at(-1).content
  goal=Number(prompt.match(/together must fit (\d+) tokens/)[1])
  const wire=options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:prompt}]})
  output=piOutputReserve(wire,capture.model)
  const summary='# Historical state\n'+'x'.repeat(Math.ceil(goal*(1+excess))*4)
  actual=estimateSummaryTokens(summary)
  assert.ok(actual>goal&&actual<output)
  return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary}]})}],usage:{cacheRead:9000}})}
 }}}
 const result=await summarizePiFork(ctx,snapshot,capture,{stage:async()=>{}})
 assert.equal(result.treeOptions.targetTokens,output,'save-time validation receives the actual output limit')
 assert.equal(estimateSummaryTokens(result.tree[0].summary),actual)
 assert.equal(result.usage.cacheRead,9000)
})

test('Pi still rejects a complete tree beyond its final output limit',async()=>{
 const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,options){
  const wire=options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]})
  const summary='# Historical state\n'+'x'.repeat((piOutputReserve(wire,capture.model)+1)*4)
  return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary}]})}]})}
 }}}
 await assert.rejects(summarizePiFork(ctx,snapshot,capture,{stage:async()=>{}}),/总输出预算/)
})

test('Pi branch replays exact provider prefix/settings and stages originals before one model call',async()=>{
 let staged=false,calls=0,wire
 const ctx={model:capture.model,modelRegistry:{streamSimple(model,context,options){
   assert.ok(staged);calls++;assert.equal(options.sessionId,'main-session');assert.equal(options.reasoning,'high')
   assert.deepEqual(context.messages.slice(0,-1),messages)
   wire=options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'generated directive'}]})
   return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection pending. Never deploy.'}]})}],usage:{cacheRead:9000,cacheWrite:0,input:100}})}
 }}}
 const result=await summarizePiFork(ctx,snapshot,capture,{signal:new AbortController().signal,stage:async()=>{staged=true}})
 assert.equal(calls,1);assert.deepEqual(wire.messages.slice(0,-1),payload.messages)
 assert.deepEqual({...wire,messages:[]},{...payload,messages:[]})
 assert.equal(result.sourceDigest,forkHash('source'));assert.equal(result.usage.cacheRead,9000)
 assert.equal(result.blocks[0].firstMessage,1);assert.equal(result.blocks[0].lastMessage,2)
})
test('Pi refuses transformed source, incomplete output and tool-call summary',async()=>{
 const base={model:capture.model,modelRegistry:{streamSimple(){throw Error('must not call')}}}
 await assert.rejects(summarizePiFork(base,snapshot,{...capture,messages:[messages[0],{...first,content:'changed'},second]},{stage:async()=>{}}),/归档选区/)
 for(const response of [{stopReason:'length',content:[]},{stopReason:'toolUse',content:[{type:'toolCall'}]}]){
 const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,o){o.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]});return{result:async()=>response}}}}
 await assert.rejects(summarizePiFork(ctx,snapshot,capture,{stage:async()=>{}}),/未完整结束/)
 }
 assert.throws(()=>parseForkSummary('{"blocks":[{"index":1,"summary":"# wrong"}]}',[{index:0}]),/顺序/)
 assert.throws(()=>parseForkSummary('{"blocks":[]}',[{index:0}]),/缺失/)
})

test('Pi refuses changed image content even when visible text is identical',async()=>{
 const image={role:'user',content:[{type:'text',text:'Inspect the image.'},{type:'image',mimeType:'image/png',data:'original'}],timestamp:1}
 const changed={...image,content:[image.content[0],{...image.content[1],data:'changed'}]}
 const ctx={model:capture.model,modelRegistry:{streamSimple(){throw Error('must not dispatch a changed source')}}}
 await assert.rejects(summarizePiFork(ctx,{...snapshot,sourceMessages:[image]},
  {...capture,messages:[messages[0],changed]},{stage:async()=>{}}),/归档选区/)
})

for (const fault of ['cancel', 'timeout']) test('Pi bounds a branch whose provider ignores '+fault,async()=>{
 let release,started,wireOptions
 const blocked=new Promise(resolve=>{release=resolve}),begun=new Promise(resolve=>{started=resolve})
 const controller=new AbortController()
 const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,options){
   wireOptions=options
   options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]})
   started()
   return {result:()=>blocked}
 }}}
 const work=summarizePiFork(ctx,snapshot,capture,{signal:controller.signal,stage:async()=>{},timeoutMs:20})
 const outcome=work.then(()=> 'accepted',()=> 'rejected')
 await begun
 if(fault==='cancel')controller.abort(Error('synthetic cancellation'))
 const observed=await Promise.race([outcome,new Promise(resolve=>setTimeout(()=>resolve('hung'),100))])
 release({stopReason:'stop',content:[{type:'text',text:'# Historical state\nPending inspection.'}]})
 await outcome
 assert.equal(observed,'rejected','provider cooperation must not be needed to stop waiting')
 assert.throws(()=>wireOptions.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'late directive'}]}))
})

test('Pi checks the entire replayed wire request including tools before sending a summary', async () => {
 const native={...payload,tools:[{description:'中'.repeat(40000)}]}
 const captured={...capture,payload:native,model:{...capture.model,contextWindow:32000,maxTokens:2048}}
 let dispatches=0
 const ctx={model:captured.model,modelRegistry:{streamSimple(_m,_c,options){
   options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]})
   dispatches++
   return {result:async()=>({})}
 }}}
 await assert.rejects(summarizePiFork(ctx,snapshot,captured,{stage:async()=>{}}),/最终请求/)
 assert.equal(dispatches,0)
})

test('a late Pi branch at 400K keeps its exact prefix and reduces only auxiliary output',async()=>{
 const captured={...capture,model:{...capture.model,contextWindow:500000,maxTokens:128000},payload:{...payload,max_tokens:128000}}
 let wire
 const ctx={model:captured.model,modelRegistry:{streamSimple(_m,_c,options){
  wire=options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]})
  return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection pending. Never deploy.'}]})}]})}
 }}}
 await summarizePiFork(ctx,{...snapshot,tokensBefore:400000},captured,{stage:async()=>{}})
 assert.equal(wire.max_tokens,89999)
 assert.equal(captured.model.maxTokens,128000);assert.equal(captured.payload.max_tokens,128000)
 assert.deepEqual(wire.messages.slice(0,-1),payload.messages)
 assert.deepEqual({...wire,messages:[],max_tokens:128000},{...captured.payload,messages:[]})
})

test('Pi branches at an earlier complete history boundary when the full retained tail cannot fit',async()=>{
 const tail={role:'user',content:'UNSUMMARIZED RECENT TAIL '.repeat(200),timestamp:3}
 const captured={...capture,model:{...capture.model,contextWindow:16000},messages:[...messages,tail],payload:{...payload,messages:[...payload.messages,{role:'user',content:tail.content}]}}
 let wire
 const ctx={model:captured.model,modelRegistry:{streamSimple(_m,context,options){
  assert.deepEqual(context.messages.slice(0,-1),messages)
  wire=options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:context.messages.at(-1).content}]})
  return {result:async()=>({stopReason:'stop',content:[{type:'text',text:'# State\nInspection remains pending. Never deploy.'}]})}
 }}}
 const result=await summarizePiFork(ctx,{...snapshot,tokensBefore:14500},captured,{stage:async()=>{}})
 assert.deepEqual(wire.messages.slice(0,-1),captured.payload.messages.slice(0,-1))
 assert.equal(captured.messages.at(-1).content,tail.content)
 assert.equal(result.prefixHash,forkHash(payload.messages))
})

test('Pi attempt deadline includes a stuck archive stage and fences its late continuation',async()=>{
 let release,entered,dispatches=0
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve)
 const ctx={model:capture.model,modelRegistry:{streamSimple(){dispatches++;throw Error('late dispatch')}}}
 const work=summarizePiFork(ctx,snapshot,capture,{stage:()=>{entered();return gate},timeoutMs:20})
 await started
 await assert.rejects(work,/timed out/)
 release();await new Promise(setImmediate)
 assert.equal(dispatches,0)
})

test('Pi output limits cover native field aliases without mutating the captured request',()=>{
 const model={contextWindow:500000,maxTokens:128000}
 assert.equal(piCompletionBudget(model,.8),90000)
 assert.equal(piCompletionBudget(model,.5),128000)
 assert.equal(piWindowSafety(model,.99),2500)
 const cases=[{max_tokens:128000},{max_completion_tokens:128000},{max_output_tokens:128000},{maxOutputTokens:128000},{maxTokens:128000},{generationConfig:{maxOutputTokens:128000}}]
 for(const original of cases){
  const capped=limitPiOutput(original,model,90000)
  assert.equal(piOutputReserve(capped,model),90000)
  assert.equal(piOutputReserve(original,model),128000)
 }
 for(const [api,payload] of [['openai-responses',{input:[]}],['anthropic-messages',{messages:[]}],['google-generative-ai',{contents:[]}]]){
  assert.equal(piOutputReserve(limitPiOutput(payload,{...model,api},90000),model),90000)
 }
 assert.throws(()=>limitPiOutput({},model,90000),/未声明/)
 assert.throws(()=>limitPiOutput({max_tokens:NaN},model,90000),/无效/)
 const conflicting={max_tokens:1000,max_completion_tokens:128000}
 assert.equal(piOutputReserve(conflicting,model),128000)
 assert.deepEqual(limitPiOutput(conflicting,model,90000),{max_tokens:1000,max_completion_tokens:90000})
 assert.throws(()=>limitPiOutput({max_tokens:1000,max_completion_tokens:NaN},model,90000),/无效/)
 assert.ok(estimatePiRequest({image:{type:'input_image',data:'a'.repeat(100)}})>=8192)
})
