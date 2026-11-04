import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {piProviderBoundary,piAuxiliaryRequest} from '../src/pi-provider-boundary.js'
import {clonePiPayload} from '../src/pi-request.js'

for(const cold of [false,true])test('installed Pi keeps late redaction on '+(cold?'cold recovery':'parallel foreground and summary'),()=>{
 const script=fileURLToPath(new URL('../scripts/verify-pi-compaction.mjs',import.meta.url))
 const result=execFileSync(process.execPath,[script,'--main-fork','--full-window','--late-redactor',...(cold?['--cold-input']:[])],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']})
 const receipt=result.trim().split('\n').map(line=>JSON.parse(line)).find(x=>x.lateRedactor)
 assert.ok(receipt);assert.equal(receipt.secretReachedProvider,false);assert.equal(receipt.originalsUnchanged,true)
 assert.equal(receipt.summaryRequests,1);assert.ok(receipt.foregroundRequests>0)
})

for(const flag of ['--oversized-native-payload','--oversized-native-output','api'])test('installed Pi final boundary: '+flag,()=>{
 const script=fileURLToPath(new URL('../scripts/verify-pi-compaction.mjs',import.meta.url))
 const result=execFileSync(process.execPath,[script,...(flag==='api'?[]:['--main-fork',flag])],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']})
 const receipt=JSON.parse(result.trim().split('\n').at(-1))
 assert.equal(receipt.ok,true);assert.equal(receipt.fullOriginalPreserved,true)
 if(flag==='--oversized-native-payload')assert.equal(receipt.mainCalls,0)
 else assert.equal(receipt.summaryModelCalls,1)
})

function fixture(onRequest){
 const wires=[]
 const original=async(_model,_context,options)=>{const payload=await options.onPayload({messages:[{role:'user',content:'PRIVATE_VALUE'}],max_tokens:4096});wires.push(payload);return payload}
 const provider={streamSimple:original},model={provider:'fixture',id:'fixture'}
 const ctx={model,sessionManager:{getSessionId:()=> 'main'},modelRegistry:{getProvider:()=>provider}}
 const boundary=piProviderBoundary(onRequest)
 return {boundary,provider,ctx,model,wires,original}
}

test('Pi boundary observes the completed payload chain and replays it for auxiliary content',async()=>{
 let captured,changes=0
 const f=fixture(async request=>{
  captured=request
  const background=await request.transformPayload({messages:[{role:'user',content:'PRIVATE_VALUE branch anchors'}],max_tokens:4096})
  assert.ok(!JSON.stringify(background).includes('PRIVATE_VALUE'))
  return request.payload
 })
 try{
  f.boundary.arm(f.ctx)
  await f.provider.streamSimple(f.model,{messages:[]},{sessionId:'main',headers:{'x-policy':'processed'},onPayload:async payload=>{
   changes++;await Promise.resolve();return JSON.parse(JSON.stringify(payload).replaceAll('PRIVATE_VALUE','[REDACTED]'))
  }})
  assert.equal(changes,2)
  assert.ok(JSON.stringify(captured.raw).includes('PRIVATE_VALUE'))
  assert.ok(!JSON.stringify(f.wires).includes('PRIVATE_VALUE'))
  assert.equal(captured.requestHeaders['x-policy'],'processed')
 }finally{f.boundary.close()}
 assert.equal(f.provider.streamSimple,f.original)
})

test('Pi auxiliary capture never consumes the foreground boundary or recursively runs its guard',async()=>{
 let calls=0
 const f=fixture(request=>{calls++;return request.payload})
 try{
  f.boundary.arm(f.ctx)
  const options={sessionId:'main',onPayload:value=>value}
  await piAuxiliaryRequest(()=>f.provider.streamSimple(f.model,{messages:[]},options))
  assert.equal(calls,0)
  await f.provider.streamSimple(f.model,{messages:[]},options)
  assert.equal(calls,1)
  await f.provider.streamSimple(f.model,{messages:[]},options)
  assert.equal(calls,1,'unarmed cache/auxiliary calls do not start background work')
 }finally{f.boundary.close()}
})

test('Pi final boundary errors are not swallowed by the extension runner',async()=>{
 const f=fixture(()=>{throw Error('final payload is unsafe')})
 try{
  f.boundary.arm(f.ctx)
  await assert.rejects(f.provider.streamSimple(f.model,{messages:[]},{sessionId:'main',onPayload:async value=>value}),/unsafe/)
  assert.equal(f.wires.length,0)
 }finally{f.boundary.close()}
})

test('Pi boundary cancellation after the handler chain blocks any final send',async()=>{
 let calls=0
 const controller=new AbortController(),f=fixture(request=>{calls++;return request.payload})
 try{
  f.boundary.arm(f.ctx)
  await assert.rejects(f.provider.streamSimple(f.model,{messages:[]},{sessionId:'main',signal:controller.signal,onPayload:async value=>{controller.abort(Error('cancelled'));return value}}),/cancelled/)
  assert.equal(calls,0);assert.equal(f.wires.length,0)
 }finally{f.boundary.close()}
})

test('Pi session switch during an asynchronous payload handler rejects the late capture',async()=>{
 let release,calls=0
 const gate=new Promise(resolve=>release=resolve),f=fixture(request=>{calls++;return request.payload})
 try{
  f.boundary.arm(f.ctx)
  const request=f.provider.streamSimple(f.model,{messages:[]},{sessionId:'main',onPayload:async value=>{await gate;return value}})
  f.boundary.disarm();release()
  await assert.rejects(request,/会话已切换/)
  assert.equal(calls,0);assert.equal(f.wires.length,0)
 }finally{release();f.boundary.close()}
})

test('Pi boundary does not overwrite a later provider wrapper on shutdown',async()=>{
 const f=fixture(request=>request.payload)
 f.boundary.arm(f.ctx)
 const ours=f.provider.streamSimple,later=(...args)=>ours(...args)
 f.provider.streamSimple=later
 f.boundary.close()
 assert.equal(f.provider.streamSimple,later)
 assert.ok(await later(f.model,{messages:[]},{sessionId:'main',onPayload:x=>x}))
})

test('Pi request cloning preserves a live Google signal without aliasing message edits',()=>{
 const controller=new AbortController(),original={contents:[{role:'user',parts:[{text:'original'}]}],config:{abortSignal:controller.signal,maxOutputTokens:1024}}
 const copy=clonePiPayload(original)
 assert.equal(copy.config.abortSignal,controller.signal)
 copy.contents[0].parts[0].text='changed'
 assert.equal(original.contents[0].parts[0].text,'original')
 controller.abort();assert.equal(copy.config.abortSignal.aborted,true)
})
