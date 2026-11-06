import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync,realpathSync } from 'node:fs'
import { dirname,join } from 'node:path'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { findCli } from '../src/runtime.js'
import { summarizePiFork,piForkPlan,capturePiContext,piCompactedContext } from '../src/pi-fork.js'
import {makePiSnapshot,estimatePiMessages} from '../src/pi-snapshot.js'
import { forkHash, parseForkSummary } from '../src/fork-summary.js'
import { estimatePiRequest, estimatePiWireWithReceipt, measuredPiContextTokens, limitPiOutput, piCompletionBudget, piOutputReserve, piWindowSafety } from '../src/pi-request.js'
import { estimateSummaryTokens } from '../src/summary-tokens.js'
const first={role:'user',content:'Please inspect /tmp/fixture; never deploy.',timestamp:1}
const second={role:'assistant',content:[{type:'text',text:'Inspection pending.'}],timestamp:2}
const messages=[{role:'system',content:'System',toolsAdded:[{name:'read',parameters:{type:'object'}}]},first,second]
const payload={model:'fixture',messages:[{role:'system',content:'System'},{role:'user',content:first.content},{role:'assistant',content:'Inspection pending.'}],tools:[{type:'function',function:{name:'read'}}],max_tokens:2048,prompt_cache_key:'main-session',temperature:.2}
const snapshot={session_id:'main-session',sourceMessages:[first,second],source:'source',tokensBefore:10000}
const capture={payload,messages,model:{provider:'fixture',id:'fixture',contextWindow:1000000,maxTokens:2048},reasoning:'high'}
let piRoot=dirname(realpathSync(findCli('pi')))
while(!existsSync(join(piRoot,'package.json'))){const parent=dirname(piRoot);if(parent===piRoot)throw Error('Pi SDK package not found');piRoot=parent}
const anthropicSDK=await import(pathToFileURL(join(piRoot,'node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js')))
const openaiCompletionsSDK=await import(pathToFileURL(join(piRoot,'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')))
const openaiResponsesSDK=await import(pathToFileURL(join(piRoot,'node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js')))
const googleSDK=await import(pathToFileURL(join(piRoot,'node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js')))
const piMessagesSDK=await import(pathToFileURL(join(piRoot,'node_modules/@earendil-works/pi-ai/dist/api/pi-messages.js')))
const bedrockSDK=await import(pathToFileURL(join(piRoot,'node_modules/@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js')))
const googleModel={id:'gemini-2.5-flash',provider:'google',api:'google-generative-ai',baseUrl:'http://127.0.0.1:9',contextWindow:1000000,maxTokens:65536,input:['text'],reasoning:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}
async function googlePayload(source,signal,model=googleModel){
 let captured
 const stream=googleSDK.streamSimple(model,{messages:source},{apiKey:'synthetic',signal,onPayload(value){captured=value;throw Error('stop before transport')}})
 await stream.result();assert.ok(captured,'Google SDK must construct a request locally')
 return captured
}

test('Pi malformed provider completions are terminal instead of retrying a broken result shape',async()=>{
 for(const completion of [null,{}, {stopReason:'stop',content:[null]}]){
  const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,options){return {result:async()=>{options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:_c.messages.at(-1).content}]});return completion}}}}}
  await assert.rejects(summarizePiFork(ctx,snapshot,capture,{stage:async()=>({checkpoints:[]})}),error=>error.code==='SUPERLCM_PI_UNSUPPORTED_REQUEST')
 }
})

test('Pi budgets source-verified encrypted reasoning using its original output receipt',()=>{
 const model={provider:'opencodex',id:'fixture',api:'openai-responses',contextWindow:500000,maxTokens:128000}
 const one={type:'reasoning',id:'rs_1',encrypted_content:'A'.repeat(160000),summary:[]}
 const two={type:'reasoning',id:'rs_2',encrypted_content:'B'.repeat(160000),summary:[]}
 const history=[{role:'assistant',provider:model.provider,model:model.id,api:model.api,stopReason:'stop',
  usage:{input:50000,output:4000,cacheRead:100,cacheWrite:0,reasoning:3500},content:[one,two].map(item=>({type:'thinking',thinking:'',thinkingSignature:JSON.stringify(item)}))}]
 const wire={input:[one,two,{role:'user',content:'Question'}],max_output_tokens:128000},original=structuredClone(wire)
 const raw=estimatePiRequest(wire),budgeted=estimatePiRequest(wire,{history,model})
 assert.ok(raw>80000);assert.ok(budgeted>=4000&&budgeted<8000,'one measured output budget covers all same-response reasoning blocks')
 assert.ok(estimatePiMessages(history,model)>=4000&&estimatePiMessages(history,model)<8000)
 assert.deepEqual(wire,original,'estimation must never change a replayed request')
 const duplicate={...wire,input:[one,two,one]}
 assert.ok(estimatePiRequest(duplicate,{history,model})>40000,'a duplicate wire block is not budgeted twice as the same receipt')
 const changed={...wire,input:[{...one,encrypted_content:'C'.repeat(160000)},two]}
 assert.ok(estimatePiRequest(changed,{history,model})>40000,'changed ciphertext must fall back to a conservative byte estimate')
 for(const bad of [undefined,{...history[0].usage,reasoning:undefined},{...history[0].usage,output:0},{...history[0].usage,reasoning:5000}]){
  const noReceipt=[{...history[0],usage:bad}]
  assert.equal(estimatePiRequest(wire,{history:noReceipt,model}),raw,'missing or invalid usage must never reduce the guard')
 }
 assert.equal(estimatePiRequest(wire,{history,model:{...model,id:'other'}}),raw,'usage from another model cannot calibrate this request')
 assert.equal(estimatePiRequest(wire,{history:[{...history[0],stopReason:'aborted'}],model}),raw,'aborted output is not a paid completion')
 const sameId={...two,id:one.id},ambiguous=[{...history[0],content:[one,sameId].map(item=>({type:'thinking',thinking:'',thinkingSignature:JSON.stringify(item)}))}]
 const collision={...wire,input:[one,sameId]}
 assert.equal(estimatePiRequest(collision,{history:ambiguous,model}),estimatePiRequest(collision),'ambiguous source identities must not be discounted')
 const nested={input:[{role:'user',content:[{type:'input_text',text:'A'.repeat(160000)}]}],tools:[{type:'function',description:'B'.repeat(160000)}]}
 assert.equal(estimatePiRequest(nested,{history,model}),estimatePiRequest(nested),'ordinary content and tools must never be discounted')
 // OpenCodex models configured as openai-completions still route tool turns through openai-responses.
 const completionsModel={...model,api:'openai-completions'}
 assert.equal(estimatePiRequest(wire,{history,model:completionsModel}),budgeted,'openai-completions wrapper model still honors matching openai-responses receipts')
 assert.equal(estimatePiMessages(structuredClone(history),completionsModel),estimatePiMessages(history,model),'cloned message arrays still match receipts by signature')
 // Non-thinking toolCall/text content is not counted a second time on top of output usage, and toolResult.details/nestedCalls are excluded.
 const withToolCall=[{...history[0],usage:{input:50000,output:4500,cacheRead:100,cacheWrite:0,reasoning:500},
  content:[...history[0].content,{type:'toolCall',id:'call_1',name:'bash',arguments:{command:'x'.repeat(15000)}}]},
  {role:'toolResult',toolCallId:'call_1',content:[{type:'text',text:'ok'}],details:{diff:'D'.repeat(200000)},nestedCalls:[{output:'N'.repeat(200000)}]}]
 assert.ok(estimatePiMessages(withToolCall,completionsModel)<8000,'toolCall output and Pi-only toolResult details/nestedCalls must not inflate context')
})

test('Pi recovers the last valid receipt after a failed-turn context_edit and calibrates cold wire estimates',()=>{
 const model={provider:'opencodex',id:'gpt-6-astra--fast',api:'openai-completions',contextWindow:500000,maxTokens:128000}
 const item={type:'reasoning',id:'rs_ok',encrypted_content:'A'.repeat(800000),summary:[{type:'summary_text',text:'S'.repeat(20000)}]}
 const paid={role:'assistant',provider:model.provider,model:model.id,api:'openai-responses',stopReason:'toolUse',
  usage:{input:689,output:410,cacheRead:290048,cacheWrite:0,reasoning:0,totalTokens:291147},
  content:[{type:'thinking',thinking:'T'.repeat(4000),thinkingSignature:JSON.stringify(item)},{type:'toolCall',id:'c1',name:'bash',arguments:{cmd:'ls'}}]}
 const entries=[
  {sourceEntry:{id:'u1',type:'message',parentId:null},messages:[{role:'user',content:'请检查代码。'+'中文工具输出。'.repeat(60000)}]},
  {sourceEntry:{id:'a1',type:'message',parentId:'u1'},messages:[paid]},
  {sourceEntry:{id:'t1',type:'message',parentId:'a1'},messages:[{role:'toolResult',toolCallId:'c1',content:[{type:'text',text:'done'}]}]},
  {sourceEntry:{id:'edit1',type:'context_edit',parentId:'err1',targetId:'err1',replacement:null},messages:[]},
  {sourceEntry:{id:'u2',type:'message',parentId:'edit1'},messages:[{role:'user',content:'继续'}]},
 ]
 const branch=[
  {id:'u1',type:'message',parentId:null},
  {id:'a1',type:'message',parentId:'u1'},
  {id:'t1',type:'message',parentId:'a1'},
  {id:'err1',type:'message',parentId:'t1'},
  {id:'edit1',type:'context_edit',parentId:'err1',targetId:'err1',replacement:null},
  {id:'u2',type:'message',parentId:'edit1'},
 ]
 const measured=measuredPiContextTokens(entries,model,153549,branch)
 assert.ok(measured>=291147&&measured<295000,'context_edit deleting a later failed turn must not collapse 291K to 153K')
 const editedPrefix=[...entries.slice(0,3),{sourceEntry:{id:'edit0',type:'context_edit',parentId:'t1',targetId:'u1',replacement:null},messages:[]}]
 assert.equal(measuredPiContextTokens(editedPrefix,model,153549),null,'editing an earlier prefix entry invalidates the old receipt')
 const allMessages=entries.flatMap(e=>e.messages)
 const wire={input:[{role:'user',content:'请检查代码。'},item,{role:'user',content:'继续'}],max_output_tokens:128000}
 assert.ok(estimatePiRequest(wire,{history:allMessages,model})<5000,'openai-completions model calibrates openai-responses encrypted reasoning on wire')
})

test('Pi applies measured reasoning budgets to the installed Responses SDK without sending a request',async()=>{
 const model={...googleModel,id:'fixture',provider:'opencodex',api:'openai-responses'}
 const reasoning={type:'reasoning',id:'rs_sdk',encrypted_content:'A'.repeat(200000),summary:[]}
 const history=[{role:'user',content:'Inspect.',timestamp:1},{role:'assistant',api:model.api,model:model.id,provider:model.provider,
  content:[{type:'thinking',thinking:'',thinkingSignature:JSON.stringify(reasoning)},{type:'text',text:'Done.'}],
  usage:{input:3000,output:2000,reasoning:1500,cacheRead:0,cacheWrite:0,totalTokens:5000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:2},
  {role:'user',content:'Continue.',timestamp:3}]
 let sent,networkCalls=0
 const stream=openaiResponsesSDK.streamSimple(model,{messages:history},{apiKey:'offline',fetch(){networkCalls++;throw Error('network must not be used')},
  onPayload(value){sent=value;throw Error('captured locally')}})
 await stream.result();assert.ok(sent);assert.equal(networkCalls,0)
 assert.ok(estimatePiRequest(sent)>50000)
 const result=estimatePiRequest(sent,{history,model})
 assert.ok(result>=2000&&result<6000)
 assert.equal(sent.input.find(i=>i.type==='reasoning').encrypted_content,reasoning.encrypted_content)
})

test('Pi receipt calibration requires the exact sent prefix and conservatively counts additions',()=>{
 const model={provider:'fixture',id:'fixture',api:'openai-responses',contextWindow:500000,maxTokens:128000}
 const before={input:[{role:'user',content:'证'.repeat(320000)}],tools:[{name:'read'}]},previous={model,leafId:'before',payload:before}
 const reply={role:'assistant',provider:'fixture',model:'fixture',stopReason:'toolUse',usage:{input:76,output:4988,cacheRead:341248,cacheWrite:0}}
 const rows=[{sourceEntry:{id:'before',type:'message'},messages:[]},{sourceEntry:{id:'reply',type:'message',parentId:'before'},messages:[reply]}]
 const current={...before,input:[...before.input,{role:'assistant',content:'证'.repeat(9000)}]}
 assert.ok(estimatePiRequest(current)>488976)
 const estimated=estimatePiWireWithReceipt(current,previous,rows,346335,model)
 assert.ok(estimated>346335&&estimated<400000)
 assert.equal(estimatePiWireWithReceipt({...current,input:[{role:'user',content:'changed'}]},previous,rows,346335,model),null)
 assert.equal(estimatePiWireWithReceipt(current,previous,rows,346335,{...model,id:'other'}),null)
 assert.equal(estimatePiWireWithReceipt(current,previous,rows.slice(0,1),346335,model),null)
 const changed={...current,tools:[{name:'read',description:'证'.repeat(100000)}]}
 assert.ok(estimatePiWireWithReceipt(changed,previous,rows,346335,model)>488976,'new tool schemas are counted without subtracting old fields')
 const huge={...current,input:[...current.input,{role:'user',content:'证'.repeat(100000)}]}
 assert.ok(estimatePiWireWithReceipt(huge,previous,rows,346335,model)>488976,'new oversized dialogue is counted')
})

test('Pi receipt-calibrated wire suffix uses the matching output receipt for encrypted reasoning',()=>{
 const model={provider:'opencodex',id:'fixture',api:'openai-responses',contextWindow:500000,maxTokens:128000}
 const item={type:'reasoning',id:'rs_suffix',encrypted_content:'A'.repeat(2000000),summary:[]}
 const previous={model,leafId:'before',payload:{input:[{role:'user',content:'Original source'}]}}
 const reply={role:'assistant',provider:model.provider,model:model.id,api:model.api,stopReason:'toolUse',
  usage:{input:200000,output:4000,reasoning:3500,cacheRead:96000,cacheWrite:0},content:[{type:'thinking',thinking:'',thinkingSignature:JSON.stringify(item)}]}
 const rows=[{sourceEntry:{id:'before',type:'message'},messages:[]},{sourceEntry:{id:'reply',parentId:'before',type:'message'},messages:[reply]}]
 const current={input:[...previous.payload.input,item]}
 const estimated=estimatePiWireWithReceipt(current,previous,rows,300000,model)
 assert.ok(estimated>=300000&&estimated<400000,'the new paid response is not charged as two million characters')
 const changed={input:[...previous.payload.input,{...item,encrypted_content:'B'.repeat(2000000)}]}
 assert.ok(estimatePiWireWithReceipt(changed,previous,rows,300000,model)>500000,'modified ciphertext remains fully counted')
})

test('Pi receipt calibration counts the new response only once',()=>{
 const model={provider:'fixture',id:'fixture',api:'openai-responses',contextWindow:500000,maxTokens:128000}
 const previous={model,leafId:'before',payload:{input:[{role:'user',content:'Original source'}]}}
 const rows=[{sourceEntry:{id:'before',type:'message'},messages:[]},{sourceEntry:{id:'reply',parentId:'before',type:'message'},messages:[{role:'assistant',provider:'fixture',model:'fixture',stopReason:'stop',usage:{input:300000,output:85000,cacheRead:0,cacheWrite:0}}]}]
 const current={input:[...previous.payload.input,{role:'assistant',content:'证'.repeat(76000)}]}
 const estimated=estimatePiWireWithReceipt(current,previous,rows,385000,model)
 assert.ok(estimated>=385000&&estimated<430000,'85K completed output is already present in the new serialized suffix')
})

test('Pi receipt calibration excludes terminal effort metadata but never skips dialogue',()=>{
 const model={provider:'fixture',id:'fixture',api:'openai-responses',contextWindow:500000,maxTokens:128000}
 const user={role:'user',content:'Original source'},config={type:'configuration_update',reasoning:{effort:'high'}}
 const previous={model,leafId:'before',payload:{input:[user,config]}}
 const rows=[{sourceEntry:{id:'before',type:'message'},messages:[]},{sourceEntry:{id:'reply',parentId:'before',type:'message'},messages:[{role:'assistant',provider:'fixture',model:'fixture',stopReason:'stop',usage:{input:300000,output:5000,cacheRead:0,cacheWrite:0}}]}]
 const current={input:[user,{role:'assistant',content:'Response'},config]}
 assert.ok(estimatePiWireWithReceipt(current,previous,rows,305000,model)>=305000)
 assert.equal(estimatePiWireWithReceipt({...current,input:[{...user,content:'Changed'},...current.input.slice(1)]},previous,rows,305000,model),null)
 const unknown={type:'configuration_update',reasoning:{effort:'high'},content:'Unknown text is not metadata'}
 assert.equal(estimatePiWireWithReceipt(current,{...previous,payload:{input:[user,unknown]}},rows,305000,model),null)
})

test('Pi accepts native effort metadata after the summary instruction',async()=>{
 for(const [sdk,api,id] of [[openaiResponsesSDK,'openai-responses','gpt-5'],[anthropicSDK,'anthropic-messages','claude-opus-4-6']])for(const small of [false,true]){
  const model={...googleModel,id,provider:api==='openai-responses'?'openai':'anthropic',api,reasoning:true,maxTokens:16000,contextWindow:small?16000:1000000,compat:{supportsMidConvoEffort:true,supportsMidConvoSystemMessages:true}}
  const source=[messages[0],first,{role:'user',content:'KEEP RECENT '.repeat(1000),timestamp:3}]
  let sent,callbackError
  const ctx={model,sessionManager:{getSessionId:()=> 'effort'},modelRegistry:{streamSimple(m,context,options){return {result:async()=>{
   let final
   const stream=sdk.streamSimple(m,context,{...options,apiKey:'synthetic',onPayload(value){try{final=options.onPayload(value)}catch(error){callbackError=error};throw Error('offline capture')}})
   await stream.result()
   if(context.messages.at(-1).content?.startsWith?.('Produce source-grounded')){if(callbackError)throw callbackError;sent=final;return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection remains pending.'}]})}]}}
   callbackError=undefined;return {stopReason:'aborted'}
  }}}}}
  const captured=await capturePiContext(ctx,source,'high')
  const result=await summarizePiFork(ctx,{...snapshot,sourceMessages:[first],tokensBefore:small?14500:10000},captured,{stage:async()=>({checkpoints:[]})})
  const field=api==='openai-responses'?'input':'messages',tail=sent[field].at(-1)
  assert.ok(tail.type==='configuration_update'||tail.output_config?.effort)
  assert.equal(sent[field].at(-2).role,'user')
  const prefix=small?captured.payload[field].slice(0,sent[field].length-2):captured.payload[field]
  assert.deepEqual(sent[field].slice(0,prefix.length),prefix)
  assert.equal(result.prefixHash,forkHash(prefix))
  if(small)assert.ok(!JSON.stringify(sent[field]).includes('KEEP RECENT'))
 }
})

test('Pi output caps preserve legal reasoning budgets in real Anthropic and Bedrock requests',async()=>{
 const base={...googleModel,id:'claude-3-7-sonnet-20250219',provider:'anthropic',api:'anthropic-messages',reasoning:true,maxTokens:64000}
 const cases=[
  {sdk:anthropicSDK,model:base,options:{apiKey:'synthetic'},get:p=>({max:p.max_tokens,thinking:p.thinking})},
  {sdk:bedrockSDK,model:{...base,id:'anthropic.claude-3-7-sonnet-20250219-v1:0',provider:'amazon-bedrock',api:'bedrock-converse-stream'},options:{env:{AWS_BEDROCK_SKIP_AUTH:'1',AWS_REGION:'us-east-1'}},get:p=>({max:p.inferenceConfig.maxTokens,thinking:p.additionalModelRequestFields.thinking})},
 ]
 for(const {sdk,model,options,get} of cases){
  let original;const stream=sdk.streamSimple(model,{messages},{...options,reasoning:'high',onPayload(p){original=p;throw Error('stop before transport')}})
  await stream.result();assert.ok(original,model.api);const before=get(original)
  assert.equal(before.thinking.budget_tokens,16384)
  const limited=get(limitPiOutput(original,model,2999))
  assert.equal(limited.max,2999);assert.ok(limited.thinking.budget_tokens>=1024&&limited.thinking.budget_tokens<limited.max)
  assert.equal(before.thinking.budget_tokens,16384,'do not mutate captured payload')
  assert.equal(get(limitPiOutput(original,model,1025)).thinking.budget_tokens,1024)
  assert.throws(()=>limitPiOutput(original,model,1024),/思考|thinking/i)
 }
})
test('Pi output caps retain answer room in real Google and OpenAI-compatible thinking requests',async()=>{
 const google={...googleModel,id:'gemini-2.5-pro',reasoning:true}
 const openai={...googleModel,id:'local-reasoner',provider:'fixture',api:'openai-completions',reasoning:true,compat:{thinkingTokenBudgetField:'thinking_token_budget'}}
 const cases=[
  {sdk:googleSDK,model:google,read:p=>({max:p.config.maxOutputTokens,budget:p.config.thinkingConfig.thinkingBudget})},
  {sdk:openaiCompletionsSDK,model:openai,read:p=>({max:p.max_completion_tokens??p.max_tokens,budget:p.thinking_token_budget})},
 ]
 for(const {sdk,model,read} of cases){
  let original;const stream=sdk.streamSimple(model,{messages},{apiKey:'synthetic',reasoning:'high',onPayload(p){original=p;throw Error('stop before transport')}})
  await stream.result();assert.ok(original,model.api);const before=read(original);assert.ok(before.budget>2999)
  const after=read(limitPiOutput(original,model,2999))
  assert.equal(after.max,2999);assert.ok(after.budget>0&&after.budget<=1975)
  assert.deepEqual(read(original),before)
 }
})

test('Pi capped Anthropic thinking reaches only a valid local SDK endpoint',async t=>{
 let requests=0,wire
 const server=createServer(async(req,res)=>{
  requests++;let body='';for await(const part of req)body+=part;wire=JSON.parse(body)
  const directive=wire.messages.at(-1).content.map(part=>part.text||'').join('\n'),plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{')))
  const text=JSON.stringify({blocks:plan.map(part=>({index:part.index,summary:'# State\nInspection remains pending.'}))})
  const events=[{type:'message_start',message:{id:'synthetic',model:'claude-3-7-sonnet-20250219',usage:{input_tokens:1000,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},
   {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:100}},{type:'message_stop'}]
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const model={...googleModel,id:'claude-3-7-sonnet-20250219',provider:'anthropic',api:'anthropic-messages',baseUrl:`http://127.0.0.1:${server.address().port}`,reasoning:true,contextWindow:100000,maxTokens:64000}
 const ctx={model,sessionManager:{getSessionId:()=> 'anthropic-local'},modelRegistry:{streamSimple(m,c,o){return anthropicSDK.streamSimple(m,c,{...o,apiKey:'synthetic'})}}}
 const captured=await capturePiContext(ctx,messages,'high',new AbortController().signal);assert.equal(requests,0)
 await summarizePiFork(ctx,{...snapshot,tokensBefore:95000},captured,{stage:async()=>({checkpoints:[]})})
 assert.equal(requests,1);assert.equal(wire.max_tokens,2999)
 assert.ok(wire.thinking.budget_tokens>=1024&&wire.thinking.budget_tokens<wire.max_tokens)
})

test('Pi cold capture passes disabled reasoning to the real Anthropic SDK as undefined',async()=>{
 const model={...googleModel,id:'claude-3-7-sonnet-20250219',provider:'anthropic',api:'anthropic-messages',reasoning:true,maxTokens:64000}
 const ctx={model,sessionManager:{getSessionId:()=> 'off'},modelRegistry:{streamSimple(m,c,o){return anthropicSDK.streamSimple(m,c,{...o,apiKey:'synthetic'})}}}
 const result=await capturePiContext(ctx,messages,'off',new AbortController().signal)
 assert.equal(result.payload.max_tokens,64000);assert.equal(result.payload.thinking.type,'disabled');assert.equal(result.reasoning,undefined)
})
test('Pi Anthropic OAuth branch adds no fifth cache breakpoint to the original prefix',async()=>{
 const model={...googleModel,id:'claude-3-7-sonnet-20250219',provider:'anthropic',api:'anthropic-messages',reasoning:true,maxTokens:64000}
 const source=[messages[0],first,second,{role:'user',content:'LATEST',timestamp:3}],key='sk-ant-oat-synthetic'
 let original;const firstStream=anthropicSDK.streamSimple(model,{messages:source},{apiKey:key,onPayload(p){original=p;throw Error('stop before transport')}})
 await firstStream.result();assert.ok(original)
 let wire,callbackError
 const ctx={model,modelRegistry:{streamSimple(m,c,o){return {result:async()=>{
  const stream=anthropicSDK.streamSimple(m,c,{...o,apiKey:key,onPayload(p){try{wire=o.onPayload(p)}catch(error){callbackError=error};throw Error('stop before transport')}})
  await stream.result();if(callbackError)throw callbackError
  return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection remains pending.'}]})}]}
 }}}}}
 await summarizePiFork(ctx,{...snapshot,tokensBefore:10000},{model,messages:source,payload:original,reasoning:undefined},{stage:async()=>({checkpoints:[]})})
 const markers=p=>(JSON.stringify(p).match(/\"cache_control\"/g)||[]).length
 assert.equal(markers(original),4);assert.equal(markers(wire),4)
 assert.deepEqual(wire.messages.slice(0,-1),original.messages)
 assert.deepEqual(wire.system,original.system);assert.deepEqual(wire.tools,original.tools)
})

test('Pi OpenAI-compatible cached branch retains only the original cache breakpoints',async()=>{
 const model={...googleModel,id:'fixture',provider:'fixture',api:'openai-completions',compat:{cacheControlFormat:'anthropic'}}
 const source=[messages[0],first,second,{role:'user',content:'LATEST',timestamp:3}]
 let original;const firstStream=openaiCompletionsSDK.streamSimple(model,{messages:source},{apiKey:'synthetic',onPayload(p){original=p;throw Error('stop before transport')}})
 await firstStream.result();assert.ok(original)
 let wire,callbackError
 const ctx={model,modelRegistry:{streamSimple(m,c,o){return {result:async()=>{
  const stream=openaiCompletionsSDK.streamSimple(m,c,{...o,apiKey:'synthetic',onPayload(p){try{wire=o.onPayload(p)}catch(error){callbackError=error};throw Error('stop before transport')}})
  await stream.result();if(callbackError)throw callbackError
  return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection remains pending.'}]})}]}
 }}}}}
 await summarizePiFork(ctx,{...snapshot,tokensBefore:10000},{model,messages:source,payload:original,reasoning:undefined},{stage:async()=>({checkpoints:[]})})
 const markers=p=>(JSON.stringify(p).match(/\"cache_control\"/g)||[]).length
 assert.ok(markers(original)>0);assert.equal(markers(wire),markers(original));assert.deepEqual(wire.messages.slice(0,-1),original.messages)
})

test('Pi limits the real Google SDK output field without breaking its abort signal',async()=>{
 const controller=new AbortController(),original=await googlePayload(messages,controller.signal)
 assert.equal(original.config.maxOutputTokens,65536)
 const capped=limitPiOutput(original,googleModel,1024)
 assert.equal(capped.config.maxOutputTokens,1024)
 assert.equal(capped.config.abortSignal,controller.signal)
 assert.equal(original.config.maxOutputTokens,65536)
 assert.equal(piOutputReserve(capped,googleModel),1024)
})
test('Pi replays a real Google SDK contents prefix in its background branch',async()=>{
 const controller=new AbortController(),original=await googlePayload(messages,controller.signal)
 const captured={model:googleModel,messages,payload:original,reasoning:'off'}
 let sent,branchSignal
 const ctx={model:googleModel,modelRegistry:{streamSimple(model,context,options){
  branchSignal=options.signal
  return {result:async()=>{
   let callbackError
   const stream=googleSDK.streamSimple(model,context,{...options,apiKey:'synthetic',onPayload(value){
    try{sent=options.onPayload(value)}catch(error){callbackError=error}
    throw Error('stop before transport')
   }})
   await stream.result();if(callbackError)throw callbackError
   return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection remains pending. Never deploy.'}]})}]}
  }}
 }}}
 await summarizePiFork(ctx,snapshot,captured,{stage:async()=>({checkpoints:[]})})
 assert.deepEqual(sent.contents.slice(0,-1),original.contents)
 assert.equal(sent.contents.at(-1).role,'user')
 assert.equal(sent.config.abortSignal,branchSignal)
 assert.equal(original.config.abortSignal,controller.signal)
})
test('Pi replays a shortened real Google SDK prefix without the retained tail',async()=>{
 const model={...googleModel,contextWindow:16000,maxTokens:2048},tail={role:'user',content:'KEEP-RECENT '.repeat(1000),timestamp:3}
 const all=[...messages,tail],original=await googlePayload(all,new AbortController().signal,model)
 let sent
 const ctx={model,modelRegistry:{streamSimple(m,context,options){return {result:async()=>{
  let callbackError
  const stream=googleSDK.streamSimple(m,context,{...options,apiKey:'synthetic',onPayload(value){try{sent=options.onPayload(value)}catch(error){callbackError=error};throw Error('stop before transport')}})
  await stream.result();if(callbackError)throw callbackError
  return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection remains pending. Never deploy.'}]})}]}
 }}}}}
 await summarizePiFork(ctx,{...snapshot,tokensBefore:14500},{model,messages:all,payload:original,reasoning:'off'},{stage:async()=>({checkpoints:[]})})
 assert.deepEqual(sent.contents.slice(0,-1),original.contents.slice(0,-1))
 assert.ok(!JSON.stringify(sent.contents).includes('KEEP-RECENT'))
})
test('Pi cold prefix preserves later system updates when the real SDK folds them',async()=>{
 const initial={role:'system',content:'Initial instructions.',sections:{tools:'Old tool instructions.'},toolsAdded:[{name:'old',description:'Old tool',parameters:{type:'object'}}],timestamp:0}
 const tail={role:'user',content:'KEEP-RECENT '.repeat(1000),timestamp:3}
 const update={role:'system',content:'',sections:{tools:'Updated tool instructions.'},toolsAdded:[{name:'new',description:'New tool',parameters:{type:'object'}}],toolsRemoved:[{name:'old'}],timestamp:4}
 for(const [sdk,api,mid] of [[openaiResponsesSDK,'openai-responses',false],[openaiResponsesSDK,'openai-responses',true],[piMessagesSDK,'pi-messages',true]]){
  const model={...googleModel,id:'fixture',provider:'fixture',api,contextWindow:16000,maxTokens:2048,compat:{supportsDeveloperRole:false,supportsMidConvoSystemMessages:mid}}
  const assistant={...second,api,provider:'fixture',model:'fixture',stopReason:'stop',usage:{input:100,output:10,cacheRead:0,cacheWrite:0,totalTokens:110}}
  const all=[initial,first,assistant,tail,update]
  let original
  const initialStream=sdk.streamSimple(model,{messages:all},{apiKey:'synthetic',sessionId:'offline',onPayload(value){original=value;throw Error('stop before transport')}})
  await initialStream.result();assert.ok(original)
  let sent,callbackError
  const ctx={model,modelRegistry:{streamSimple(m,context,options){return {result:async()=>{
   const branch=sdk.streamSimple(m,context,{...options,apiKey:'synthetic',onPayload(value){try{sent=options.onPayload(value)}catch(error){callbackError=error};throw Error('stop before transport')}})
   await branch.result();if(callbackError)throw callbackError
   return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection remains pending.'}]})}]}
  }}}}}
  await summarizePiFork(ctx,{...snapshot,sourceMessages:[first,assistant],tokensBefore:14500},{model,messages:all,payload:original},{stage:async()=>({checkpoints:[]})})
  const before=api==='pi-messages'?original.context.messages:original.input,after=api==='pi-messages'?sent.context.messages:sent.input
  assert.deepEqual(after.slice(0,-1),before.slice(0,after.length-1),`${api} mid=${mid}`)
  assert.ok(!JSON.stringify(after).includes('KEEP-RECENT'))
  if(api==='openai-responses'&&!mid){
   assert.match(after[0].content,/Updated tool instructions/);assert.deepEqual(sent.tools,original.tools)
   const changed=structuredClone(original);changed.input[1].content[0].text+=' tampered'
   sent=undefined;callbackError=undefined
   await assert.rejects(summarizePiFork(ctx,{...snapshot,sourceMessages:[first,assistant],tokensBefore:14500},{model,messages:all,payload:changed},{stage:async()=>({checkpoints:[]})}),/较早分支与原始请求前缀不一致/)
   assert.equal(sent,undefined,'a changed source prefix must not be dispatched')
  }
 }
})

test('Pi limits the real Bedrock and pi-messages SDK output fields',async()=>{
 const cases=[
  {sdk:bedrockSDK,model:{...googleModel,id:'amazon.nova-pro-v1:0',provider:'amazon-bedrock',api:'bedrock-converse-stream'},options:{env:{AWS_BEDROCK_SKIP_AUTH:'1',AWS_REGION:'us-east-1'}},path:['inferenceConfig','maxTokens']},
  {sdk:piMessagesSDK,model:{...googleModel,id:'fixture',provider:'fixture',api:'pi-messages'},options:{apiKey:'synthetic'},path:['options','maxTokens']},
 ]
 for(const {sdk,model,options,path} of cases){
  let original
  const stream=sdk.streamSimple(model,{messages},{...options,maxTokens:65536,onPayload(value){original=value;throw Error('stop before transport')}})
  await stream.result();assert.ok(original,model.api)
  assert.equal(original[path[0]][path[1]],65536)
  const capped=limitPiOutput(original,model,1024)
  assert.equal(capped[path[0]][path[1]],1024,model.api)
  assert.equal(original[path[0]][path[1]],65536)
  assert.equal(piOutputReserve(capped,model),1024)
 }
})
test('Pi replays a real pi-messages SDK nested context in its background branch',async()=>{
 const model={...googleModel,id:'fixture',provider:'fixture',api:'pi-messages'}
 let original
 const initial=piMessagesSDK.streamSimple(model,{messages},{apiKey:'synthetic',maxTokens:65536,onPayload(value){original=value;throw Error('stop before transport')}})
 await initial.result();assert.ok(original)
 let sent
 const ctx={model,modelRegistry:{streamSimple(m,context,options){return {result:async()=>{
  let callbackError
  const stream=piMessagesSDK.streamSimple(m,context,{...options,apiKey:'synthetic',onPayload(value){try{sent=options.onPayload(value)}catch(error){callbackError=error};throw Error('stop before transport')}})
  await stream.result();if(callbackError)throw callbackError
  return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection remains pending. Never deploy.'}]})}]}
 }}}}}
 await summarizePiFork(ctx,snapshot,{model,messages,payload:original,reasoning:'off'},{stage:async()=>({checkpoints:[]})})
 assert.deepEqual(sent.context.messages.slice(0,-1),original.context.messages)
 assert.equal(sent.context.messages.at(-1).role,'user')
})
test('Pi Google capture and capped summary reach only a local SDK endpoint',async t=>{
 let requests=0,wire
 const server=createServer(async(req,res)=>{
  requests++;let body='';for await(const part of req)body+=part
  wire=JSON.parse(body)
  const directive=wire.contents.at(-1).parts.map(part=>part.text||'').join('\n')
  const plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{')))
  const text=JSON.stringify({blocks:plan.map(part=>({index:part.index,summary:'# State\nInspection remains pending. Never deploy.'}))})
  res.writeHead(200,{'content-type':'text/event-stream'})
  res.end('data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:5000,candidatesTokenCount:100,totalTokenCount:5100}})+'\n\n')
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(()=>new Promise(resolve=>server.close(resolve)))
 const model={...googleModel,baseUrl:`http://127.0.0.1:${server.address().port}/v1beta`,contextWindow:100000}
 const ctx={model,sessionManager:{getSessionId:()=> 'local-google'},modelRegistry:{streamSimple(m,c,o){return googleSDK.streamSimple(m,c,{...o,apiKey:'synthetic'})}}}
 const captured=await capturePiContext(ctx,messages,'off',new AbortController().signal)
 assert.equal(requests,0,'local capture must not send a request')
 const result=await summarizePiFork(ctx,{...snapshot,tokensBefore:95000},captured,{stage:async()=>({checkpoints:[]})})
 assert.equal(requests,1)
 assert.deepEqual(wire.contents.slice(0,-1),captured.payload.contents)
 assert.equal(wire.generationConfig.maxOutputTokens,2999)
 assert.match(result.tree.at(-1).summary,/Inspection remains pending/)
})

test('Pi native pi-messages capture and capped summary reach only a local SDK endpoint',async t=>{
 let requests=0,wire
 const server=createServer(async(req,res)=>{
  requests++;let body='';for await(const part of req)body+=part
  wire=JSON.parse(body)
  const directive=wire.context.messages.at(-1).content
  const plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{')))
  const text=JSON.stringify({blocks:plan.map(part=>({index:part.index,summary:'# State\nInspection remains pending. Never deploy.'}))})
  const usage={input:5000,output:100,cacheRead:0,cacheWrite:0,totalTokens:5100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}
  const events=[{type:'start'},{type:'text_start',contentIndex:0},{type:'text_delta',contentIndex:0,delta:text},{type:'text_end',contentIndex:0,content:text},{type:'done',reason:'stop',usage}]
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(()=>new Promise(resolve=>server.close(resolve)))
 const model={...googleModel,id:'fixture',provider:'fixture',api:'pi-messages',baseUrl:`http://127.0.0.1:${server.address().port}`,contextWindow:100000}
 const ctx={model,sessionManager:{getSessionId:()=> 'local-pi-messages'},modelRegistry:{streamSimple(m,c,o){return piMessagesSDK.streamSimple(m,c,{...o,apiKey:'synthetic'})}}}
 const captured=await capturePiContext(ctx,messages,'off',new AbortController().signal)
 assert.equal(requests,0)
 const result=await summarizePiFork(ctx,{...snapshot,tokensBefore:95000},captured,{stage:async()=>({checkpoints:[]})})
 assert.equal(requests,1);assert.deepEqual(wire.context.messages.slice(0,-1),captured.payload.context.messages)
 assert.equal(wire.options.maxTokens,2999);assert.match(result.tree.at(-1).summary,/Inspection remains pending/)
})

test('Pi blocked-image cold capture and summary send no image to the real SDK local endpoint',async t=>{
 const secret='U0VDUkVULVBJQ1RVUkU=',user={role:'user',content:[{type:'text',text:'Inspect.'},{type:'image',data:secret,mimeType:'image/png'}],timestamp:1}
 let wire,requests=0
 const server=createServer(async(req,res)=>{
  requests++;let body='';for await(const part of req)body+=part;wire=JSON.parse(body)
  const directive=wire.context.messages.at(-1).content,plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{')))
  const text=JSON.stringify({blocks:plan.map(part=>({index:part.index,summary:'# State\nInspection remains pending.'}))})
  const usage={input:1000,output:100,cacheRead:0,cacheWrite:0,totalTokens:1100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}
  const events=[{type:'start'},{type:'text_start',contentIndex:0},{type:'text_delta',contentIndex:0,delta:text},{type:'text_end',contentIndex:0,content:text},{type:'done',reason:'stop',usage}]
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const model={...googleModel,id:'fixture',provider:'fixture',api:'pi-messages',input:['text','image'],baseUrl:`http://127.0.0.1:${server.address().port}`,contextWindow:100000}
 const ctx={model,sessionManager:{getSessionId:()=> 'blocked-local'},modelRegistry:{streamSimple(m,c,o){return piMessagesSDK.streamSimple(m,c,{...o,apiKey:'synthetic'})}}}
 const source=[messages[0],user],captured=await capturePiContext(ctx,source,'off',new AbortController().signal,{blockImages:true})
 assert.equal(requests,0);assert.doesNotMatch(JSON.stringify(captured),new RegExp(secret))
 await summarizePiFork(ctx,{...snapshot,sourceMessages:[user],tokensBefore:95000},captured,{stage:async()=>({checkpoints:[]})})
 assert.equal(requests,1);assert.doesNotMatch(JSON.stringify(wire),new RegExp(secret))
 assert.match(JSON.stringify(wire),/Image reading is disabled/)
})

test('Pi cold capture respects the host setting that blocks images',async()=>{
 const image={type:'image',data:'U0VDUkVULVBJQ1RVUkU=',mimeType:'image/png'}
 const source=[messages[0],{role:'user',content:[{type:'text',text:'Keep the text.'},image,image],timestamp:1},
  {role:'toolResult',toolCallId:'image-call',toolName:'read',content:[image],isError:false,timestamp:2}]
 let seen
 const ctx={model:capture.model,sessionManager:{getSessionId:()=> 'blocked-images'},modelRegistry:{streamSimple(_model,context,options){
  seen=context.messages
  return {result:async()=>{try{options.onPayload({messages:context.messages})}catch{return {stopReason:'aborted'}}}}
 }}}
 const result=await capturePiContext(ctx,source,'high',undefined,{blockImages:true})
 assert.doesNotMatch(JSON.stringify(seen),/U0VDUkVULVBJQ1RVUkU=/)
 assert.deepEqual(result.messages[1].content,[{type:'text',text:'Keep the text.'},{type:'text',text:'Image reading is disabled.'}])
 assert.deepEqual(result.messages[2].content,[{type:'text',text:'Image reading is disabled.'}])
 assert.equal(result.blockImages,true)
})
test('Pi branches with blocked images using the host-filtered message shape',async()=>{
 const image={type:'image',data:'U0VDUkVULVBJQ1RVUkU=',mimeType:'image/png'}
 const original={role:'user',content:[{type:'text',text:'Inspect.'},image],timestamp:1}
 const filtered={...original,content:[{type:'text',text:'Inspect.'},{type:'text',text:'Image reading is disabled.'}]}
 const captured={...capture,blockImages:true,messages:[messages[0],original],payload:{model:'fixture',messages:[messages[0],filtered],max_tokens:2048}}
 const selected={...snapshot,sourceMessages:[original],summaryModel:'fixture/alternate'}
 let sent
 const alternate={...capture.model,id:'alternate'}
 const ctx={model:capture.model,modelRegistry:{find:()=>alternate,streamSimple(_model,context,options){
  sent=options.onPayload({model:'alternate',messages:context.messages,max_tokens:2048})
  return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection pending.'}]})}]})}
 }}}
 await summarizePiFork(ctx,selected,captured,{stage:async()=>({checkpoints:[]})})
 assert.doesNotMatch(JSON.stringify(sent),/U0VDUkVULVBJQ1RVUkU=/)
 assert.deepEqual(sent.messages[1],filtered)
})

test('Pi blocks a late branch payload if its image settings or source changed',async()=>{
 let entered,release,current=true,dispatched=false
 const begun=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve)
 const ctx={model:capture.model,modelRegistry:{streamSimple(_model,context,options){
  entered();return {result:async()=>{await waiting;try{options.onPayload({...payload,messages:context.messages});dispatched=true}catch{return {stopReason:'error',errorMessage:'request rejected'}};return {stopReason:'stop',content:[]}}}
 }}}
 const task=summarizePiFork(ctx,snapshot,capture,{stage:async()=>({checkpoints:[]}),isCurrent:()=>current})
 await begun;current=false;release()
 await assert.rejects(task,/来源或设置已变化/)
 assert.equal(dispatched,false)
})

test('Pi cold request capture stops before dispatch and keeps the foreground signal alive',async()=>{
 const parent=new AbortController();let calls=0,localSignal
 const ctx={model:capture.model,sessionManager:{getSessionId:()=> 'cold'},modelRegistry:{streamSimple(_model,_context,options){
  calls++;localSignal=options.signal
  return {result:async()=>{try{options.onPayload(payload)}catch{return {stopReason:'aborted'}};throw Error('provider dispatch must be unreachable')}}
 }}}
 const result=await capturePiContext(ctx,messages,'high',parent.signal)
 assert.equal(calls,1);assert.equal(localSignal.aborted,true);assert.equal(parent.signal.aborted,false)
 assert.deepEqual(result.payload,payload);assert.deepEqual(result.messages,messages)
})
test('Pi cold capture returns the local payload even when the provider result stays pending',async()=>{
 let options
 const ctx={model:capture.model,sessionManager:{getSessionId:()=> 'cold'},modelRegistry:{streamSimple(_model,_context,opts){
  options=opts;return {result(){try{opts.onPayload(payload)}catch{};return new Promise(()=>{})}}
 }}}
 const result=await capturePiContext(ctx,messages,'high',undefined,{timeoutMs:500})
 assert.deepEqual(result.payload,payload);assert.equal(options.signal.aborted,true)
 assert.throws(()=>options.onPayload(payload),/捕获已结束/)
})
test('Pi cold capture respects cancellation even if the provider never finishes',async()=>{
 let started,release,options
 const begun=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve),controller=new AbortController()
 const ctx={model:capture.model,sessionManager:{getSessionId:()=> 'cold'},modelRegistry:{streamSimple(_model,_context,opts){options=opts;started();return {result:()=>blocked}}}}
 const work=capturePiContext(ctx,messages,'high',controller.signal)
 const outcome=work.then(()=> 'accepted',()=> 'cancelled')
 await begun;controller.abort(Error('synthetic capture cancellation'))
 const observed=await Promise.race([outcome,new Promise(resolve=>setTimeout(()=>resolve('hung'),100))])
 assert.throws(()=>options.onPayload(payload),/synthetic capture cancellation/)
 release({stopReason:'aborted'});await outcome
 assert.equal(observed,'cancelled')
})
test('Pi cold capture times out if a provider ignores its signal',async()=>{
 let started,release
 const begun=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve)
 const ctx={model:capture.model,sessionManager:{getSessionId:()=> 'cold'},modelRegistry:{streamSimple(){started();return {result:()=>blocked}}}}
 const work=capturePiContext(ctx,messages,'high',undefined,{timeoutMs:20})
 const outcome=work.then(()=> 'accepted',()=> 'timed out')
 await begun
 const observed=await Promise.race([outcome,new Promise(resolve=>setTimeout(()=>resolve('hung'),100))])
 release({stopReason:'aborted'});await outcome
 assert.equal(observed,'timed out')
})

test('Pi prepared request replacement preserves every system update and the exact unsummarized tail',async()=>{
 const lateSystem={role:'system',content:'',toolsAdded:[{name:'new_tool',parameters:{type:'object'}}],timestamp:3}
 const tail={role:'user',content:'KEEP THIS EXACT CURRENT REQUEST',timestamp:4},original=[...messages,lateSystem,tail]
 const changed=await piCompactedContext(snapshot,{summary:'# Prepared state\nKeep the original constraints.',tokensBefore:400000},original)
 assert.deepEqual(changed.filter(m=>m.role==='system'),[messages[0],lateSystem])
 assert.equal(changed.at(-1),tail);assert.ok(changed.some(m=>JSON.stringify(m).includes('Prepared state')))
 assert.deepEqual(original,[...messages,lateSystem,tail])
 await assert.rejects(()=>piCompactedContext(snapshot,{summary:'# Prepared'},[messages[0],{...first,content:'changed'},second,tail]),/不一致/)
})
test('Pi replacement preserves the chronological position of retained system updates',async()=>{
 const kept={role:'user',content:'Original user request before policy change.',timestamp:3}
 const patch={role:'system',content:'From now on, do not edit files.',timestamp:4}
 const current={role:'user',content:'Current request after policy change.',timestamp:5}
 const result=await piCompactedContext(snapshot,{summary:'# Prepared\nPreserve previous context.',tokensBefore:400000},[...messages,kept,patch,current])
 assert.deepEqual(result.slice(-3),[kept,patch,current])
})
test('Pi replaces a raw native compaction summary without mistaking it for a different message',async()=>{
 const previous={role:'compactionSummary',summary:'# Previous context\nKeep the old decision.',tokensBefore:300000,timestamp:1}
 const tail={role:'user',content:'Keep the latest request.',timestamp:3}
 const hidden={role:'bashExecution',command:'private',excludeFromContext:true,timestamp:0}
 const raw=[messages[0],hidden,previous,first,tail], selected={...snapshot,sourceMessages:[previous,first]}
 const result=await piCompactedContext(selected,{summary:'# New context\nKeep the prior decision.',tokensBefore:400000},raw)
 assert.equal(result.at(-1),tail)
 assert.ok(result.some(m=>JSON.stringify(m).includes('New context')))
 assert.ok(!result.some(m=>m.summary===previous.summary))
})
test('Pi plans a prior native summary from raw request-time context',async()=>{
 const previous={role:'compactionSummary',summary:'# Previous context\nKeep the old decision.',tokensBefore:300000,timestamp:1}
 const selected={...snapshot,sourceMessages:[previous,first]}
 const plan=await piForkPlan(selected,{messages:[messages[0],previous,first,second]})
 assert.equal(plan[0].firstMessage,1);assert.equal(plan.at(-1).lastMessage,2)
})
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

test('Pi keeps a complete tree when a gateway ignores a reduced output cap but the full receipt fits',async()=>{
 const captured={...capture,model:{...capture.model,contextWindow:500000,maxTokens:128000},payload:{...payload,max_tokens:128000}}
 const usage={input:4712,cacheRead:299392,cacheWrite:0,output:18661,reasoning:8546,totalTokens:322765}
 let sent
 const ctx={model:captured.model,modelRegistry:{streamSimple(_m,_c,options){
  sent=options.onPayload({...captured.payload,messages:[...payload.messages,{role:'user',content:_c.messages.at(-1).content}]})
  return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection is unfinished. Preserve exact originals.'}]})}],usage})}
 }}}
 const result=await summarizePiFork(ctx,{...snapshot,tokensBefore:480000},captured,{stage:async()=>({})})
 assert.ok(sent.max_tokens<usage.output&&usage.output<captured.model.maxTokens)
 assert.equal(result.usage.output,18661);assert.ok(result.tree[0].summary.includes('Preserve exact originals'))
})
test('Pi real Responses SDK keeps a complete over-cap reply without another model call',async()=>{
 const model={...googleModel,id:'fixture',provider:'fixture',api:'openai-responses',contextWindow:500000,maxTokens:128000,compat:{supportsDeveloperRole:false,supportsMaxOutputTokens:true}}
 let requests=0,wire
 const fetch=async(_url,init)=>{
  requests++;wire=JSON.parse(init.body)
  const text=JSON.stringify({blocks:[{index:0,summary:'# State\nInspection remains unfinished. Keep the complete original transcript.'}]})
  const item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]}
  const response={id:'resp_fixture',model:'fixture',status:'completed',output:[item],usage:{input_tokens:304104,output_tokens:18661,total_tokens:322765,input_tokens_details:{cached_tokens:299392},output_tokens_details:{reasoning_tokens:8546}}}
  const events=[{type:'response.created',response:{...response,output:[],usage:undefined}},
   {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
   {type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:text},
   {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}]
  return new Response(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
 }
 const ctx={model,sessionManager:{getSessionId:()=> 'offline-over-cap'},modelRegistry:{streamSimple(m,c,o){return openaiResponsesSDK.streamSimple(m,c,{...o,apiKey:'synthetic',fetch})}}}
 const captured=await capturePiContext(ctx,messages,'high')
 const result=await summarizePiFork(ctx,{...snapshot,tokensBefore:480000},captured,{stage:async()=>({})})
 assert.equal(requests,1);assert.ok(wire.max_output_tokens<18661)
 assert.equal(result.usage.input,4712);assert.equal(result.usage.cacheRead,299392);assert.equal(result.usage.output,18661)
 assert.ok(result.tree[0].summary.includes('unfinished'))
})
for(const [fault,usage,code] of [
 ['missing input',{output:18661},'SUPERLCM_PI_PREFIX_CAPACITY'],
 ['cached input exceeds window',{input:4712,cacheRead:480000,cacheWrite:0,output:18661},'SUPERLCM_PI_PREFIX_CAPACITY'],
 ['invalid input',{input:-1,cacheRead:299392,output:18661},'SUPERLCM_PI_PREFIX_CAPACITY'],
 ['output exceeds original limit',{input:4712,cacheRead:299392,output:128001},'SUPERLCM_PI_UNSUPPORTED_REQUEST'],
])test('Pi does not accept an over-cap receipt with '+fault,async()=>{
 const captured={...capture,model:{...capture.model,contextWindow:500000,maxTokens:128000},payload:{...payload,max_tokens:128000}}
 const ctx={model:captured.model,modelRegistry:{streamSimple(_m,_c,options){
  options.onPayload({...captured.payload,messages:[...payload.messages,{role:'user',content:'directive'}]})
  return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nPending.'}]})}],usage})}
 }}}
 await assert.rejects(summarizePiFork(ctx,{...snapshot,tokensBefore:480000},captured,{stage:async()=>({})}),error=>error.code===code)
})

test('Pi accepts a complete provider-counted tree when the local tokenizer overestimates output',async()=>{
 const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,options){
  const wire=options.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]})
  const limit=piOutputReserve(wire,capture.model),summary='# Historical state\n'+'x'.repeat((limit+1)*4)
  return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary}]})}],usage:{output:limit}})}
 }}}
 const result=await summarizePiFork(ctx,snapshot,capture,{stage:async()=>{}})
 assert.ok(result.treeOptions.targetTokens>capture.model.maxTokens)
 assert.ok(result.tree[0].summary.startsWith('# Historical'))
})
test('Pi still rejects an unverified complete tree beyond its final output limit',async()=>{
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

test('Pi malformed completed output is terminal, while a truncated reply requests a smaller prefix',async()=>{
 for(const [response,code] of [
  [{stopReason:'stop',content:[{type:'text',text:'not JSON'}]},'SUPERLCM_PI_INVALID_SUMMARY'],
  [{stopReason:'length',content:[]},'SUPERLCM_PI_PREFIX_CAPACITY'],
 ]){
  const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,o){o.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]});return {result:async()=>response}}}}
  await assert.rejects(summarizePiFork(ctx,snapshot,capture,{stage:async()=>({})}),error=>error.code===code)
 }
})

test('Pi preserves an explicit upstream non-replayable refusal instead of treating it as ordinary 429',async()=>{
 const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,o){o.onPayload({...payload,messages:[...payload.messages,{role:'user',content:'directive'}]});return {result:async()=>({stopReason:'error',content:[],errorMessage:'API error (429): {"code":"upstream_reset_replay_refused"}'})}}}}
 await assert.rejects(summarizePiFork(ctx,snapshot,capture,{stage:async()=>({})}),error=>error.code==='SUPERLCM_PI_REPLAY_REFUSED')
})

test('Pi marks unsupported provider request shapes as non-retryable',async()=>{
 const unsupported={...capture,payload:{model:'fixture',unknown:[]}}
 await assert.rejects(summarizePiFork({model:capture.model},snapshot,unsupported,{stage:async()=>({})}),error=>error.code==='SUPERLCM_PI_UNSUPPORTED_REQUEST')
 const ctx={model:capture.model,modelRegistry:{streamSimple(_m,_c,options){return {result:async()=>{
  try{options.onPayload({model:'fixture',unknown:[]})}catch{}
  return {stopReason:'error',content:[],errorMessage:'provider wrapped the payload error'}
 }}}}}
 await assert.rejects(summarizePiFork(ctx,snapshot,capture,{stage:async()=>({})}),error=>error.code==='SUPERLCM_PI_UNSUPPORTED_REQUEST')
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

test('Pi includes fixed tools when deciding to send only the selected history prefix',async()=>{
 const old={...first,content:'x'.repeat(24000)},tail={role:'user',content:'y'.repeat(32000),timestamp:3}
 const native={...payload,messages:[payload.messages[0],{role:'user',content:old.content},payload.messages[2],{role:'user',content:tail.content}],tools:[{description:'x'.repeat(36000)}]}
 const captured={...capture,model:{...capture.model,contextWindow:20000},messages:[messages[0],old,second,tail],payload:native}
 let wire
 const ctx={model:captured.model,modelRegistry:{streamSimple(_m,context,options){
  assert.equal(context.messages.length,4,'the recent tail must not be replayed to the summary branch')
  wire=options.onPayload({...native,messages:[...native.messages.slice(0,3),{role:'user',content:context.messages.at(-1).content}]})
  return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:[{index:0,summary:'# State\nInspection pending. Never deploy.'}]})}]})}
 }}}
 await summarizePiFork(ctx,{...snapshot,sourceMessages:[old,second],tokensBefore:8000},captured,{stage:async()=>({})})
 assert.equal(wire.messages.length,4);assert.ok(!JSON.stringify(wire).includes(tail.content))
 assert.ok(estimatePiRequest(wire)+piOutputReserve(wire,captured.model)<20000)
})

test('Pi preserves output-capacity classification through provider-wrapped thinking failures',async()=>{
 const native={...payload,tools:[{description:'x'.repeat(120400)}],max_tokens:8192,thinking:{type:'enabled',budget_tokens:4096}}
 const captured={...capture,model:{...capture.model,api:'anthropic-messages',contextWindow:32000,maxTokens:8192},payload:native}
 let sends=0
 const ctx={model:captured.model,modelRegistry:{streamSimple(_m,_c,options){return {result:async()=>{
  try{options.onPayload({...native,messages:[...native.messages,{role:'user',content:'directive'}]});sends++}
  catch(error){return {stopReason:'error',errorMessage:error.message,content:[]}}
  return {stopReason:'stop',content:[]}
 }}}}}
 await assert.rejects(summarizePiFork(ctx,snapshot,captured,{stage:async()=>({})}),{code:'SUPERLCM_PI_PREFIX_CAPACITY'})
 assert.equal(sends,0)
 assert.throws(()=>limitPiOutput({...native,thinking:{type:'enabled',budget_tokens:100}},captured.model,10000),{code:'SUPERLCM_PI_INVALID_BUDGET'})
 assert.throws(()=>limitPiOutput({...native,max_tokens:1024},captured.model,10000),{code:'SUPERLCM_PI_INVALID_BUDGET'})
 assert.throws(()=>limitPiOutput({...native,max_tokens:1024},captured.model,600),{code:'SUPERLCM_PI_INVALID_BUDGET'})
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
 const cases=[{max_tokens:128000},{max_completion_tokens:128000},{max_output_tokens:128000},{maxOutputTokens:128000},{maxTokens:128000},{generationConfig:{maxOutputTokens:128000}},{config:{maxOutputTokens:128000}},{inferenceConfig:{maxTokens:128000}},{options:{maxTokens:128000}}]
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
 const nested={config:{maxOutputTokens:128000},generationConfig:{maxOutputTokens:1000}}
 assert.deepEqual(limitPiOutput(nested,model,90000),{config:{maxOutputTokens:90000},generationConfig:{maxOutputTokens:1000}})
 const absent={context:{messages:[]},options:{maxTokens:undefined}}
 assert.equal(piOutputReserve(absent,model),128000)
 assert.equal(limitPiOutput(absent,{...model,api:'pi-messages'},90000).options.maxTokens,90000)
 assert.equal(absent.options.maxTokens,undefined)
 assert.throws(()=>limitPiOutput({max_tokens:1000,max_completion_tokens:NaN},model,90000),/无效/)
 assert.ok(estimatePiRequest({image:{type:'input_image',data:'a'.repeat(100)}})>=8192)
})

test('Pi invalidates pre-compaction receipts inside kept entries when projection places compaction at index 0',()=>{
 const model={provider:'opencodex',id:'gpt-6.1-terra--fast',api:'openai-responses',contextWindow:500000,maxTokens:128000}
 const prePaid={role:'assistant',provider:model.provider,model:model.id,stopReason:'toolUse',
  usage:{input:1000,output:500,cacheRead:384715,cacheWrite:0,totalTokens:386215},content:[{type:'text',text:'pre-compaction'}]}
 const compactionEntry={id:'c1',type:'compaction',parentId:'t1',firstKeptEntryId:'u1',summary:'# Summary'}
 const projected=[
  {sourceEntry:compactionEntry,messages:[{role:'compactionSummary',summary:'# Summary'}]},
  {sourceEntry:{id:'u1',type:'message',parentId:'old'},messages:[{role:'user',content:'kept user'}]},
  {sourceEntry:{id:'a1',type:'message',parentId:'u1'},messages:[prePaid]},
  {sourceEntry:{id:'t1',type:'message',parentId:'a1'},messages:[{role:'toolResult',toolCallId:'c',content:[{type:'text',text:'kept tool'}]}]},
 ]
 const branch=[
  {id:'u1',type:'message',parentId:'old'},
  {id:'a1',type:'message',parentId:'u1'},
  {id:'t1',type:'message',parentId:'a1'},
  compactionEntry,
 ]
 assert.equal(measuredPiContextTokens(projected,model,null,branch),null,'pre-compaction receipt in kept tail must be invalidated with branch')
 assert.equal(measuredPiContextTokens(projected,model,null),null,'pre-compaction receipt in kept tail must be invalidated without branch')
 const withPostUser=[...projected,{sourceEntry:{id:'u2',type:'message',parentId:'c1'},messages:[{role:'user',content:'after compaction'}]}]
 assert.equal(measuredPiContextTokens(withPostUser,model,null,[...branch,{id:'u2',type:'message',parentId:'c1'}]),null,'new user turn before post-compaction reply still invalidates pre-compaction receipt')
 assert.equal(measuredPiContextTokens(withPostUser,model,null),null)
 const postPaid={role:'assistant',provider:model.provider,model:model.id,stopReason:'stop',
  usage:{input:5575,output:500,cacheRead:119500,cacheWrite:0,totalTokens:125575},content:[{type:'text',text:'post-compaction'}]}
 const withPostReply=[...withPostUser,{sourceEntry:{id:'a2',type:'message',parentId:'u2'},messages:[postPaid]}]
 assert.equal(measuredPiContextTokens(withPostReply,model,null,[...branch,{id:'u2',type:'message',parentId:'c1'},{id:'a2',type:'message',parentId:'u2'}]),125575)
 assert.equal(measuredPiContextTokens(withPostReply,model,null),125575)
})
