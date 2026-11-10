// Real DSH admission/rebuild/compaction; the model adapter is wholly local.
import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore} from '@deepseek-ai/dsh-session'
import {assertReleasedV4Relationships} from '@deepseek-ai/dsh-session-format-v3-to-v4'
import {lab,history,send,close,count,checkpoint,until} from './reliability/lab.mjs'
import {forkScope,captureMainRequest} from '../dsh/main-fork.js'
import {ROLLING_DEFAULTS} from '../dsh/engine-config.js'
import {controlsConfig} from '../dsh/controls-config.js'
import {currentPolicy,activeInputTokens} from '../dsh/ratio-runtime.js'
import {estimateSummaryTokens} from '../src/summary-tokens.js'

test('a background branch uses only a matching original output allowance',()=>{
 const row={active:1,provider:'p',model:'m',requested:128000,effective:98976,option_max:null}
 const engine={outputBudgetState:{read:()=>row},runtimeGeneration:1},agent={session:{id:'s'},options:{}}
 const request={provider:'p',model:'m',maxTokens:98976,messages:[]}
 captureMainRequest(engine,agent,request)
 assert.equal(engine.mainRequests.get(agent).originalMaxTokens,128000)
 agent.options.maxTokens=98976
 captureMainRequest(engine,agent,request)
 assert.equal(engine.mainRequests.get(agent).originalMaxTokens,98976,'a changed user limit cannot reuse an old receipt')
 agent.options={};row.model='another-model'
 captureMainRequest(engine,agent,request)
 assert.equal(engine.mainRequests.get(agent).originalMaxTokens,98976,'another model cannot reuse the receipt')
})

test('an idle host closes without corrupting the native persisted event relationships',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 let closed=false
 try{
  assert.deepEqual(await send(h,'Continue the current task.'),[])
  const session=h.agent.session
  assert.equal(session.requestHeader().config.maxTokens,98976)
  await close(h);closed=true
  const events=session.snapshotEvents()
  assertReleasedV4Relationships({header:session.header,events,inheritedEventCount:0},new Set(events.map(e=>e.type)))
 }finally{if(!closed)await close(h)}
})

for(const fits of [true,false])test('native summary tree '+(fits?'may exceed its planning goal within the root limit':'must not exceed an unverified branch output limit'),async()=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:300,summaryRetryCooldownMs:1000}})
 let branches=0,budget
 try{
  history(h,fits?.72:.91)
  const original=h.ctx.llm.stream.bind(h.ctx.llm)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(s=>s.startsWith('[{"index":')))
   const target=Number(prompt.match(/together must fit (\d+) tokens/)[1])
   const hard=fits?currentPolicy(h.engine,h.agent).summaryPrefixTargetTokens:options.maxTokens
   const blocks=plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve constraints and pending work.'}))
   const total=()=>blocks.reduce((n,b)=>n+estimateSummaryTokens(b.summary),0)
   const wanted=fits?Math.ceil(target*1.07):hard+32
   blocks[0].summary+=' '+'x'.repeat(Math.max(0,wanted-total())*4)
   budget={target,hard,total:total()};assert.ok(budget.total>target)
   assert.equal(budget.total<=hard,fits)
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  const input='KEEP ORIGINAL REQUEST DURING SUMMARY VALIDATION'
  const pending=send(h,input)
  if(!fits){
   await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
   assert.equal(h.main.length,0);h.agent.cancel({kind:'user'},{keepInbox:true})
  }
  await pending
  if(fits){
   await until(()=>['ready','retrying'].includes(h.engine.backgroundFolds.get(h.agent)?.status))
   assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready',h.warnings.join('\n'))
   await h.engine.settleBackgroundFold(h.agent)
   await send(h,'CONTINUE WITH THE SAME SUMMARY '+'t'.repeat(28000))
   assert.equal(count(h,'compaction/summary'),1)
  }else assert.equal(count(h,'compaction/summary'),0)
  assert.equal(branches,1)
  assert.ok(h.agent.session.snapshotEvents().some(e=>JSON.stringify(e).includes(input)))
 }finally{await close(h)}
})

test('a complete archival tree may exceed the smaller installed root budget',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm);let budget,branches=0
 try{
  history(h,.72)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   assert.ok(plan.length>1)
   const rootLimit=currentPolicy(h.engine,h.agent).summaryPrefixTargetTokens
   const blocks=plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve decisions and pending work.'}))
   const total=()=>blocks.reduce((sum,b)=>sum+estimateSummaryTokens(b.summary),0)
   blocks[0].summary+=' '+'x'.repeat(Math.max(0,rootLimit+64-total())*4)
   budget={rootLimit,tree:total(),root:estimateSummaryTokens(blocks.at(-1).summary),output:options.maxTokens}
   assert.equal(h.agent.session.requestHeader().config.maxTokens,98976)
   assert.equal(options.maxTokens,128000,'background branch uses the original ceiling, not the foreground cap')
   assert.ok(budget.tree>rootLimit&&budget.tree<budget.output&&budget.root<rootLimit)
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  assert.deepEqual(await send(h,'START BACKGROUND TREE'),[])
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready',h.warnings.join('\n'))
  assert.equal(count(h,'compaction/summary'),0)
  assert.deepEqual(await send(h,'KEEP CURRENT INPUT '+ 'x'.repeat(180000)),[])
  assert.equal(count(h,'compaction/summary'),1)
  assert.equal(branches,1)
  assert.ok(h.main.at(-1).content.includes('KEEP CURRENT INPUT'))
 }finally{await close(h)}
})

test('a valid provider output count avoids rejecting an overestimated archival tree',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm);let branches=0
 try{
  history(h,.72)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   assert.ok(plan.length>1)
   const blocks=plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve decisions and pending work.'}))
   blocks[0].summary+=' '+'x'.repeat((options.maxTokens+64)*4)
   const text=JSON.stringify({blocks})
   assert.ok(estimateSummaryTokens(text)>options.maxTokens)
   yield {type:'text-delta',index:0,text}
   yield {type:'usage',usage:{inputTokens:360000,outputTokens:1000}}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  assert.deepEqual(await send(h,'KEEP PROVIDER-COUNTED TREE'),[])
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready',h.warnings.join('\n'))
  assert.deepEqual(await send(h,'CROSS REPLACEMENT '+ 'x'.repeat(180000)),[])
  assert.equal(branches,1);assert.equal(count(h,'compaction/summary'),1)
 }finally{await close(h)}
})

test('an oversized root shrinks the complete source prefix before retrying',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork',summaryRetryCooldownMs:10}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
 try{
  history(h,.85,{pieces:12})
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   const blocks=plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve decisions and pending work.'}))
   if(branches.length===1){
    const limit=currentPolicy(h.engine,h.agent).summaryPrefixTargetTokens
    blocks.at(-1).summary+=' '+'x'.repeat((limit+64)*4)
    assert.ok(blocks.reduce((sum,b)=>sum+estimateSummaryTokens(b.summary),0)<options.maxTokens)
   }
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  const input='KEEP INPUT WHILE ROOT BUDGET RECOVERS'
  assert.deepEqual(await send(h,input),[])
  assert.equal(branches.length,2)
  assert.ok(branches[1].messages.length<branches[0].messages.length)
  assert.equal(count(h,'compaction/summary'),1)
  assert.ok(h.main.at(-1).content.includes(input))
 }finally{await close(h)}
})

test('a complete over-cap reply is accepted when the full provider receipt fits',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm);let reported,branches=0
 try{
  history(h,.85)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   reported=100000
   assert.ok(reported>options.maxTokens&&reported>98976&&reported<128000&&380000+reported+1024<500000)
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve decisions and pending work.'}))})}
   yield {type:'usage',usage:{inputTokens:380000,outputTokens:reported}}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  assert.deepEqual(await send(h,'KEEP INPUT WITH VERIFIED PROVIDER RECEIPT'),[])
  assert.equal(branches,1);assert.equal(count(h,'compaction/summary'),1)
  assert.ok(h.main.at(-1).content.includes('KEEP INPUT WITH VERIFIED PROVIDER RECEIPT'))
 }finally{await close(h)}
})

test('an unsafe over-cap receipt retries with a shorter complete prefix',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork',summaryRetryCooldownMs:10}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
 try{
  history(h,.85,{pieces:12})
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve decisions and pending work.'}))})}
   if(branches.length===1)yield {type:'usage',usage:{inputTokens:490000,outputTokens:options.maxTokens+256}}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  assert.deepEqual(await send(h,'KEEP INPUT WITH UNSAFE RECEIPT'),[])
  assert.equal(branches.length,2)
  assert.ok(branches[1].messages.length<branches[0].messages.length)
  assert.equal(count(h,'compaction/summary'),1)
  assert.ok(h.main.at(-1).content.includes('KEEP INPUT WITH UNSAFE RECEIPT'))
 }finally{await close(h)}
})

test('a provider output above the original limit stops repeated attempts',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm);let branches=0
 try{
  history(h,.72)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve decisions and pending work.'}))})}
   yield {type:'usage',usage:{inputTokens:360000,outputTokens:128001}}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  assert.deepEqual(await send(h,'KEEP INPUT WITH INVALID PROVIDER RECEIPT'),[])
  const blocked=()=>h.engine.summaryGuards.terminalSessionFailure(h.agent,h.engine.summaryRouteFingerprint(),h.engine.summarySessionSignature(h.agent))
  await until(()=>blocked())
  assert.match(blocked(),/输出超过原始请求上限/)
  assert.equal(branches,1);assert.equal(count(h,'compaction/summary'),0)
  assert.equal(h.engine.canPrepareBackground(h.agent),false)
 }finally{await close(h)}
})

test('a truncated indivisible source stops retrying and preserves the pending input',async()=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryRetryCooldownMs:10}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm);let branches=0
 try{
  history(h,.91,{pieces:1})
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   yield {type:'text-delta',index:0,text:'incomplete'}
   yield {type:'finish',reason:{kind:'max-tokens'}}
  })()
  const input='KEEP INPUT WHEN A COMPLETE SOURCE GROUP CANNOT SHRINK'
  const errors=await send(h,input)
  assert.ok(errors.some(error=>/无法继续缩小/.test(String(error.message||error))))
  assert.equal(branches,1);assert.equal(count(h,'compaction/summary'),0)
  assert.equal(h.engine.canPrepareBackground(h.agent),false)
  assert.ok(h.agent.session.snapshotEvents().some(event=>JSON.stringify(event).includes(input)))
 }finally{await close(h)}
})

test('a later adapter override cannot send an oversized foreground request',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 try{
  history(h,.78)
  const prepare=h.ctx.llm.prepareCall.bind(h.ctx.llm)
  h.ctx.llm.prepareCall=(config,signal)=>prepare({...config,maxTokens:128000},signal)
  const errors=await send(h,'KEEP THIS INPUT WHEN ANOTHER SETTING OVERRIDES OUTPUT CAPACITY')
  assert.ok(errors.length)
  assert.equal(h.main.length,0,'foreground cannot bypass the real output reservation')
  assert.equal(count(h,'compaction/summary'),0)
  assert.ok(h.agent.session.snapshotEvents().some(e=>JSON.stringify(e).includes('KEEP THIS INPUT')))
 }finally{await close(h)}
})

test('a late 425K start limits only branch output and still replaces without trimming the prefix',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
 try{
  history(h,.85)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve decisions, constraints and pending work.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  await send(h,'KEEP CURRENT INPUT DURING LATE PREPARATION')
  assert.equal(branches.length,1);assert.equal(count(h,'compaction/summary'),1)
  assert.ok(branches[0].maxTokens<98976)
  const header=h.agent.session.snapshotEvents().find(e=>e.type==='request/header'&&e.data.header.config.maxTokens===98976)
  assert.ok(header)
  assert.ok(h.main.at(-1).content.includes('KEEP CURRENT INPUT DURING LATE PREPARATION'))
 }finally{await close(h)}
})

test('500K window prepares at 350K and replaces at 400K with a configured 128K output ceiling',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm);let branches=0,closed=false
 try{
  history(h,.696)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve constraints and pending work; originals remain available.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  await send(h,'STILL BELOW PREPARATION')
  assert.equal(branches,0)
  const p=currentPolicy(h.engine,h.agent)
  assert.equal(p.prepareActiveTokens,350000);assert.equal(p.softActiveTokens,400000)
  assert.ok(activeInputTokens(h.engine,h.agent)<350000)
  await send(h,'CROSS PREPARATION '+ 'x'.repeat(18000))
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(branches,1);assert.equal(count(h,'compaction/summary'),0)
  await send(h,'STILL BELOW REPLACEMENT '+ 'x'.repeat(120000))
  assert.ok(activeInputTokens(h.engine,h.agent)<400000)
  assert.equal(count(h,'compaction/summary'),0)
  await send(h,'CROSS REPLACEMENT AND KEEP EXACT '+ 'x'.repeat(80000))
  assert.equal(count(h,'compaction/summary'),1);assert.equal(branches,1)
  assert.ok(h.main.at(-1).content.includes('CROSS REPLACEMENT AND KEEP EXACT'))
  assert.equal(h.agent.options.maxTokens,128000,'user configuration stays intact')
  assert.equal(h.agent.session.requestHeader().config.maxTokens,98976)
  assert.ok(h.main.every(r=>r.inputTokens+r.maxTokens<500000))
  const session=h.agent.session
  await close(h);closed=true
  const fresh=new Context()
  try{
   new SessionStore(fresh)
   const resumed=fresh.sessions.create(session.id,{meta:session.header,seed:session.snapshotEvents(),eventState:'detached'})
   assert.deepEqual(resumed.requestHeader(),session.requestHeader(),'closing an idle host must leave a cold-readable log')
   assert.equal(resumed.requestHeader().config.maxTokens,98976,'shutdown must not append an out-of-turn header')
  }finally{await fresh.fiber.dispose()}
 }finally{if(!closed)await close(h)}
})

for(const stalled of [false,true])test('native fork '+(stalled?'still stops at its longer deadline':'can finish after the former three-minute deadline'),async t=>{
 const deadline=controlsConfig({auto:true,summaryMode:'main-fork'}).summaryTimeoutMs
 assert.equal(deadline,ROLLING_DEFAULTS.summaryTimeoutMs)
 assert.equal(deadline,600000)
 assert.equal(controlsConfig({auto:true,summaryMode:'main-fork',summaryTimeoutMs:120000}).summaryTimeoutMs,120000)
 const h=await lab({capacity:500000,config:{summaryMode:'main-fork',summaryTimeoutMs:deadline}})
 let release,branchSignal,branches=0
 const barrier=new Promise(resolve=>release=resolve),original=h.ctx.llm.stream.bind(h.ctx.llm)
 try{
  history(h,.72)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++;branchSignal=options.signal
   await barrier
   const directive=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# Historical state\nOriginal records preserve constraints and pending work.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  t.mock.timers.enable({apis:['setTimeout']})
  await send(h,'CURRENT INPUT MUST REMAIN VERBATIM')
  assert.equal(branches,1)
  assert.equal(h.main.length,1,'normal requests continue while a background fork is preparing')
  t.mock.timers.tick(180001)
  await Promise.resolve()
  assert.equal(branchSignal.aborted,false,'the old deadline must not cancel a large fork')
  assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'summarizing')
  if(stalled){
   t.mock.timers.tick(deadline)
   await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
   assert.equal(branchSignal.aborted,true)
   assert.ok(h.warnings.some(s=>s.includes('timeout')))
   assert.equal(count(h,'compaction/summary'),0)
  }else{
   release();await h.engine.settleBackgroundFold(h.agent)
   assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready',h.warnings.join('\n'))
   await send(h,'LATE INPUT '+ 't'.repeat(200000))
   assert.equal(count(h,'compaction/summary'),1,h.warnings.join('\n'))
   assert.equal(branches,1,'replacement reuses the finished fork')
  }
  assert.ok(h.agent.session.deriveMessages().some(m=>JSON.stringify(m).includes('CURRENT INPUT MUST REMAIN VERBATIM')))
 }finally{release?.();t.mock.timers.reset();await close(h)}
})

for(const failure of [false,true])test('real DSH main branch: '+(failure?'summary failure blocks capacity':'one background call, source blocks and append-only replacement'),async()=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:300,summaryRetryCooldownMs:1000}})
 try {
  history(h,failure?.91:.72)
  const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[],requests=[]
  let release
  const barrier=new Promise(resolve=>release=resolve)
  h.ctx.llm.stream=options=>{
   if(!forkScope.getStore()){requests.push(structuredClone({...options,signal:undefined}));return original(options)}
   return (async function*(){
    branches.push(structuredClone({...options,signal:undefined}))
    if(failure)throw Error('synthetic branch failure')
    await barrier
    const directive=options.messages.at(-1).content.map(b=>b.text||'').join('')
    const plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{"index":')))
    yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(range=>({index:range.index,summary:'# Historical state\nPending inspection. Read original records for exact facts.'}))})}
    yield {type:'usage',usage:{inputTokens:100,outputTokens:100,totalTokens:10200,cacheReadTokens:10000}}
    yield {type:'finish',reason:{kind:'stop'}}
   })()
  }
  const initial=send(h,'MAIN INPUT MUST REMAIN VERBATIM')
  await until(()=>branches.length===1)
  if(!failure){await until(()=>h.main.length===1);assert.equal(count(h,'compaction/summary'),0);release()}
  else{
   await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
   assert.equal(h.main.length,0);assert.equal(count(h,'compaction/summary'),0)
   h.agent.cancel({kind:'user'},{keepInbox:true})
  }
  await initial
  await h.engine.settleBackgroundFold(h.agent)
  if(failure){assert.equal(h.main.length,0);assert.equal(count(h,'compaction/summary'),0);return}
  assert.equal(branches.length,1)
  const mainRequest=h.engine.mainRequests.get(h.agent).request
  assert.deepEqual(branches[0].messages.slice(0,-1),mainRequest.messages)
  const settings=value=>({...value,messages:[],signal:undefined})
  assert.deepEqual(settings(branches[0]),settings(mainRequest))
  assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready',h.warnings.join('\n'))
  await send(h,'LATE APPENDED INPUT '+ 't'.repeat(28000))
  assert.equal(count(h,'compaction/summary'),1,h.warnings.join('\n'))
  assert.equal(branches.length,1,'replacement must never generate another summary')
  const event=h.agent.session.snapshotEvents().find(e=>e.type==='compaction/summary')
  assert.ok(event.data.preparedBatchCount>=2);assert.equal(event.data.usage.cacheReadTokens,10000)
  assert.ok(h.main.at(-1).content.includes('MAIN INPUT MUST REMAIN VERBATIM'))
  assert.ok(h.main.at(-1).content.includes('LATE APPENDED INPUT'))
  await checkpoint(h,{duplicate:false})
  history(h,.72)
  await send(h,'SECOND CYCLE INPUT')
  await h.engine.settleBackgroundFold(h.agent)
  await send(h,'SECOND CYCLE CONTINUE')
  assert.equal(count(h,'compaction/summary'),2,JSON.stringify({warnings:h.warnings,branches:branches.length,errors:h.errors.map(String),active:h.ctx.tokenMeter.measure(h.agent.session).totalTokens,state:h.engine.backgroundFolds.get(h.agent)?.status}))
  assert.equal(branches.length,2)
  await checkpoint(h,{duplicate:false})
 } finally{await close(h)}
})

for (const fault of ['truncated','tool-call','cancelled']) test('DSH branch refuses '+fault+' and keeps every original',async()=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:300,summaryRetryCooldownMs:1000}})
 try {
  history(h,.91)
  const original=h.ctx.llm.stream.bind(h.ctx.llm)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
    if(fault==='truncated'){yield {type:'text-delta',index:0,text:'{"blocks":[]}'};return}
    if(fault==='tool-call'){yield {type:'tool-call-delta',index:0,id:'forbidden',name:'read',argumentsDelta:'{}'};return}
    for(const controller of h.engine.backgroundControllers)controller.abort(Error('synthetic cancellation'))
    yield {type:'finish',reason:{kind:'stop'}}
  })()
  const pending=send(h,'CURRENT INPUT KEPT EXACTLY')
  if(fault!=='cancelled'){
   await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
   assert.equal(h.main.length,0)
   h.agent.cancel({kind:'user'},{keepInbox:true})
  }
  await pending
  assert.equal(h.main.length,0)
  assert.equal(count(h,'compaction/summary'),0)
  assert.ok(h.agent.session.snapshotEvents().some(event=>JSON.stringify(event).includes('CURRENT INPUT KEPT EXACTLY')))
 } finally {await close(h)}
})

test('native fork jobs share the archive lease and never generate concurrently',async()=>{
 const {withForkLease}=await import('../dsh/archive-fork.js')
 const h=await lab({config:{auto:false}});let release,started=0
 try{
  const barrier=new Promise(resolve=>release=resolve),run=()=>{started++;return barrier}
  const first=withForkLease(h.engine.superLcmStore.path,h.id,'revision',null,run)
  await assert.rejects(withForkLease(h.engine.superLcmStore.path,h.id,'revision',null,run),/已有后台摘要/)
  assert.equal(started,1);release();await first
  await withForkLease(h.engine.superLcmStore.path,h.id,'revision',null,()=>{started++})
  assert.equal(started,2)
 }finally{release?.();await close(h)}
})

test('a settings change during native generation fences archive publication',async()=>{
 const {registerForkArchive,forkArchiveSnapshot,publishForkArchive}=await import('../dsh/archive-fork.js')
 let revision='before',saved=0;const path='fixture-revision-fence'
 const unregister=registerForkArchive(path,async()=>{saved++},()=>revision)
 try{const snapshot=forkArchiveSnapshot(path);revision='after';await assert.rejects(publishForkArchive(path,'s',[],{},snapshot),/配置已变化/);assert.equal(saved,0)}finally{unregister()}
})

test('DSH 50% policy prepares at 40% and uses an optional native model only on its background branch',async()=>{
 const {automaticRatios}=await import('../dsh/ratio-policy.js')
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',forkModelOverride:true,...automaticRatios(.5),summarizationProvider:'lab-main',summarizationModel:'summary-alternate'}})
 try{
  const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   const directive=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# Historical state\nRetain all constraints. Work remains pending.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  history(h,.32);await send(h,'BELOW_40_PERCENT');await h.engine.settleBackgroundFold(h.agent)
  assert.equal(branches.length,0)
  const policy=h.engine.resolvedPolicies.get(h.agent),used=h.ctx.tokenMeter.measure(h.agent.session).totalTokens
  assert.ok(used<policy.prepareActiveTokens)
  const target=(policy.prepareActiveTokens+policy.softActiveTokens)/2
  history(h,Math.max(0,target-used)/(h.capacity-2048),{pieces:2});await send(h,'PREPARE_ABOVE_40_PERCENT');await h.engine.settleBackgroundFold(h.agent)
  assert.equal(branches.length,1,h.warnings.join('\n'));assert.equal(branches[0].model,'summary-alternate')
  assert.equal(h.agent.options.model,'main-64000');assert.equal(count(h,'compaction/summary'),0)
  assert.deepEqual(branches[0].messages.slice(0,-1),h.engine.mainRequests.get(h.agent).request.messages)
  await send(h,'LATER_INPUT '+ 't'.repeat(20000))
  assert.equal(count(h,'compaction/summary'),1,h.warnings.join('\n'))
  assert.equal(branches.length,1,'replacement must reuse the prepared tree')
  assert.equal(h.engine.mainRequests.get(h.agent).request.model,'main-64000')
 }finally{await close(h)}
})

test('DSH stops an impossible branch without repeated retries and reports the preserved input',async()=>{
 const {automaticRatios}=await import('../dsh/ratio-policy.js')
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',forkModelOverride:true,...automaticRatios(.5),summarizationProvider:'lab-main',summarizationModel:'main-8000'}})
 try{
  let branches=0;const original=h.ctx.llm.stream.bind(h.ctx.llm)
  h.ctx.llm.stream=options=>{if(forkScope.getStore())branches++;return original(options)}
  history(h,.42);const originals=h.agent.session.surface.nodes.slice()
  await send(h,'KEEP_INPUT_WHEN_SUMMARY_MODEL_IS_TOO_SMALL')
  const blocked=()=>h.engine.summaryGuards.terminalSessionFailure(h.agent,h.engine.summaryRouteFingerprint(),h.engine.summarySessionSignature(h.agent))
  await until(()=>blocked())
  assert.equal(branches,0);assert.equal(count(h,'compaction/summary'),0)
  assert.ok(originals.every(seq=>h.agent.session.surface.nodes.includes(seq)))
  assert.equal(h.agent.options.model,'main-64000')
  assert.match(blocked(),/停止重复重试/)
  h.engine.summaryGuards.clock=()=>Date.now()+86400000
  assert.deepEqual(await send(h,'A LATER INPUT'),[])
  assert.equal(h.engine.canPrepareBackground(h.agent),false)
  const input='PROTECTED INPUT '+ 'x'.repeat(60000)
  const errors=await send(h,input)
  assert.ok(errors.some(error=>/停止重复重试/.test(String(error.message||error))))
  assert.equal(branches,0);assert.equal(count(h,'compaction/summary'),0)
  assert.ok(h.agent.session.snapshotEvents().some(event=>JSON.stringify(event).includes(input)))
 }finally{await close(h)}
})

test('real DSH preserves recent originals with an oversized 80K retention preference on a 64K model',async()=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',keepRecentTokens:80000}})
 try {
  history(h,.72)
  const original=h.ctx.llm.stream.bind(h.ctx.llm);let branches=0
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   const directive=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# Historical decisions\nOriginal records retain all precise facts. Task remains pending.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  await send(h,'CURRENT REQUEST MUST STAY EXACT');await h.engine.settleBackgroundFold(h.agent)
  assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready',h.warnings.join('\n'))
  await send(h,'APPENDED AFTER PREPARATION '+ 't'.repeat(28000))
  assert.equal(count(h,'compaction/summary'),1,h.warnings.join('\n'))
  assert.equal(branches,1);assert.equal(h.errors.length,0)
  assert.ok(h.main.at(-1).content.includes('CURRENT REQUEST MUST STAY EXACT'))
  assert.ok(h.main.at(-1).content.includes('APPENDED AFTER PREPARATION'))
  await checkpoint(h,{duplicate:false})
 }finally{await close(h)}
})

test('a coarse legacy checkpoint becomes one immutable block without losing its direct originals',async()=>{
 const {markerFromSummary}=await import('../dsh/marker.js'),{originalNodeSources}=await import('../dsh/tree-semantics.js')
 const {ClaudeStore}=await import('../src/store.js'),{MainArchiveFork}=await import('../dsh/main-archive-fork.js'),{captureDshPacket,projectDshEvent}=await import('../src/dsh.js')
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork'}}),abort=new AbortController().signal
 const shared=new ClaudeStore(h.dir);shared.setIntegrationEnabled('dsh',true);shared.setHarnessSetting('dsh','main-fork')
 const archive=new MainArchiveFork(h.ctx,h.engine.superLcmStore,h.dir,error=>h.warnings.push(error.message))
 let cursor=0
 const sync=()=>{archive.capture(h.agent.session.id);const events=h.agent.session.snapshotEvents();captureDshPacket(shared,{header:h.agent.session.header,records:events.slice(cursor).map(e=>projectDshEvent(h.agent.session.id,e,''))});cursor=events.length;archive.mirror(h.agent.session.id)}
 const original=h.ctx.llm.stream.bind(h.ctx.llm)
 h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
  const prompt=options.messages.at(-1).content.map(b=>b.text||'').join(''),plan=JSON.parse(prompt.split('\n').find(x=>x.startsWith('[{"index":')))
  yield {type:'text-delta',text:JSON.stringify({blocks:plan.filter(n=>n.frozenSummary===undefined).map(n=>({index:n.index,summary:'# State\nPreserve all original constraints and ongoing work.'}))})};yield {type:'finish',reason:{kind:'stop'}}
 })()
 try{
  const session=h.agent.session
  session.append('turn/start',{turn:'legacy-source-fixture'})
  history(h,.08,{pieces:1});const first=session.surface.nodes.at(-1)
  await h.engine.compactRegion(first,first,h.agent,abort)
  const checkpoint=session.surface.nodes.at(-1)
  history(h,.08,{pieces:1});const direct=session.surface.nodes.at(-1)
  const legacy=await h.engine.compactRegion(checkpoint,direct,h.agent,abort),legacyId=markerFromSummary(legacy.summary).id
  session.append('turn/end',{turn:'legacy-source-fixture'})
  const expected=originalNodeSources(h.engine.superLcmStore,session.id,legacyId,seq=>session.eventAt(seq))
  assert.ok(expected.includes(direct));sync()
  for(let round=0;round<4;round++){
   history(h,.65,{pieces:10});assert.deepEqual(await send(h,'Preserve legacy direct originals '+round),[]);await h.engine.settleBackgroundFold(h.agent)
   assert.deepEqual(await send(h,'Continue without rewriting old blocks '+'n'.repeat(28000)),[]);await h.engine.settleBackgroundFold(h.agent);sync()
  }
  const aliases=h.engine.superLcmStore.listNodes(session.id,{limit:5000}).filter(n=>n.kind==='snapshot')
  assert.equal(aliases.length,1,'the coarse legacy snapshot must not be wrapped again on every round')
  assert.ok(expected.every(seq=>originalNodeSources(h.engine.superLcmStore,session.id,aliases[0].nodeId,n=>session.eventAt(n)).includes(seq)))
  assert.equal(aliases[0].summaryText,h.engine.superLcmStore.getNode(session.id,legacyId).summaryText)
  const alias=shared.outline('dsh-'+session.id,'dsh-native-'+aliases[0].nodeId).node
  assert.ok(alias.legacy_snapshot);assert.ok(expected.every(seq=>alias.source_records.includes(seq)))
  assert.ok(!shared.bands('dsh-'+session.id).some(n=>n.id==='dsh-native-'+legacyId),'the old lineage remains history rather than another current layer')
  assert.ok(shared.outline('dsh-'+session.id,'dsh-native-'+legacyId).node.historical)
  assert.deepEqual(await send(h,'One more request before switching to archive-only mode.'),[]);sync()
  const {readSettings}=await import('../dsh/settings.js'),{summarizeArchiveFork}=await import('../dsh/archive-fork.js'),doc=readSettings(h.dir),owner=archive.db.lease(session.id,doc.revision)
  assert.ok(owner)
  try{assert.equal(await summarizeArchiveFork(archive,session.id,doc,owner,abort,{force:true}),'complete')}finally{archive.db.release(session.id,owner)}
 }finally{await archive.close();shared.close();await close(h)}
})

test('24 main-model compression rounds reuse immutable blocks and merge across rounds',async t=>{
 const {ClaudeStore}=await import('../src/store.js'),{MainArchiveFork}=await import('../dsh/main-archive-fork.js'),{captureDshPacket,projectDshEvent}=await import('../src/dsh.js'),{markerFromSummary}=await import('../dsh/marker.js'),{nodeLevel}=await import('../dsh/core.js')
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork'}}),shared=new ClaudeStore(h.dir)
 shared.setIntegrationEnabled('dsh',true);shared.setHarnessSetting('dsh','main-fork')
 const archive=new MainArchiveFork(h.ctx,h.engine.superLcmStore,h.dir,error=>h.warnings.push(error.message)),frozen=[],depths=[]
 const original=h.ctx.llm.stream.bind(h.ctx.llm);let parentVersion=0,crossRoundMerges=0
 const immutable=new Map()
 h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
  parentVersion++
  const prompt=options.messages.at(-1).content.map(b=>b.text||'').join(''),plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
  frozen.push(...plan.filter(p=>p.frozenSummary).map(p=>p.frozenSummary))
  yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.filter(p=>!p.frozenSummary).map(p=>({index:p.index,summary:p.level?'# Overview\nPARENT_ONLY_DECISION_'+parentVersion+' remains active.':'# Historical decisions\nPreserve constraints, original evidence and pending inspection.'}))})}
  yield {type:'finish',reason:{kind:'stop'}}
 })()
 let cursor=0
 const sync=()=>{
  archive.capture(h.agent.session.id)
  const events=h.agent.session.snapshotEvents(),records=events.slice(cursor).map(e=>projectDshEvent(h.agent.session.id,e,''))
  captureDshPacket(shared,{header:h.agent.session.header,records});cursor=events.length;archive.mirror(h.agent.session.id)
 }
 try{
  for(let round=0;round<24;round++){
   const oldIds=new Set(h.engine.superLcmStore.listNodeIds(h.agent.session.id))
   history(h,round===0?.72:.58,{pieces:10});sync()
   assert.deepEqual(await send(h,'Continue audit round '+round),[])
   await h.engine.settleBackgroundFold(h.agent)
   assert.deepEqual(await send(h,'Keep the same decisions '+round+' '+'n'.repeat(26000)),[])
   await h.engine.settleBackgroundFold(h.agent);sync()
   const entries=h.agent.session.surface.nodes.map(seq=>h.agent.session.eventAt(seq)),marker=entries.map(e=>markerFromSummary(e.data?.content)).find(Boolean)
   assert.ok(marker,JSON.stringify({round,warnings:h.warnings,state:h.engine.backgroundFolds.get(h.agent)?.status,usage:h.ctx.tokenMeter.measure(h.agent.session).totalTokens}));depths.push(nodeLevel(h.engine.superLcmStore,h.agent.session.id,marker.id))
   const parent=h.engine.superLcmStore.getNode(h.agent.session.id,marker.id),decision=parent.summaryText.match(/PARENT_ONLY_DECISION_\d+/)?.[0]
   assert.ok(decision,JSON.stringify({round,depths,summary:parent.summaryText,parentVersion}))
   assert.ok(h.main.at(-1).content.includes(decision),'the actual model-written parent must reach the resumed conversation')
   const rows=shared.db.prepare('SELECT id,summary FROM nodes WHERE session=?').all('dsh-'+h.agent.session.id)
   assert.ok(rows.every(n=>!n.id.startsWith('dsh-fork-')),'native and archive use the same identity')
   for(const node of h.engine.superLcmStore.listNodes(h.agent.session.id,{limit:5000})){
    const content=JSON.stringify([node.summary,node.childIds,node.sourceSeqs])
    if(immutable.has(node.nodeId))assert.equal(content,immutable.get(node.nodeId),'existing blocks must not be rewritten')
    else {immutable.set(node.nodeId,content);if(node.kind==='condensed'&&node.childIds.some(id=>oldIds.has(id)))crossRoundMerges++}
   }
  }
  assert.ok(frozen.length>=4,'later rounds must carry existing checkpoints without rewriting')
  assert.ok(depths.every(depth=>Number.isSafeInteger(depth)&&depth>0),'each model-written parent has a valid semantic depth')
  const leaves=h.engine.superLcmStore.listNodes(h.agent.session.id,{limit:5000}).filter(n=>!n.childIds.length)
  assert.ok(crossRoundMerges>0,'old and new blocks must actually merge in later branch responses')
  assert.ok(Math.max(...depths)<=Math.ceil(Math.log(leaves.length)/Math.log(4))+2,JSON.stringify({depths,leaves:leaves.length}))
  assert.ok(shared.find('PARENT_ONLY_DECISION_1',{session:'dsh-'+h.agent.session.id}).summaries.length,'historical parent-only decisions stay searchable')
  t.diagnostic(JSON.stringify({rounds:24,rawBlocks:leaves.length,maxLayers:Math.max(...depths),crossRoundMerges}))
  assert.ok(h.warnings.every(w=>!w.includes('祖先')&&!w.includes('分支摘要树不完整')&&!w.includes('changed')))
 }finally{await archive.close();shared.close();await close(h)}
})

test('DSH selection pricing scales post-compaction deltas and recovers usage across interrupted assistant turns',async()=>{
 const {createAssistantMessage}=await import('@deepseek-ai/dsh-llm')
 const h=await lab({capacity:500000,priceFactor:2.5,config:{summaryMode:'main-fork'}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm)
 try{
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve decisions, constraints and pending work.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  history(h,.28,{pieces:6})
  assert.deepEqual(await send(h,'Calibrate dense text baseline'),[])
  assert.deepEqual(await send(h,'Start background preparation'),[])
  await h.engine.settleBackgroundFold(h.agent)
  const beforeInterrupt=activeInputTokens(h.engine,h.agent)
  assert.ok(beforeInterrupt>350000,'calibrated baseline must reflect the 2.5x provider usage')
  // Append an interrupted assistant turn without usage; calibration must not collapse to 1x.
  const session=h.agent.session,turn=3,step=1
  session.append('turn/start',{turn})
  session.append('step/start',{turn,step})
  session.append('assistant/message',{turn,step,interrupted:true,message:createAssistantMessage({content:[{type:'text',text:'Partial interrupted output.'}],source:{provider:'lab-main',model:h.model}}),stream:[]},{surfaceOp:'append'})
  session.append('step/end',{turn,step})
  session.append('turn/end',{turn,reason:{kind:'aborted',reason:{kind:'user'}}})
  h.agent.phase.lastTurn=turn
  const afterInterrupt=activeInputTokens(h.engine,h.agent)
  assert.ok(afterInterrupt>=beforeInterrupt,'an interrupted assistant turn without usage must preserve prior usage calibration')
  // Trigger replacement at 80%; post-compaction activeInputTokens must scale the negative delta by 2.5x.
  let postCompactionActive=0
  h.ctx.on('session/event',(s,ev)=>{if(s===session&&ev.type==='compaction/end')postCompactionActive=activeInputTokens(h.engine,h.agent)})
  assert.deepEqual(await send(h,'Cross 80% replacement '+'x'.repeat(80000)),[])
  assert.equal(count(h,'compaction/summary'),1)
  assert.ok(postCompactionActive>0&&postCompactionActive<200000,`post-compaction activeInputTokens (${postCompactionActive}) must not retain unscaled phantom tokens`)
 }finally{await close(h)}
})

test('DSH main-fork slices to the selected prefix and shrinks when a cold session or truncation exceeds capacity',async t=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryRetryCooldownMs:1000}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
 try{
  history(h,.98,{pieces:10})
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   if(branches.length===1){
    yield {type:'text-delta',index:0,text:'{"blocks":[{"index":0,"summary":"# Truncated"}'}
    yield {type:'finish',reason:{kind:'max-tokens'}}
    return
   }
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve constraints and pending work.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  t.mock.timers.enable({apis:['setTimeout','Date']})
  const pending=send(h,'PROTECTED CURRENT TURN '+'y'.repeat(12000),{timeout:1000000})
  await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
  const state=h.engine.backgroundFolds.get(h.agent)
  assert.equal(state.errorKind,'length')
  t.mock.timers.tick(state.retryAt-Date.now())
  assert.deepEqual(await pending,[])
  assert.equal(branches.length,2)
  assert.ok(branches[1].messages.length<branches[0].messages.length,'length retry shrinks the selected prefix')
  assert.equal(count(h,'compaction/summary'),1)
  assert.ok(h.main.at(-1).content.includes('PROTECTED CURRENT TURN'))
 }finally{t.mock.timers.reset();await close(h)}
})

test('DSH main-fork dynamic preparation retention offsets 70%-80% growth and refreshes a stale draft',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork',keepRecentTokens:40000}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
 try{
  history(h,.704,{pieces:20})
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve constraints and pending work.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  await send(h,'START PREPARATION AT 70%')
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(branches.length,1)
  const firstState=h.engine.backgroundFolds.get(h.agent),firstEnd=firstState.summarized.end
  assert.ok(firstState.selection.tailTokens<=30000,`at 70% preparation, natural 50K growth buffer cuts closer to the end (tail=${firstState.selection.tailTokens})`)
  assert.equal(h.engine.planRolling(h.agent),null,'fresh draft with small tail does not re-prepare')
  history(h,.26,{pieces:6})
  h.agent.session.append('turn/start',{})
  h.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Latest user request'}]}),{surfaceOp:'append'})
  const refreshed=h.engine.planRolling(h.agent)
  assert.ok(refreshed,'stale draft with >110K accumulated tail refreshes its cut point')
  assert.ok(refreshed.end>firstEnd)
 }finally{await close(h)}
})
