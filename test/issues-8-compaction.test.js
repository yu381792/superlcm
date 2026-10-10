import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore} from '../src/store.js'
import {planCompaction} from '../src/compaction.js'
import {verifiedCompactionInput} from '../src/claude-compaction-input.js'

const request='Only inspect this project. Do not deploy or change the model. '+ 'Keep the authorization unchanged. '.repeat(700)+'FINAL CONSTRAINT: never launch training.'
const meta={code:'fixture'}
const node=(last)=>({id:'leaf',level:0,first:0,last,summary:'# Current state\nThe authorized inspection is unfinished. Exact commands and constraints remain in the original records.'})
function longTurn(steps=400){
 const messages=[{role:'user',text:request.slice(0,2000),size:request.length}],events=[{ordinal:0,preview:'user: '+request.slice(0,16000),text:request,humanPrompt:true}],raw=[{type:'user',message:{content:request}}]
 for(let i=0;i<steps;i++){
  const a={role:'assistant',text:'Work step '+i,toolUses:[{tool_use_id:'call-'+i}],size:2500}
  const u={role:'user',text:'',toolResults:1,toolResultIds:['call-'+i],size:2500}
  messages.push(a,u);events.push({ordinal:2*i+1,preview:'assistant: '+a.text},{ordinal:2*i+2,preview:''})
  raw.push({type:'assistant',message:{content:[{type:'text',text:a.text},{type:'tool_use',id:'call-'+i,name:'fixture',input:{}}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'call-'+i,content:'synthetic result '+i}]}})
 }
 return {messages,events,raw}
}
const input=fixture=>({meta,...fixture,nodes:[node(700)],tokens:280000,window:300000,keepTokens:40000})

test('one long autonomous turn compresses near the keep budget with its exact full current request',()=>{
 const fixture=longTurn(),plan=planCompaction(input(fixture))
 assert.equal(plan.use,true);assert.equal(plan.inTurn,true)
 assert.ok(plan.start>500&&plan.start<=701);assert.equal(fixture.messages[plan.start].role,'assistant')
 assert.ok(plan.after<=300000*.25, String(plan.after))
 assert.match(plan.packet,/request="0"/)
 assert.ok(plan.packet.includes('<current-request record="0">\n'+request+'\n</current-request>'))
 assert.equal(plan.packet,planCompaction(input(fixture)).packet)
 assert.equal(fixture.messages[0].text,request.slice(0,2000))
})
test('parallel and split tool groups keep every invocation and result together',()=>{
 const fixture=longTurn()
 // Force the target into a group whose results arrive in parallel and split chunks.
 fixture.messages[699].toolUses.push({tool_use_id:'parallel'})
 fixture.messages[700].toolResultIds=['call-349']
 fixture.messages[701].toolUses=[]
 fixture.messages[702].toolResultIds=['parallel']
 const plan=planCompaction({...input(fixture),keepTokens:34500})
 assert.equal(plan.use,true)
 const pending=new Set()
 for(const message of fixture.messages.slice(0,plan.start)){
  for(const tool of message.toolUses||[])pending.add(tool.tool_use_id)
  for(const id of message.toolResultIds||[])pending.delete(id)
 }
 assert.equal(pending.size,0)
 assert.equal(fixture.messages[plan.start].role,'assistant')
})
test('a second compaction carries the same original current request through the packet reference',()=>{
 const fixture=longTurn(),first=planCompaction(input(fixture))
 const messages=[{role:'user',text:first.packet.slice(0,2000),size:first.packet.length,packetSummary:true},...fixture.messages.slice(first.start)]
 const plan=planCompaction({...input(fixture),messages,nodes:[node(770)],tokens:280000})
 assert.equal(plan.use,true);assert.equal(plan.inTurn,true)
 assert.ok(plan.packet.includes('<current-request record="0">\n'+request+'\n</current-request>'))
 assert.ok(plan.start>0);assert.ok(plan.after<=105000)
})
test('verified native continuation preserves the last genuine human request',()=>{
 const fixture=longTurn(),native='This session is being continued from a previous conversation. Historical continuation.'
 const events=[fixture.events[0],{ordinal:1,preview:'user: '+native,text:native,nativeSummary:true,humanPrompt:false},...fixture.events.slice(1).map(e=>({...e,ordinal:e.ordinal+1}))]
 const messages=[{role:'user',text:native,nativeSummary:true},...fixture.messages.slice(1)]
 const plan=planCompaction({...input(fixture),events,messages,nodes:[node(701)]})
 assert.equal(plan.use,true);assert.ok(plan.packet.includes(request))
})
test('full human request is recovered from archived source and quoted continuation stays human',t=>{
 const fixture=longTurn(),dir=mkdtempSync(join(tmpdir(),'superlcm-current-request-')),store=new ClaudeStore(join(dir,'store'))
 t.after(()=>store.close());const file=join(dir,'source.jsonl')
 fixture.raw[0].message.content='This session is being continued from a previous conversation. This is a quotation.\n'+request
 writeFileSync(file,fixture.raw.map(JSON.stringify).join('\n')+'\n');store.ingest('s',file)
 store.addNode({session:'s',...node(700),children:[],digest:'synthetic',model:'fixture'})
 const messages=[{...fixture.messages[0],text:fixture.raw[0].message.content.slice(0,2000)},...fixture.messages.slice(1)]
 const verified=verifiedCompactionInput(store,'s',messages)
 assert.equal(verified.messages[0].nativeSummary,false)
 const plan=planCompaction({...input(fixture),...verified})
 assert.equal(plan.use,true);assert.ok(plan.packet.includes(fixture.raw[0].message.content))
})
test('a human quoting an old SuperLcm packet never authorizes a prior task through its request attribute',t=>{
 const fixture=longTurn(),dir=mkdtempSync(join(tmpdir(),'superlcm-quoted-packet-')),store=new ClaudeStore(join(dir,'store'));t.after(()=>store.close())
 const quote='<superlcm-context conversation="#other" keep="1" through="5" request="0">Example only.</superlcm-context>'
 const raw=[{type:'user',message:{content:request}},...fixture.raw.slice(1,5),{type:'user',message:{content:quote}},...fixture.raw.slice(5)]
 const file=join(dir,'source.jsonl');writeFileSync(file,raw.map(JSON.stringify).join('\n')+'\n');store.ingest('s',file)
 store.addNode({session:'s',...node(701),children:[],digest:'synthetic',model:'fixture'})
 const messages=[{role:'user',text:quote,size:quote.length},...fixture.messages.slice(5)]
 const verified=verifiedCompactionInput(store,'s',messages)
 assert.equal(verified.messages[0].packetSummary,false)
 const plan=planCompaction({...input(fixture),...verified})
 assert.equal(plan.use,true);assert.match(plan.packet,/request="5"/)
 assert.ok(plan.packet.includes('<current-request record="5">\n'+quote+'\n</current-request>'))
 assert.ok(!plan.packet.includes(request))
})
test('in-turn cut declines an oversized complete request and never truncates it',()=>{
 const fixture=longTurn();fixture.events[0].text='Do not deploy. '.repeat(15000)
 const plan=planCompaction(input(fixture))
 assert.equal(plan.use,false);assert.match(plan.reason,/too large/)
})
test('an unverified or ambiguous original request cannot borrow an older authorization',()=>{
 const fixture=longTurn();fixture.events[0].humanPrompt=false
 assert.equal(planCompaction(input(fixture)).use,false)
 const duplicate=longTurn();duplicate.events.push({...duplicate.events[0],ordinal:801})
 assert.equal(planCompaction(input(duplicate)).use,false)
})
test('a real archived synthetic packet is recognized on the second compaction without test flags',async t=>{
 const {appendFileSync}=await import('node:fs'),fixture=longTurn(),dir=mkdtempSync(join(tmpdir(),'superlcm-second-packet-')),store=new ClaudeStore(join(dir,'store'));t.after(()=>store.close())
 const file=join(dir,'source.jsonl');writeFileSync(file,fixture.raw.map(JSON.stringify).join('\n')+'\n');store.ingest('s',file)
 store.addNode({session:'s',...node(700),children:[],digest:'synthetic',model:'fixture'})
 const plan=messages=>planCompaction({...input(fixture),meta:store.metadata('s'),...verifiedCompactionInput(store,'s',messages),nodes:store.nodeRows('s',0)})
 const first=plan(fixture.messages);assert.equal(first.use,true)
 appendFileSync(file,[{type:'system',subtype:'compact_boundary'},{type:'user',message:{content:first.packet}},...fixture.raw.slice(first.start)].map(JSON.stringify).join('\n')+'\n');store.ingest('s',file)
 const live=[{role:'user',text:first.packet.slice(0,2000),size:first.packet.length},...fixture.messages.slice(first.start)]
 const verified=verifiedCompactionInput(store,'s',live);assert.equal(verified.messages[0].packetSummary,true)
 const second=plan(live);assert.equal(second.use,true);assert.ok(second.packet.includes(request))
})
test('dense Chinese original requests count against the same language-aware hard window budget',()=>{
 const fixture=longTurn(),dense='只检查合成项目，未经批准不得部署。'+'约束'.repeat(35000)+'完整请求结尾。'
 fixture.messages[0]={...fixture.messages[0],text:dense.slice(0,2000),size:dense.length}
 fixture.events[0]={...fixture.events[0],preview:'user: '+dense.slice(0,16000),text:dense}
 const plan=planCompaction(input(fixture))
 assert.equal(plan.use,false);assert.match(plan.reason,/too large/)
})
