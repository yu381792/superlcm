import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore} from '../src/store.js'
import {summaryWork} from '../src/summarize.js'
import {coveredThrough} from '../src/compaction.js'
import {claudeCompactionNodes} from '../src/claude-checkpoints.js'

// A transcript shaped like current Claude Code: dialogue interleaved with bookkeeping records and injected
// attachments, plus one tool output far longer than a summary piece.
function fixture(t,{hidden=false}={}){
  const root=mkdtempSync(join(tmpdir(),'slcm-fork-coverage-')),file=join(root,'history.jsonl'),s=new ClaudeStore(join(root,'store'));t.after(()=>s.close())
  const rows=[
    {type:'user',message:{role:'user',content:'Synthetic request'}},
    ...(hidden?[{type:'future_record',content:'SYNTHETIC_HIDDEN_CONSTRAINT'}]:[]),
    {type:'bridge-session',sessionId:'x'},{type:'agent-name',name:'synthetic'},{type:'atis-latch',state:1},
    {type:'attachment',attachment:{type:'hook_additional_context',content:['synthetic hook note']}},
    {type:'attachment',attachment:{type:'deferred_tools_delta',added:['Synthetic']}},
    {type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'t1',name:'Read',input:{file:'a'}}]}},
    {type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'t1',content:'x'.repeat(400000)}]}},
    {type:'assistant',message:{role:'assistant',content:'Synthetic answer'}},
    ...Array.from({length:40},(_,i)=>({type:i%2?'assistant':'user',message:{role:i%2?'assistant':'user',content:'Synthetic follow-up '+i}}))]
  writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');s.ingest('s',file)
  s.setMetadata('s',{harness:'claude-code',externalId:'synthetic'})
  return s
}
test('a prompt typed during a turn is part of the summary source',t=>{
  const root=mkdtempSync(join(tmpdir(),'slcm-fork-queued-')),file=join(root,'history.jsonl'),s=new ClaudeStore(join(root,'store'));t.after(()=>s.close())
  const rows=[{type:'user',message:{role:'user',content:'Synthetic request'}},
    {type:'attachment',attachment:{type:'queued_command',commandMode:'prompt',prompt:'SYNTHETIC_MIDTURN_CONSTRAINT'}},
    {type:'attachment',attachment:{type:'total_tokens_reminder',tokens:1}},
    ...Array.from({length:12},(_,i)=>({type:i%2?'user':'assistant',message:{role:i%2?'user':'assistant',content:'Synthetic '+i}}))]
  writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');s.ingest('s',file);s.setMetadata('s',{harness:'claude-code',externalId:'synthetic'})
  const w=summaryWork(s,'s',{batchSize:6})
  assert.equal(w.reducedSources,false);assert.match(w.content,/SYNTHETIC_MIDTURN_CONSTRAINT/)
})
const save=(s,w)=>s.addNode({session:'s',id:w.batch_id,level:w.level,first:w.first,last:w.last,children:w.children,summary:'# History\nSynthetic summary.',digest:w.digest,model:'synthetic',sourceComplete:!w.reducedSources})

test('Claude Code bookkeeping records and a long tool output do not stop a summary from covering its source',t=>{
  const s=fixture(t),w=summaryWork(s,'s',{batchSize:8})
  assert.ok(w);assert.equal(w.reducedSources,false)
  save(s,w)
  assert.ok(coveredThrough(claudeCompactionNodes(s,'s'))>=w.last)
})

test('an unknown record with content still blocks coverage',t=>{
  const s=fixture(t,{hidden:true}),w=summaryWork(s,'s',{batchSize:8})
  assert.equal(w.reducedSources,true)
})

test('a summary written before quality tracking is checked once against the archive and can cover again',t=>{
  const s=fixture(t),w=summaryWork(s,'s',{batchSize:8})
  save(s,w)
  // What an older fork release left behind: the node, without any quality or coverage rows.
  for(const table of ['summary_node_quality','claude_node_coverage_v3','claude_node_coverage_v4','claude_node_recert'])s.db.prepare(`DELETE FROM ${table} WHERE session='s'`).run()
  assert.equal(coveredThrough(claudeCompactionNodes(s,'s')),-1)
  summaryWork(s,'s',{batchSize:8})
  assert.ok(coveredThrough(claudeCompactionNodes(s,'s'))>=w.last)
})

// Live verification: what Claude Code's context holds versus what its transcript wrote.
import {verifiedActiveMessages} from '../src/claude-rescue-source.js'
function transcript(t,rows){
  const root=mkdtempSync(join(tmpdir(),'slcm-fork-live-')),file=join(root,'history.jsonl'),s=new ClaudeStore(join(root,'store'));t.after(()=>s.close())
  writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');s.ingest('s',file);s.setMetadata('s',{harness:'claude-code',externalId:'synthetic'})
  return s
}
const call=(id,uuid,msg='m1')=>({type:'assistant',uuid,message:{id:msg,role:'assistant',content:[{type:'tool_use',id,name:'Bash',input:{command:'echo '+id}}]}})
const result=(id,uuid)=>({type:'user',uuid,message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content:[{type:'text',text:'out '+id}]}]},toolUseResult:{stdout:'out '+id,stderr:'',interrupted:false}})
// The module's view: tool results carry the text and, in `result`, the raw toolUseResult.
const liveCall=id=>({role:'assistant',text:'',toolUses:[{id,name:'Bash',input:{command:'echo '+id}}]})
const liveResult=id=>({role:'user',text:'',toolResults:[{tool_use_id:id,text:'out '+id,isError:false,result:{stdout:'out '+id,stderr:'',interrupted:false}}]})
const prompt=(text,uuid)=>({type:'user',uuid,origin:{kind:'human'},message:{role:'user',content:text}})

test('parallel tool calls verify whether the context groups them or not',t=>{
  const s=transcript(t,[prompt('Synthetic task','u1'),call('a','c1'),result('a','r1'),call('b','c2'),result('b','r2'),{type:'assistant',uuid:'d',message:{id:'m2',role:'assistant',content:[{type:'text',text:'Done'}]}}])
  const opening={role:'user',text:'Synthetic task'},done={role:'assistant',text:'Done'}
  assert.ok(verifiedActiveMessages(s,'s',[opening,liveCall('a'),liveCall('b'),liveResult('a'),liveResult('b'),done]))
  assert.ok(verifiedActiveMessages(s,'s',[opening,liveCall('a'),liveResult('a'),liveCall('b'),liveResult('b'),done]))
  // A different output is still refused.
  const changed=liveResult('b');changed.toolResults[0].text='tampered'
  assert.equal(verifiedActiveMessages(s,'s',[opening,liveCall('a'),liveCall('b'),liveResult('a'),changed,done]),null)
})

test('after a native compaction the preserved messages verify after the summary',t=>{
  const s=transcript(t,[prompt('Synthetic task','u1'),call('a','c1'),result('a','r1'),
    {type:'system',subtype:'compact_boundary',uuid:'b1',compactMetadata:{trigger:'auto',preservedSegment:{headUuid:'c1',tailUuid:'r1',anchorUuid:'sum'}}},
    {type:'user',uuid:'sum',isCompactSummary:true,message:{role:'user',content:'This session is being continued from a previous conversation. Synthetic summary.'}},
    prompt('Synthetic next','u2')])
  assert.ok(verifiedActiveMessages(s,'s',[{role:'user',text:'This session is being continued from a previous conversation. Synthetic summary.'},liveCall('a'),liveResult('a'),{role:'user',text:'Synthetic next'}]))
})

import {hasUnrepresentedContent} from '../src/source-completeness.js'
import {bodies} from '../src/claude-live-messages.js'
import {claudeCompactAt} from '../src/takeover.js'
import {coldCompactionDue,endCompactionDue} from '../src/summary-background.js'
import {buildHierarchy} from '../src/summarize.js'

test('long Claude tool output reaches the writer without an omitted middle',t=>{
  const s=fixture(t),w=summaryWork(s,'s',{batchSize:8})
  assert.ok(w.content.includes('x'.repeat(400000)))
  assert.doesNotMatch(w.content,/middle omitted|characters omitted/)
})

test('images and unknown tool blocks still cannot certify a text summary',t=>{
  const s=transcript(t,[prompt('Describe the image','u1'),{type:'user',message:{content:[{type:'image',source:{type:'base64',data:'synthetic'}}]}},...Array.from({length:10},(_,i)=>prompt('Follow up '+i,'u'+i))])
  const w=summaryWork(s,'s',{batchSize:6})
  assert.equal(w.reducedSources,true)
  assert.equal(hasUnrepresentedContent(JSON.stringify({type:'user',message:{content:[{type:'tool_result',content:[{type:'image',source:{data:'synthetic'}}]}]}}),'jsonl',{strictRecords:true}),true)
  const mixed=[{type:'text',text:'output'},{type:'future_block',value:'constraint'}]
  assert.deepEqual(bodies({toolResults:[{id:'r',content:mixed}]}).at(0).value,mixed)
})

test('Claude threshold honors environment, settings, and model capacity',t=>{
  const root=mkdtempSync(join(tmpdir(),'slcm-threshold-'))
  writeFileSync(join(root,'settings.json'),JSON.stringify({autoCompactWindow:300000}))
  const env={CLAUDE_CONFIG_DIR:root}
  assert.equal(claudeCompactAt({ratio:.8},1000000,env),224000)
  assert.equal(claudeCompactAt({ratio:.8},200000,env),144000)
  assert.equal(claudeCompactAt({ratio:.8},1000000,{...env,CLAUDE_CODE_AUTO_COMPACT_WINDOW:'400000'}),304000)
  assert.equal(claudeCompactAt({window:150000},1000000,env),150000)
})

test('cold and turn-end compaction skip workers and small contexts',t=>{
  const s=transcript(t,[{type:'assistant',timestamp:new Date(Date.now()-7200000).toISOString(),message:{content:'Done',usage:{input_tokens:150000,output_tokens:100,cache_creation:{ephemeral_1h_input_tokens:150000}}}}])
  s.setTakeover({enabled:true,window:200000,ratio:null})
  assert.equal(coldCompactionDue(s,'s',{env:{},now:Date.now()}).compact,true)
  s.noteCacheTouch('s',Date.now())
  assert.equal(coldCompactionDue(s,'s',{env:{}}).none,'cache still warm')
  assert.equal(coldCompactionDue(s,'s',{env:{SUPERLCM_CLI_WORKER:'1'}}).none,'disabled')
  assert.equal(endCompactionDue(s,'s',{env:{},tokens:180000}).compact,true)
  assert.equal(endCompactionDue(s,'s',{env:{},tokens:40000}).none,'context small')
})

test('API fallback writes the same source and records the model actually used',async t=>{
  const s=transcript(t,Array.from({length:12},(_,i)=>prompt('Synthetic request '+i,'u'+i)))
  const seen=[]
  const fetchImpl=async(_url,options)=>{
    const body=JSON.parse(options.body);seen.push(body)
    return body.model==='limited'?new Response(JSON.stringify({error:{code:'rate_limit_exceeded'}}),{status:429}):new Response(JSON.stringify({choices:[{message:{content:'# History\nSynthetic requests remain recorded.'},finish_reason:'stop'}]}))
  }
  const r=await buildHierarchy(s,'s',{model:'limited',apiKey:'',apiProvider:'openai',apiURL:'http://127.0.0.1:1',fallbacks:[{model:'available',apiKey:'',apiProvider:'openai',apiURL:'http://127.0.0.1:2'}],fetchImpl,maxPieces:1})
  assert.equal(r.created,1)
  assert.deepEqual(seen.map(b=>b.model),['limited','available'])
  assert.deepEqual(seen[0].messages,seen[1].messages)
  assert.equal(s.nodeRows('s',0)[0].model,'available')
})

import {claimHostFork,settleHostFork} from '../src/main-fork.js'
for(const changed of [false,true])test('host fork settles only its own claim with unchanged transcript: '+changed,t=>{
  const s=transcript(t,Array.from({length:12},(_,i)=>prompt('Synthetic task '+i+' '+('long history '.repeat(10000)),'u'+i)))
  s.setGlobalSetting('main-fork')
  const claim=claimHostFork(s,'s',{env:{}})
  assert.ok(claim.claim_id)
  assert.equal(settleHostFork(s,'s',{...claim,claim_id:'wrong',text:'bad'},{env:{}}).saved,false)
  const plan=JSON.parse(s.db.prepare('SELECT plan FROM fork_summary_plans WHERE run_id=?').get(claim.run_id).plan)
  if(changed)writeFileSync(s.source('s').path,JSON.stringify(prompt('Changed source','new'))+'\n')
  const reply=settleHostFork(s,'s',{...claim,text:JSON.stringify({blocks:plan.tree.map(n=>({index:n.index,summary:'# History\nSynthetic task pending.'}))})},{env:{}})
  assert.equal(reply.saved,!changed)
  assert.equal(s.summarizing('s'),false)
})

import {cpSync,mkdirSync,readFileSync} from 'node:fs'
import {pathToFileURL,fileURLToPath} from 'node:url'
test('an older plugin cannot repoint the stable entry away from an installed newer copy',async t=>{
  const root=mkdtempSync(join(tmpdir(),'slcm-entry-')),versions=join(root,'plugins/cache/synthetic/superlcm'),home=join(root,'archive')
  for(const version of ['0.6.1','0.6.2']){
    const dir=join(versions,version);mkdirSync(dir,{recursive:true})
    cpSync(fileURLToPath(new URL('../src',import.meta.url)),join(dir,'src'),{recursive:true})
    cpSync(fileURLToPath(new URL('../dsh',import.meta.url)),join(dir,'dsh'),{recursive:true})
    writeFileSync(join(dir,'package.json'),'{"type":"module"}')
  }
  const before=process.env.SUPERLCM_HOME;process.env.SUPERLCM_HOME=home
  t.after(()=>{if(before===undefined)delete process.env.SUPERLCM_HOME;else process.env.SUPERLCM_HOME=before})
  const old=await import(pathToFileURL(join(versions,'0.6.1/src/plugin-entry.js')).href)
  const newer=await import(pathToFileURL(join(versions,'0.6.2/src/plugin-entry.js')).href)
  old.refreshPluginEntry();newer.refreshPluginEntry();old.refreshPluginEntry()
  assert.match(readFileSync(join(home,'superlcm.js'),'utf8'),/0\.6\.2\/src\/cli\.js/)
})

test('fallback lists are explicit, bounded, deduplicated and cleaned when a model is removed',t=>{
  const s=transcript(t,[prompt('Synthetic task','u1')])
  const one=s.saveApiModel({label:'One',provider:'openai',url:'http://127.0.0.1:1',model:'one'})
  const two=s.saveApiModel({label:'Two',provider:'openai',url:'http://127.0.0.1:2',model:'two'})
  s.setHarnessSetting('claude-code','api',null,null,null,one.id)
  assert.deepEqual(s.apiFallbacks('s'),[])
  s.setHarnessFallbacks('claude-code',[two.id,two.id,one.id])
  assert.deepEqual(s.harnessSetting('claude-code').api_fallbacks,[two.id])
  assert.throws(()=>s.setHarnessFallbacks('claude-code',Array(6).fill(two.id)))
  assert.equal(s.apiFallbacks('s')[0].model,'two')
  s.deleteApiModel(two.id)
  assert.deepEqual(s.harnessSetting('claude-code').api_fallbacks,[])
})
