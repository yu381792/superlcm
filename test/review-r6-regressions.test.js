import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {appendFileSync,existsSync,mkdirSync,mkdtempSync,readdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore,importFile} from '../src/store.js'
import {planMainFork,generateMainFork} from '../src/main-fork.js'
import {coveredThrough} from '../src/compaction.js'
import {claudeCompactionNodes} from '../src/claude-checkpoints.js'
import {enqueueSummary} from '../src/summary-scheduler.js'
import {hasUnrepresentedContent} from '../src/source-completeness.js'

test('failed import and session collision clean their own staged copies',t=>{
 const root=mkdtempSync(join(tmpdir(),'slcm-import-failure-')),s=new ClaudeStore(join(root,'store'));t.after(()=>s.close())
 const first=join(root,'first.txt'),second=join(root,'second.txt');writeFileSync(first,'Synthetic first source');writeFileSync(second,'Synthetic other source')
 importFile(s,first,'same');assert.throws(()=>importFile(s,second,'same'),/already bound/)
 assert.equal(readdirSync(join(s.dir,'imports')).length,1);assert.match(s.exact('same',0),/first source/)
 s.deleteSession('same');s.db.exec("CREATE TRIGGER synthetic_index_failure BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
 assert.throws(()=>importFile(s,first,'same'),/synthetic failure/)
 assert.equal(s.isDeleted('same'),true);assert.equal(s.source('same'),undefined)
 assert.deepEqual(readdirSync(join(s.dir,'imports')),[]);assert.equal(s.db.prepare('SELECT count(*) n FROM import_staging').get().n,0)
})

test('cleanup protects a shared imported file and a live import stage',t=>{
 const root=mkdtempSync(join(tmpdir(),'slcm-import-shared-')),s=new ClaudeStore(join(root,'store'));t.after(()=>s.close())
 const first=join(root,'first.txt'),shared=join(root,'shared.txt');writeFileSync(first,'Synthetic first');writeFileSync(shared,'Synthetic shared')
 importFile(s,first,'one');importFile(s,shared,'two');const file=s.source('two').path
 assert.throws(()=>importFile(s,shared,'one'),/already bound/);assert.equal(existsSync(file),true)
 s.deleteSession('one');assert.match(s.exact('two',0),/Synthetic shared/)
 const staged=join(s.realDir,'imports','synthetic-stage.txt');writeFileSync(staged,'Synthetic pending')
 s.db.prepare('INSERT INTO import_staging VALUES(?,?,?,?)').run('live','pending',staged,process.pid)
 s.db.prepare('INSERT INTO deleted_session_files VALUES(?,?)').run('pending',staged)
 assert.equal(s.cleanupDeletedFiles('pending'),1);assert.ok(existsSync(staged))
 s.db.prepare('DELETE FROM import_staging WHERE token=?').run('live');assert.equal(s.cleanupDeletedFiles('pending'),0);assert.equal(existsSync(staged),false)
})

test('an abandoned import stage is cleaned after restart',t=>{
 const root=mkdtempSync(join(tmpdir(),'slcm-import-restart-')),home=join(root,'store');let s=new ClaudeStore(home)
 const folder=join(s.realDir,'imports'),file=join(folder,'synthetic-abandoned.txt');mkdirSync(folder,{recursive:true});writeFileSync(file,'Synthetic interrupted copy')
 s.db.prepare('INSERT INTO import_staging VALUES(?,?,?,?)').run('dead','interrupted',file,2147483647);s.close()
 s=new ClaudeStore(home);t.after(()=>s.close());assert.equal(existsSync(file),false)
 assert.equal(s.db.prepare('SELECT count(*) n FROM import_staging').get().n,0)
})

function claudeFixture(t,rows){
 const root=mkdtempSync(join(tmpdir(),'slcm-source-proof-')),file=join(root,'history.jsonl'),s=new ClaudeStore(join(root,'store'));t.after(()=>s.close())
 writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');s.ingest('s',file)
 s.setMetadata('s',{harness:'claude-code',externalId:'synthetic'});s.setGlobalSetting('main-fork')
 return {s,file}
}
const rows=()=>Array.from({length:6},(_,i)=>({type:i%2?'assistant':'user',message:{content:'Synthetic '+i+' '+(i===2?'DONT_UPLOAD':'original evidence')}}))
const answer=plan=>({model:'synthetic',text:JSON.stringify({blocks:plan.tree.map(n=>({index:n.index,summary:'# History\nThe synthetic task remains pending.'}))})})

test('older unverified Claude summaries remain searchable but cannot authorize replacement',t=>{
 const {s}=claudeFixture(t,rows())
 s.addNode({session:'s',id:'older',level:0,first:0,last:1,children:[],summary:'# Old\nSynthetic older summary.',digest:'old',model:'legacy',sourceComplete:true})
 s.db.prepare('DELETE FROM claude_node_coverage_v4 WHERE session=? AND id=?').run('s','older')
 assert.equal(s.nodeSourceIncomplete('s',s.node('s','older')),true)
 assert.match(s.outline('s','older').node.summary,/Synthetic older summary/)
 assert.equal(coveredThrough(claudeCompactionNodes(s,'s')),-1)
})

for(const when of ['before','during'])test('unindexed native compaction '+when+' the branch cannot certify old coverage',async t=>{
 const {s,file}=claudeFixture(t,rows());s.markCompaction('s',2)
 const plan=planMainFork(s,'s',{keepTokens:0,force:true,env:{}}),marker=JSON.stringify({type:'system',subtype:'compact_boundary'})+'\n';let calls=0
 if(when==='before')appendFileSync(file,marker)
 await assert.rejects(generateMainFork(s,'s',{env:{},explicit:true,queuedPlan:plan,summarize:async()=>{calls++;if(when==='during')appendFileSync(file,marker);return answer(plan)}}),/压缩标记尚未归档/)
 assert.equal(calls,when==='before'?0:1);assert.equal(coveredThrough(claudeCompactionNodes(s,'s')),-1)
})

for(const when of ['before','during'])test('host source rewritten '+when+' the branch cannot certify archived content',async t=>{
 const {s,file}=claudeFixture(t,rows()),plan=planMainFork(s,'s',{keepTokens:0,force:true,env:{}});let calls=0
 const edit=()=>writeFileSync(file,rows().map(row=>JSON.stringify(row).replace('DONT_UPLOAD','MUST_UPLOAD')).join('\n')+'\n')
 if(when==='before')edit()
 await assert.rejects(generateMainFork(s,'s',{env:{},explicit:true,queuedPlan:plan,summarize:async()=>{calls++;if(when==='during')edit();return answer(plan)}}),/转录来源已变化/)
 assert.equal(calls,when==='before'?0:1);assert.match(s.exact('s',2),/DONT_UPLOAD/)
 assert.equal(coveredThrough(claudeCompactionNodes(s,'s')),-1)
})

test('normal appended transcript entries do not invalidate a background branch',async t=>{
 const {s,file}=claudeFixture(t,rows()),plan=planMainFork(s,'s',{keepTokens:0,force:true,env:{}})
 const result=await generateMainFork(s,'s',{env:{},explicit:true,queuedPlan:plan,summarize:async()=>{appendFileSync(file,JSON.stringify({type:'user',message:{content:'Later normal request'}})+'\n');return answer(plan)}})
 assert.ok(result.created);assert.equal(coveredThrough(claudeCompactionNodes(s,'s')),5)
})

for(const group of ['record','tools'])test('Claude recovery uses real available capacity for a larger '+group,async t=>{
 const first=group==='record'?[{type:'user',message:{content:'x'.repeat(20000)}}]:[
  {type:'assistant',message:{content:[{type:'tool_use',id:'tool',name:'read',input:{text:'a'.repeat(8000)}}]}},
  {type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'b'.repeat(10000)}]}}]
 const usage={type:'assistant',context_window:500000,message:{content:'Synthetic response',usage:{input_tokens:1000,output_tokens:10}}}
 const {s}=claudeFixture(t,[...first,usage]);s.markCompaction('s')
 const plan=planMainFork(s,'s',{keepTokens:0,force:true,env:{}});assert.ok(plan)
 let prompt='';await generateMainFork(s,'s',{env:{},explicit:true,queuedPlan:plan,summarize:async(_h,_s,text)=>{prompt=text;return answer(plan)}})
 assert.ok(prompt.includes(group==='record'?'x'.repeat(20000):'b'.repeat(10000)));assert.ok(coveredThrough(claudeCompactionNodes(s,'s'))>=first.length-1)
})

test('manual Claude recovery reports when a complete group cannot fit',t=>{
 const usage={type:'assistant',context_window:500000,message:{content:'Synthetic response',usage:{input_tokens:499000,output_tokens:10}}}
 const {s}=claudeFixture(t,[{type:'user',message:{content:'Synthetic older request'}},usage]);s.markCompaction('s')
 assert.throws(()=>enqueueSummary(s,'s',{origin:'manual',env:{}}),/超过当前可用空间/)
})

test('unknown top-level payload is not certified as complete source',t=>{
 const hidden={type:'future_text_context',content:'SYNTHETIC_HIDDEN_CONSTRAINT'} // fork: attachments are harness-injected; an unknown record with content still blocks
 assert.equal(hasUnrepresentedContent(JSON.stringify(hidden),'jsonl',{strictRecords:true}),true)
 const {s}=claudeFixture(t,[{type:'user',message:{content:'Synthetic request'}},hidden,{type:'assistant',message:{content:'Synthetic answer'}}]);s.markCompaction('s')
 const plan=planMainFork(s,'s',{keepTokens:0,force:true,env:{}});assert.ok(plan);assert.equal(plan.originals.at(-1).ordinal,0)
})
