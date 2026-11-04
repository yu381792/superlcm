import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,existsSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {findCli} from '../src/runtime.js'
import {ClaudeStore} from '../src/store.js'
import {makePiSnapshot} from '../src/pi-snapshot.js'
import {piCompactedContext,summarizePiFork} from '../src/pi-fork.js'
import {stagePi,preparePi,savePiPolicy,readPiPolicy} from '../src/pi-compaction.js'
import {forkTreePlan,parseForkTree} from '../src/fork-summary.js'
let root=dirname(realpathSync(findCli('pi')))
while(!existsSync(join(root,'package.json'))){const parent=dirname(root);if(parent===root)throw Error('Pi SDK package not found');root=parent}
const sdk=await import(pathToFileURL(join(root,'dist/index.js')))

function fixture(t,{stableSummaries=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'pi-incremental-')),agent=join(dir,'agent'),sessions=join(agent,'sessions')
 mkdirSync(sessions,{recursive:true})
 const store=new ClaudeStore(join(dir,'archive'));t.after(()=>store.close())
 store.setIntegrationEnabled('pi',true);store.setHarnessSetting('pi','main-fork');store.setTuning({target_tokens:2000,fanout:4})
 savePiPolicy(store,{enabled:true,ratio:.8,keep:5000,summaryMode:'main-fork'})
 const manager=sdk.SessionManager.create(dir,sessions),env={...process.env,PI_CODING_AGENT_DIR:agent}
 const model={id:'scripted',provider:'fixture',api:'openai-completions',contextWindow:500000,maxTokens:50000},plans=[]
 const ctx={model,sessionManager:manager,getContextUsage:()=>({tokens:350000}),modelRegistry:{streamSimple(_model,context,options){
  const directive=context.messages.at(-1).content,plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{')))
  plans.push(plan)
  options.onPayload({model:'scripted',messages:context.messages,max_tokens:50000})
  return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({blocks:plan.filter(n=>n.frozenSummary===undefined).map(n=>({index:n.index,summary:'# State\nPreserve historical constraints and exact original evidence. '+(stableSummaries?'Stable evidence':n.kind==='overview'?'OVERVIEW_ONLY_'+plans.length:'Block '+plans.length+'-'+n.index)+'. Do not deploy.'}))})}],usage:{cacheRead:1000}})}
 }}}
 const append=round=>{
  manager.appendMessage({role:'user',content:('Inspect original evidence '+round+'. Never deploy. ').repeat(400),timestamp:Date.now()})
  manager.appendMessage({role:'assistant',content:[{type:'text',text:('Historical inspection '+round+' remains incomplete. ').repeat(100)}],timestamp:Date.now(),api:model.api,provider:model.provider,model:model.id,stopReason:'stop',usage:{input:349000,output:1000,cacheRead:0,cacheWrite:0,totalTokens:350000}})
  manager.appendMessage({role:'user',content:('CURRENT REQUEST '+round+' KEEP EXACT. ').repeat(1000),timestamp:Date.now()})
 }
 const generate=async({prepare=true,raw=false}={})=>{
  const snapshot=makePiSnapshot(ctx,readPiPolicy(store.dir),{compaction:{keepRecentTokens:5000}})
  assert.ok(snapshot)
  const before=readFileSync(manager.getSessionFile()),projection=manager.buildSessionProjection().messages
  const messages=raw?projection:sdk.convertToLlm(projection),capture={model,messages,payload:{model:'scripted',messages:sdk.convertToLlm(messages),max_tokens:50000}}
  let staged
  const forkSummary=await summarizePiFork(ctx,snapshot,capture,{stage:async()=>staged=stagePi(store,snapshot,{env})})
  const input={...snapshot,forkSummary,forkRevision:staged.revision}
  const prepared=prepare?await preparePi(store,input,{env}):null
  return {snapshot,forkSummary,prepared,before,input}
 }
 return {store,manager,ctx,env,plans,append,generate}
}

test('Pi reuses immutable blocks and merges across 24 native compactions without an overview tower',async t=>{
 const f=fixture(t),known=new Map();let merges=0,maxLevel=0,priorOverview
 for(let round=0;round<24;round++){
  f.append(round)
  const {prepared,before}=await f.generate(),c=prepared.compaction,plan=f.plans.at(-1)
  for(const n of plan.filter(n=>n.frozenSummary!==undefined)){
   if(known.has(n.archiveId))assert.equal(n.frozenSummary,known.get(n.archiveId))
   assert.notEqual(n.kind,'overview')
  }
  for(const n of c.details.summaryTree){
   const old=known.get(n.archiveId);if(old!==undefined)assert.equal(old,n.summary)
   known.set(n.archiveId,n.summary)
   if(n.kind==='condensed'&&n.children.some(i=>c.details.summaryTree[i].frozenSummary!==undefined))merges++
   if(n.kind!=='overview')maxLevel=Math.max(maxLevel,n.semanticLevel)
  }
  if(priorOverview)assert.ok(f.store.find(priorOverview,{session:c.details.session}).summaries.length,'old overview remains searchable')
  if(c.details.summaryRootKind==='overview')priorOverview='OVERVIEW_ONLY_'+(round+1)
  const tail=f.manager.buildSessionProjection().entries.filter(e=>e.sourceEntry.id===c.firstKeptEntryId).flatMap(e=>e.messages)
  f.manager.appendCompaction(c.summary,c.firstKeptEntryId,c.tokensBefore,c.details,true)
  assert.ok(readFileSync(f.manager.getSessionFile()).subarray(0,before.length).equals(before))
  for(const m of tail)assert.ok(f.manager.buildSessionProjection().messages.includes(m)||f.manager.buildSessionProjection().messages.some(n=>JSON.stringify(n)===JSON.stringify(m)))
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM dsh_shared_nodes WHERE session=? AND visible=3').get(c.details.session).n,c.details.summaryRootKind==='overview'?1:0)
 }
 assert.ok(merges>8,'actual cross-round parents were generated')
 assert.ok(maxLevel<5,'granularity grows with block count rather than compaction count')
})

test('Pi re-compacts a live raw projection containing an earlier native compaction',async t=>{
 const f=fixture(t);f.append(0)
 const first=await f.generate(),c=first.prepared.compaction
 f.manager.appendCompaction(c.summary,c.firstKeptEntryId,c.tokensBefore,c.details,true)
 f.append(1)
 const {snapshot,prepared,before}=await f.generate({raw:true}),raw=f.manager.buildSessionProjection().messages
 assert.equal(raw.find(m=>m.role!=='system').role,'compactionSummary')
 const replaced=await piCompactedContext(snapshot,prepared.compaction,raw)
 assert.ok(replaced.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('CURRENT REQUEST 1 KEEP EXACT')))
 const changed=structuredClone(raw);changed.find(m=>m.role==='compactionSummary').summary+=' changed'
 await assert.rejects(()=>piCompactedContext(snapshot,prepared.compaction,changed),/原文不一致/)
 assert.ok(readFileSync(f.manager.getSessionFile()).equals(before))
})

test('Pi incremental summary excludes hidden shell entries while covering visible shell evidence',async t=>{
 const f=fixture(t)
 f.manager.appendMessage({role:'user',content:'Inspect history and never deploy. '.repeat(400),timestamp:1})
 const visible=f.manager.appendMessage({role:'bashExecution',command:'visible check',output:'FAILED: disk full',exitCode:1,cancelled:false,truncated:false,timestamp:2})
 const unknown=f.manager.appendMessage({role:'unknownExtension',content:'Ignored by Pi conversion',timestamp:2})
 const hidden=f.manager.appendMessage({role:'bashExecution',command:'PRIVATE COMMAND',output:'PRIVATE OUTPUT',exitCode:0,cancelled:false,truncated:false,excludeFromContext:true,timestamp:3})
 f.manager.appendMessage({role:'user',content:'CURRENT REQUEST KEEP EXACT. '.repeat(1000),timestamp:4})
 const {snapshot,forkSummary,prepared,before}=await f.generate()
 assert.ok(snapshot.sourceEntryIds.includes(visible))
 assert.ok(!snapshot.sourceEntryIds.includes(hidden))
 assert.ok(!snapshot.sourceEntryIds.includes(unknown))
 assert.match(snapshot.source,/visible check/)
 assert.doesNotMatch(snapshot.source,/PRIVATE COMMAND|PRIVATE OUTPUT/)
 assert.ok(forkSummary.blocks.some(b=>b.entryIds.includes(visible)))
 assert.ok(forkSummary.blocks.every(b=>!b.entryIds.includes(hidden)))
 assert.ok(prepared.compaction)
 assert.ok(readFileSync(f.manager.getSessionFile()).equals(before))
})

test('Pi refuses a missing new block even when the reduced tree is structurally valid',async t=>{
 const f=fixture(t);f.append(0)
 const {input,before}=await f.generate({prepare:false}),fork=input.forkSummary
 assert.ok(fork.blocks.length>1)
 fork.blocks=fork.blocks.slice(1).map((n,index)=>({...n,index}))
 const plan=forkTreePlan(fork.blocks,4,{incremental:true})
 fork.tree=parseForkTree(JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# State\nKeep exact original constraints. Never deploy.'}))}),fork.blocks,undefined,fork.treeOptions)
 await assert.rejects(()=>preparePi(f.store,input,{env:f.env}),/原文覆盖不完整/)
 assert.ok(readFileSync(f.manager.getSessionFile()).equals(before))
})

test('Pi rejects changed frozen summaries and incomplete frozen frontiers without replacing native history',async t=>{
 const f=fixture(t);f.append(0)
 const first=await f.generate(),c=first.prepared.compaction
 f.manager.appendCompaction(c.summary,c.firstKeptEntryId,c.tokensBefore,c.details,true)
 f.append(1)
 const {input,before}=await f.generate({prepare:false})
 const frozen=input.forkSummary.blocks.find(b=>b.frozenEntryId)
 assert.ok(frozen)
 const changed=structuredClone(input),block=changed.forkSummary.blocks.find(b=>b.frozenEntryId)
 block.summary=block.frozenSummary='# State\nChanged immutable constraints.'
 await assert.rejects(()=>preparePi(f.store,changed,{env:f.env}),/旧摘要分块已变化/)
 const omitted=structuredClone(input),fork=omitted.forkSummary
 fork.blocks=fork.blocks.filter(b=>b.archiveId!==frozen.archiveId).map((n,index)=>({...n,index}))
 const plan=forkTreePlan(fork.blocks,4,{incremental:true})
 fork.tree=parseForkTree(JSON.stringify({blocks:plan.filter(n=>n.frozenSummary===undefined).map(n=>({index:n.index,summary:'# State\nPreserve original constraints. Never deploy.'}))}),fork.blocks,undefined,fork.treeOptions)
 await assert.rejects(()=>preparePi(f.store,omitted,{env:f.env}),/旧摘要分块覆盖不完整/)
 assert.ok(readFileSync(f.manager.getSessionFile()).equals(before))
})

test('Pi retains an unverifiable legacy checkpoint once as an immutable historical block',async t=>{
 const f=fixture(t);f.append(0)
 const initial=f.manager.buildSessionProjection().entries.filter(e=>e.messages.some(m=>m.role==='user')).at(-1).sourceEntry.id
 const legacy='# Legacy state\nKeep all earlier constraints and consult original evidence. Never deploy.'
 f.manager.appendCompaction(legacy,initial,350000,{superlcm:true},true)
 f.append(1)
 const first=await f.generate(),snapshot=first.forkSummary.blocks.find(b=>b.kind==='snapshot')
 assert.ok(snapshot);assert.equal(snapshot.frozenSummary,legacy)
 const c=first.prepared.compaction
 f.manager.appendCompaction(c.summary,c.firstKeptEntryId,c.tokensBefore,c.details,true)
 f.append(2)
 const second=await f.generate(),session=second.prepared.compaction.details.session
 assert.equal(f.store.node(session,snapshot.archiveId).summary,legacy)
 assert.deepEqual(f.store.db.prepare('SELECT id FROM dsh_shared_nodes WHERE session=? AND visible=5').all(session).map(r=>r.id),[snapshot.archiveId],'the same historical snapshot survives as a leaf or merged ancestor without being wrapped again')
})
test('Pi malformed cached tree metadata falls back to the exact native checkpoint instead of retrying bad metadata forever',async t=>{
 const f=fixture(t);f.append(0)
 const first=await f.generate(),c=first.prepared.compaction
 f.manager.appendCompaction(c.summary,c.firstKeptEntryId,c.tokensBefore,c.details,true)
 f.store.db.prepare('UPDATE nodes SET children=? WHERE session=? AND id=?').run('broken JSON',c.details.session,c.details.summaryRootId)
 f.append(1)
 const second=await f.generate(),snapshot=second.forkSummary.blocks.find(b=>b.kind==='snapshot')
 assert.ok(snapshot);assert.equal(snapshot.frozenSummary,c.summary)
 assert.equal(snapshot.sourceRecords.length,1,'fallback certifies only the checkpoint it actually sees')
})
test('Pi identical summary wording cannot reuse a different source cut after granularity changes',async t=>{
 const f=fixture(t,{stableSummaries:true});f.append(0)
 const first=await f.generate(),old=first.prepared.compaction.details.summaryTree[0]
 f.store.setTuning({target_tokens:10000,fanout:4})
 const second=await f.generate(),current=second.prepared.compaction.details.summaryTree[0],session=second.prepared.compaction.details.session
 assert.equal(first.forkSummary.sourceDigest,second.forkSummary.sourceDigest)
 assert.equal(old.summary,current.summary);assert.notEqual(old.archiveId,current.archiveId)
 assert.notEqual(f.store.node(session,old.archiveId).last,f.store.node(session,current.archiveId).last)
})
