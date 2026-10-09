import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {zstdCompressSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {ClaudeStore} from '../src/store.js'
import {captureLegacyDshSource} from '../src/dsh-legacy.js'
import {captureDshPacket,projectDshEvent} from '../src/dsh.js'
import {readRawDshSession} from '../dsh/raw-session.js'
import {legacyDshSource} from '../src/dsh-evidence.js'
import {summaryWork} from '../src/summarize.js'
import {scheduleSummary} from '../src/summary-scheduler.js'
const physical={type:'session',version:0,id:'historical',createdAt:1,cwd:'/fixture',delegationDepth:0},header={version:4,id:'historical',createdAt:1,cwd:'/fixture',isSeeded:false,delegationDepth:0}
const event=(seq,text)=>({seq,time:seq+1,type:'user/message',surfaceOp:'append',data:{role:'user',content:[{type:'text',text}]}})
const rows=[event(0,'first'),event(1,'left'),event(1,'conflict'),event(5,'ahead'),event(2,'right')]
function fixture(t,events=rows){const dir=mkdtempSync(join(tmpdir(),'sl-full-history-')),path=join(dir,'session.jsonl.zstd'),bytes=Buffer.concat([zstdCompressSync(Buffer.from(JSON.stringify(physical)+'\n')),zstdCompressSync(Buffer.from(events.map(x=>JSON.stringify(x)).join('\n')+'\n'))]);writeFileSync(path,bytes)
 const store=new ClaudeStore(join(dir,'archive'));t.after(()=>store.close());return {store,dir,path,bytes,source:{path,compressed:true,sha256:createHash('sha256').update(bytes).digest('hex'),header}}
}
test('full shared archive retains all overlapping originals and explicit physical positions, with exact raw evidence and no summaries',async t=>{
 const f=fixture(t),r=await captureLegacyDshSource(f.store,f.source);assert.equal(r.records,5);assert.equal(r.sequenceMode,'physical-order');assert.equal(r.session,'dsh-historical')
 for(let i=0;i<5;i++){const actual=JSON.parse(f.store.exact(r.session,i));assert.deepEqual(actual.event,rows[i]);assert.deepEqual(actual.dsh_archive,{sequenceMode:'physical-order',ordinal:i,sourceRow:i+1,sourceSeq:rows[i].seq})}
 assert.equal(f.store.find('conflict').events.length,1);assert.equal(f.store.stats(r.session).records,5);assert.equal(f.store.outline(r.session).nodes.length,0)
 assert.equal(f.store.effectiveSetting(r.session).scope,'historical-originals');assert.equal(summaryWork(f.store,r.session),null);assert.equal(scheduleSummary(f.store,r.session,'api','test',{spawnProcess(){throw Error('paid call')}}),false)
 assert.deepEqual(Buffer.from(f.store.db.prepare('SELECT bytes FROM dsh_legacy_sources').get().bytes),f.bytes);assert.deepEqual(readFileSync(f.path),f.bytes)
 assert.equal(legacyDshSource(f.store.db,r.session).complete,1);assert.equal(f.store.metadata(r.session).historical_archive.sequence_mode,'physical-order');assert.equal((await captureLegacyDshSource(f.store,f.source)).added,0)
 assert.throws(()=>captureDshPacket(f.store,{header,records:[]}),/mix generations/)
})
test('a valid saved prefix survives header version and missing preset differences without mutating its originals',async t=>{
 const f=fixture(t);const r=captureDshPacket(f.store,{header:{...header,agentPreset:'standard'},records:[projectDshEvent(header.id,rows[0],'first')]});const old=f.store.exact(r.session,0)
 await captureLegacyDshSource(f.store,f.source);assert.equal(f.store.exact(r.session,0),old);assert.equal(f.store.stats(r.session).records,5)
})
test('mismatched existing prefix rejects recovery before source markers or new mirror bytes',async t=>{
 const f=fixture(t);captureDshPacket(f.store,{header,records:[projectDshEvent(header.id,event(0,'wrong'),'wrong')]});const file=f.store.source('dsh-historical').path,before=readFileSync(file)
 await assert.rejects(()=>captureLegacyDshSource(f.store,f.source),/Previously archived/);assert.equal(legacyDshSource(f.store.db,'dsh-historical'),undefined);assert.deepEqual(readFileSync(file),before)
})
test('changed source SHA, malformed late rows and current-format publication refuse historical fallback',async t=>{
 const f=fixture(t);await assert.rejects(()=>captureLegacyDshSource(f.store,{...f.source,sha256:'wrong'}),/changed while reading/);assert.equal(f.store.sources().length,0)
 const bad=fixture(t,[...rows,{type:'text-chunks',seq0:9,time0:1,data:{texts:['invalid packed row']}}]);await assert.rejects(()=>captureLegacyDshSource(bad.store,bad.source));assert.equal(bad.store.sources().length,0)
 const ctx={sessionPersistence:{open:async()=>{throw Object.assign(Error('corrupt'),{name:'SessionPersistenceCorruptionError'})},locate:()=>({kind:'jsonl',path:join(f.dir,'session.v4.jsonl.zstd')})},sessionQuery:{listSessions:async()=>[{header}]}}
 const raw=await readRawDshSession(ctx,header.id);assert.equal(raw.recovery.entries.length,5);writeFileSync(join(f.dir,'session.v4.jsonl.zstd'),f.bytes);await assert.rejects(()=>readRawDshSession(ctx,header.id),/当前会话文件已存在/)
})
test('sequential unsupported old formats use exact recall without native-summary reconstruction',async t=>{
 const f=fixture(t,[event(0,'first'),event(1,'second')]);const r=await captureLegacyDshSource(f.store,f.source);assert.equal(r.sequenceMode,'event-sequence');assert.deepEqual(JSON.parse(f.store.exact(r.session,1)).event,event(1,'second'));assert.equal(f.store.summaries(r.session).total,0)
})
test('the DSH worker transport invokes the same historical recovery and serves it to ordinary recall tools',async t=>{
 const f=fixture(t);const {ArchiveWorker}=await import('../dsh/worker-client.js');const worker=new ArchiveWorker({...process.env,SUPERLCM_HOME:f.store.dir});t.after(()=>worker.close())
 assert.equal((await worker.request({method:'capture-legacy',source:f.source})).records,5)
 const read=await worker.request({method:'call',name:'lcm_read',args:{conversation:'dsh-historical',from:2,to:2}});assert.match(JSON.stringify(read),/conflict/)
 assert.equal((await worker.request({method:'historical',session:'dsh-historical'})).complete,1)
})
test('large legacy events beyond the live DSH 4 MiB projection cap remain exact and readable within the shared 32 MiB bound',async t=>{
 const value=event(0,'x'.repeat(4*1024*1024+100));const f=fixture(t,[value]);const r=await captureLegacyDshSource(f.store,f.source);assert.equal(r.records,1);assert.deepEqual(JSON.parse(f.store.exact(r.session,0)).event,value)
})

test('the worker also refuses an existing current artifact, even when the provided header is the old decoded version',async t=>{
 const f=fixture(t);writeFileSync(join(f.dir,'session.v4.jsonl.zstd'),f.bytes)
 await assert.rejects(()=>captureLegacyDshSource(f.store,{...f.source,header:{...header,version:0}}),/Current DSH artifact/)
 assert.equal(f.store.sources().length,0)
})
test('the full backend lists and imports a real released historical artifact through the official persistence provider',async t=>{
 const f=fixture(t),root=join(f.dir,'native/sessions');const {dshHost}=await import('../src/dsh-connection.js'),{pathToFileURL}=await import('node:url'),{dirname}=await import('node:path'),{mkdirSync}=await import('node:fs')
 const host=dshHost(),load=name=>import(pathToFileURL(host.require.resolve(name)).href),[{Context},{default:Persistence}]=await Promise.all([load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-session-persistence-jsonl')])
 const ctx=new Context(),persistence=new Persistence(ctx,{root,compression:'zstd'});t.after(()=>ctx.fiber.dispose())
 await persistence.listArtifacts() // Initialize the official root encoding before placing a fixture.
 const location=persistence.locate(header);mkdirSync(dirname(location.path),{recursive:true});writeFileSync(join(dirname(location.path),'session.jsonl.zstd'),f.bytes)
 const {dshConversations,importDshConversation}=await import('../src/dsh-history.js'),env={...process.env,DSH_HOME:join(f.dir,'native')}
 const listed=await dshConversations(f.store,{env});assert.equal(listed.conversations.length,1);assert.equal(listed.conversations[0].can_index,true,listed.conversations[0].error)
 const r=await importDshConversation(f.store,listed.conversations[0].key,{env});assert.equal(r.records,5);assert.deepEqual(JSON.parse(f.store.exact(r.session,2)).event,rows[2]);assert.equal(r.summary_count,0)
})
