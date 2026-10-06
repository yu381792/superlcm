import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync, chmodSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore, importFile, maxRecord } from '../src/store.js'
import { buildHierarchy, summarizeWithModel, summaryEstimate } from '../src/summarize.js'
import { saveApiKey } from '../src/api-credentials.js'
import { normalizeApiEndpoint } from '../src/api-endpoint.js'
import { createServer, request } from 'node:http'
import { summarizeWithClaudeCli } from '../src/claude-cli.js'
import { workerEnv } from '../src/runtime.js'
import { summarizeWithHermes, summarizeWithPi } from '../src/cli-writers.js'
import { summaryMode } from '../src/mode.js'
import { codexHookTrust } from '../src/codex-hook-trust.js'
import { writeHermesConfig } from '../src/hermes-config.js'
import { openInTerminal } from '../src/open-terminal.js'
import { call, startServer, tools } from '../src/mcp.js'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { spawnSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { summarizeWithCodexCli } from '../src/codex-cli.js'
import { startWeb } from '../src/web.js'
import { modelCatalog, harnessConnections } from '../src/model-catalog.js'
import { captureStale } from '../src/harness.js'
import { page as webPage } from '../src/web-page.js'
import { codexTranscript, codexSessionKey } from '../src/codex.js'
const fixture = fn => async t => {
  const dir=mkdtempSync(join(tmpdir(),'superlcm-claude-'))
  const store=new ClaudeStore(join(dir,'private'))
  store.db.prepare('INSERT INTO summary_tuning(id,target_chars,batch_size,fanout) VALUES(1,12000,8,4)').run()
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  await fn({dir,store,t})
}
const line = (i) => JSON.stringify({type:i%2?'assistant':'user',uuid:`u${i}`,message:{content:[{type:'text',text:`decision ${i}: alpha project`}]} })+'\n'
test('incremental ingest, layered nodes, exact pagination and idempotence',fixture(async ({dir,store})=>{
  const source=join(dir,'history.jsonl')
  writeFileSync(source,Array.from({length:16},(_,i)=>line(i)).join('')+'{"type":"assistant"')
  assert.equal(store.ingest('session1',source).added,16)
  assert.equal(store.ingest('session1',source).added,0)
  const summarize=async t=>`Summary: ${t.slice(0,40)}`
  const first=await buildHierarchy(store,'session1',{model:'test-only',summarize,batchSize:4,fanout:2})
  assert.equal(first.created,7)
  assert.equal((await buildHierarchy(store,'session1',{model:'test-only',summarize,batchSize:4,fanout:2})).created,0)
  const top=store.overview('session1').nodes[0]
  assert.equal(top.level,2)
  assert.equal(store.describe('session1',top.id).children.length,2)
  const page=store.expand('session1',top.id,undefined,0,17)
  assert.equal(page.chunks[0].content,line(0).slice(0,17))
  assert.deepEqual(page.next,{ordinal:0,charOffset:17})
  assert.equal(store.expand('session1',top.id,page.next.ordinal,page.next.charOffset,10000).chunks[0].content,line(0).slice(17))
  assert.ok(store.search('session1','alpha').events.length)
  assert.equal(store.doctor('session1').issues.length,0)
  appendFileSync(source,'}\n')
  assert.equal(store.ingest('session1',source).added,1)
  assert.equal(store.exact('session1',16),'{"type":"assistant"}\n')
  assert.equal((await call(store,'lcm_read',{conversation:'session1',from:16})).chunks[0].content,'{"type":"assistant"}\n')
}))
test('large compacted records retain exact bytes and do not block later dialogue or partial append recovery',fixture(async ({dir,store})=>{
  const file=join(dir,'large.jsonl'),first=JSON.stringify({role:'user',content:'Before compression'})+'\n'
  const compacted=JSON.stringify({type:'compacted',replacement_history:[{role:'user',content:'x'.repeat(5*1024*1024)}]})+'\n'
  const tail=JSON.stringify({role:'assistant',content:'New decision after compression'})+'\n'
  writeFileSync(file,first+compacted.slice(0,-10))
  assert.equal(store.ingest('large',file).added,1)
  assert.equal(store.source('large').offset,Buffer.byteLength(first))
  assert.equal(readFileSync(store.archivePath('large'),'utf8'),first,'partial large record is not committed')
  appendFileSync(file,compacted.slice(-10)+tail)
  assert.equal(store.ingest('large',file).added,2)
  assert.equal(store.exact('large',1),compacted)
  assert.equal(store.eventRows('large')[1].preview,'','replacement history is not counted as new dialogue')
  assert.match(store.eventRows('large')[2].preview,/New decision/)
  assert.equal(readFileSync(store.archivePath('large'),'utf8'),first+compacted+tail)
  assert.equal(store.ingest('large',file).added,0)
  assert.deepEqual(store.doctor('large').issues,[])
  const oversized=join(dir,'oversized.jsonl');writeFileSync(oversized,'x'.repeat(maxRecord+1))
  assert.throws(()=>store.ingest('oversized',oversized),/32 MiB/)
  assert.equal(store.source('oversized').offset,0,'oversized bytes are not falsely committed')
}))
test('Codex submission and Stop hooks succeed past a compaction record larger than four MiB',fixture(async ({dir})=>{
  const config=join(dir,'codex-large'),sessions=join(config,'sessions'),dbPath=join(dir,'codex-large-store'),file=join(sessions,'rollout.jsonl')
  mkdirSync(sessions,{recursive:true})
  const large=JSON.stringify({type:'compacted',replacement_history:['x'.repeat(5*1024*1024)]})+'\n'
  writeFileSync(file,large+JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'A new real decision'}})+'\n')
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url)),env={...process.env,CODEX_HOME:config,SUPERLCM_HOME:dbPath,SUPERLCM_SUMMARY_MODE:'off'}
  for(const event of ['UserPromptSubmit','Stop']){
    const r=spawnSync(process.execPath,[cli,'codex-hook'],{input:JSON.stringify({hook_event_name:event,session_id:'large-hook',transcript_path:file,cwd:dir}),encoding:'utf8',env,timeout:15000})
    assert.equal(r.status,0,r.stderr);if(event==='Stop')assert.equal(r.stdout,'{}\n')
  }
  const saved=new ClaudeStore(dbPath)
  try{assert.equal(saved.stats('codex-large-hook').records,2);assert.equal(saved.exact('codex-large-hook',0),large);assert.match(saved.eventRows('codex-large-hook')[1].preview,/new real decision/)}finally{saved.close()}
}))
test('reject source changes, enforce private exact source, import text',fixture(async ({dir,store})=>{
  const src=join(dir,'conversation.txt')
  writeFileSync(src,'first line\nsecond line\nthird line')
  assert.equal(importFile(store,src,'desktop-1').added,3)
  assert.equal(store.exact('desktop-1',2),'third line')
  const imported=store.source('desktop-1').path
  writeFileSync(imported,'tampered')
  assert.equal(store.exact('desktop-1',0),'first line\n','the private archive keeps the original after the source changes')
  writeFileSync(store.archivePath('desktop-1'),'tampered too')
  assert.throws(()=>store.exact('desktop-1',0),/changed/)
  assert.ok(store.doctor('desktop-1').issues.length)
  assert.throws(()=>store.ingest('desktop-1',src,'text'),/different source/)
}))
test('originals survive the host moving or deleting its transcript',fixture(async ({dir,store})=>{
  const day=join(dir,'codex','sessions','2026','09','23');mkdirSync(day,{recursive:true})
  const file=join(day,'rollout-a.jsonl'),line=i=>JSON.stringify({role:i%2?'assistant':'user',content:'kept decision '+i})+'\n'
  writeFileSync(file,[0,1,2].map(line).join(''));store.ingest('codex-a',file)
  assert.equal(readFileSync(store.archivePath('codex-a'),'utf8'),readFileSync(file,'utf8'),'archive mirrors indexed bytes')
  appendFileSync(file,line(3)+'{"partial":');store.ingest('codex-a',file)
  assert.equal(statSync(store.archivePath('codex-a')).size,store.source('codex-a').offset,'only complete records are archived')
  const archived=join(dir,'codex','archived_sessions');mkdirSync(archived);const moved=join(archived,'rollout-a.jsonl')
  writeFileSync(moved,readFileSync(file));rmSync(file)
  assert.match(store.exact('codex-a',3),/kept decision 3/)
  rmSync(store.archivePath('codex-a'))
  assert.equal(store.archive('codex-a').found_at,realpathSync(moved),'a transcript moved into archived_sessions is found and re-archived')
  rmSync(moved);assert.match(store.exact('codex-a',0),/kept decision 0/)
  assert.deepEqual(store.doctor('codex-a').issues,[])
  const other=join(dir,'gone.jsonl');writeFileSync(other,line(0));store.ingest('gone',other);rmSync(other);rmSync(store.archivePath('gone'))
  assert.equal(store.archive('gone').archived,false);assert.throws(()=>store.exact('gone',0),/missing/)
}))
test('MCP modern discovery, legacy handshake and tools',fixture(async ({store,dir})=>{
  const input=new PassThrough(),output=new PassThrough(),received=[]
  const lines=createInterface({input:output});lines.on('line',l=>received.push(JSON.parse(l)))
  const server=startServer(new ClaudeStore(join(dir,'server')),input,output)
  const send=async msg=>{input.write(JSON.stringify(msg)+'\n');for(let n=0;n<30;n++){if(received.some(x=>x.id===msg.id))return received.find(x=>x.id===msg.id);await new Promise(r=>setTimeout(r,5))}throw Error('no response')}
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}
  const discovered=(await send({jsonrpc:'2.0',id:1,method:'server/discover',params:{_meta:meta}})).result
  assert.ok(discovered.supportedVersions.includes('2026-07-28'))
  assert.equal(discovered.ttlMs,0)
  assert.equal(discovered.cacheScope,'private')
  assert.equal((await send({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-11-25'}})).result.protocolVersion,'2025-11-25')
  const listed=(await send({jsonrpc:'2.0',id:3,method:'tools/list',params:{_meta:meta}})).result
  assert.equal(listed.resultType,'complete')
  assert.equal(listed.ttlMs,0)
  assert.equal(listed.cacheScope,'private')
  assert.equal((await send({jsonrpc:'2.0',id:4,method:'tools/call',params:{_meta:meta,name:'lcm_find',arguments:{}}})).result.isError,undefined)
  assert.equal((await send({jsonrpc:'2.0',id:5,method:'tools/list',params:{_meta:{...meta,'io.modelcontextprotocol/protocolVersion':'2039-01-01'}}})).error.code,-32022)
  assert.equal(tools.length,6)
  assert.deepEqual(tools.map(t=>t.annotations.readOnlyHint),[true,true,true,true,false,false]);assert.ok(tools.every(t=>t.annotations.destructiveHint===false&&t.annotations.openWorldHint===false))
  const legacyListed=(await send({jsonrpc:'2.0',id:6,method:'tools/list',params:{}})).result
  assert.deepEqual(legacyListed.tools.map(t=>t.name),['lcm_continue','lcm_find','lcm_outline','lcm_read'],'background summaries are the default')
  assert.equal(legacyListed.ttlMs,undefined)
  assert.equal(legacyListed.cacheScope,undefined)
  assert.deepEqual(await call(store,'lcm_find'),{conversations:[],total:0})
  input.end();await new Promise(r=>server.once('close',r));lines.close()
}))

test('any MCP client reads a chosen Claude conversation without merging other summaries',fixture(async ({dir,store})=>{
  const claude=join(dir,'claude.jsonl');writeFileSync(claude,Array.from({length:32},(_,i)=>line(i)).join(''))
  store.ingest('claude-conversation',claude);store.setOrigin('claude-conversation','claude-code')
  assert.equal(summaryEstimate(store,'claude-conversation').calls,5,'the confirmation dialog predicts the real number of model calls')
  assert.equal((await buildHierarchy(store,'claude-conversation',{model:'fake',summarize:async text=>'Claude decision: '+text.slice(0,50)})).created,5)
  assert.equal(summaryEstimate(store,'claude-conversation').calls,0)
  const codex=join(dir,'codex.jsonl')
  const codexLines=Array.from({length:8},(_,i)=>JSON.stringify(i%2?{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Codex response '+i}]}}:{type:'event_msg',payload:{type:'user_message',message:'Codex user '+i}})+'\n').join('')
  writeFileSync(codex,codexLines)
  assert.equal(importFile(store,codex,'codex-conversation','codex').added,8)
  assert.ok(store.search('codex-conversation','Codex').events.length)
  assert.equal((await buildHierarchy(store,'codex-conversation',{model:'fake',summarize:async()=> 'Codex-only findings'})).created,1)
  const client=new ClaudeStore(store.dir)
  try {
    const claudeOnly=await call(client,'lcm_find',{harness:'claude-code'})
    assert.equal(claudeOnly.total,1);assert.equal(claudeOnly.conversations[0].session,'claude-conversation')
    assert.equal(claudeOnly.conversations[0].summary_count,5)
    assert.equal((await call(client,'lcm_find',{limit:1})).total,2)
    const top=await call(client,'lcm_outline',{conversation:'claude-conversation'})
    assert.equal(top.nodes.length,1);assert.equal(top.nodes[0].level,1);assert.equal(top.unsummarized,null)
    const children=await call(client,'lcm_outline',{conversation:'claude-conversation',node:top.nodes[0].id})
    assert.equal(children.nodes.length,4)
    const leaf=await call(client,'lcm_outline',{conversation:'claude-conversation',node:children.nodes[0].id})
    assert.equal(leaf.events.length,8);assert.match(leaf.events[0].preview,/alpha project/)
    assert.equal((await call(client,'lcm_outline',{conversation:'codex-conversation'})).nodes.length,1)
    assert.equal((await call(client,'lcm_find',{conversation:'claude-conversation',query:'Codex-only'})).summaries.length,0)
    assert.equal((await call(client,'lcm_find',{query:'Codex-only'})).summaries.length,1)
    assert.match(client.readEvent('claude-conversation',0).content,/alpha project/)
    assert.throws(()=>client.setOrigin('claude-conversation','codex'),/different harness/)
  } finally {client.close()}
}))
test('portable JSONL is searchable and unsupported exports are rejected before import',fixture(async ({dir,store})=>{
  const portable=join(dir,'portable.jsonl')
  writeFileSync(portable,'{"role":"user","content":"portable project decision"}\n{"role":"assistant","content":"portable confirmation"}\n')
  const result=importFile(store,portable,'other-session','other-harness')
  assert.equal(result.added,2);assert.equal(store.sources()[0].harness,'other-harness')
  assert.equal(store.search('other-session','portable').events.length,2)
  const unsupported=join(dir,'unsupported.jsonl');writeFileSync(unsupported,'{"type":"unknown","payload":{}}\n')
  assert.throws(()=>importFile(store,unsupported,'bad-session','other-harness'),/No visible/)
  assert.equal(store.source('bad-session'),undefined)
  assert.throws(()=>importFile(store,portable,'bad/session','other-harness'),/Invalid session ID/)
}))
test('Claude custom title outranks AI title and user-derived text',fixture(async ({dir,store})=>{
  const file=join(dir,'native-titles.jsonl')
  writeFileSync(file,[JSON.stringify({type:'user',message:{content:'original prompt'}}),JSON.stringify({type:'ai-title',aiTitle:'Generated name',sessionId:'claude-9'}),JSON.stringify({type:'custom-title',customTitle:'My named discussion',sessionId:'claude-9'})].join('\n')+'\n')
  store.ingest('claude-9',file)
  assert.equal(store.nativeClaudeTitle('claude-9'),'My named discussion')
  store.setMetadata('claude-9',{harness:'claude-code',externalId:'claude-9',name:store.nativeClaudeTitle('claude-9'),nameSource:'native'})
  assert.equal((await call(store,'lcm_find',{query:'My named discussion'})).conversations[0].session,'claude-9')
  store.nameSession('claude-9','Manual override')
  store.setMetadata('claude-9',{harness:'claude-code',externalId:'claude-9',name:store.nativeClaudeTitle('claude-9'),nameSource:'native'})
  assert.equal(store.metadata('claude-9').name,'Manual override')
}))
test('Codex Stop hook indexes local rollout with native title and exact source ID',fixture(async ({dir})=>{
  const config=join(dir,'codex-home'),sessions=join(config,'sessions'),dbPath=join(dir,'private-codex'),file=join(sessions,'rollout.jsonl')
  mkdirSync(sessions,{recursive:true})
  writeFileSync(file,Array.from({length:8},(_,i)=>JSON.stringify(i%2?{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'answer '+i}]}}:{type:'event_msg',payload:{type:'user_message',message:'Codex plan '+i}})+'\n').join(''))
  const state=new DatabaseSync(join(config,'state_5.sqlite'))
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT,rollout_path TEXT)')
  state.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('thr_42','Generated title','Named research thread',file);state.close()
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url))
  const env={...process.env,CODEX_HOME:config,SUPERLCM_HOME:dbPath,SUPERLCM_SUMMARY_MODE:'off'}
  const run=(event,path=file)=>spawnSync(process.execPath,[cli,'codex-hook'],{input:JSON.stringify({hook_event_name:event,session_id:'thr_42',transcript_path:path,cwd:dir,source:event==='SessionStart'?'compact':undefined}),encoding:'utf8',env,timeout:15000})
  assert.equal(codexSessionKey('thr_42'),'codex-thr_42')
  assert.equal(codexTranscript(file,{env,cwd:dir}),realpathSync(file))
  const result=run('Stop')
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'{}\n')
  const store=new ClaudeStore(dbPath)
  try {
    const meta=store.metadata('codex-thr_42')
    assert.deepEqual({harness:meta.harness,conversation_id:meta.conversation_id,name:meta.name,name_source:meta.name_source},{harness:'codex',conversation_id:'thr_42',name:'Named research thread',name_source:'native'})
    assert.equal(store.eventRows('codex-thr_42').length,8)
    assert.equal((await call(store,'lcm_find',{query:'Named research thread',harness:'codex'})).conversations[0].session,'codex-thr_42')
    assert.equal(store.resolveOne('thr_42'),'codex-thr_42')
    assert.equal(store.resolveOne('#'+store.metadata('codex-thr_42').code),'codex-thr_42')
    assert.equal(store.nameSession('codex-thr_42','My renamed thread').name_source,'manual')
  } finally {store.close()}
  const again=run('PostCompact');assert.equal(again.status,0,again.stderr)
  const compact=run('SessionStart');assert.equal(compact.status,0,compact.stderr);assert.match(compact.stdout,/all 8 original records are preserved as #[0-9a-f]{5}/)
  const final=new ClaudeStore(dbPath);assert.equal(final.metadata('codex-thr_42').name,'My renamed thread');final.close()
  const outside=join(dir,'outside.jsonl');writeFileSync(outside,'{"role":"user","content":"private"}\n')
  assert.notEqual(run('Stop',outside).status,0)
}))
test('Codex Stop schedules an isolated fake CLI summary worker', {skip:process.platform==='win32'},fixture(async ({dir,store})=>{
  const codexHome=join(dir,'codex-home'),sessions=join(codexHome,'sessions'),file=join(sessions,'run.jsonl')
  mkdirSync(sessions,{recursive:true})
  writeFileSync(file,Array.from({length:8},(_,i)=>JSON.stringify({role:i%2?'assistant':'user',content:'isolated detail '+i})+'\n').join(''))
  const fake=join(dir,'fake-summary-cli')
  // 本工具后台写: a Codex conversation is summarized by (a fake) Codex.
  writeFileSync(fake,`#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Isolated Codex summary from background worker.'}})+'\\n'));\n`)
  chmodSync(fake,0o700)
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url))
  const env={...process.env,CODEX_HOME:codexHome,SUPERLCM_HOME:store.dir,SUPERLCM_SUMMARY_MODE:'cli',SUPERLCM_CODEX_CLI_BIN:fake}
  delete env.SUPERLCM_ANTHROPIC_API_KEY
  const result=spawnSync(process.execPath,[cli,'codex-hook'],{input:JSON.stringify({session_id:'thr_worker',transcript_path:file,cwd:dir,hook_event_name:'Stop'}),encoding:'utf8',env,timeout:15000})
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'{}\n')
  let page
  for(let i=0;i<240;i++){page=store.summaries('codex-thr_worker');if(page.total)break;await new Promise(r=>setTimeout(r,50))}
  assert.equal(page.total,1);assert.match(page.nodes[0].summary,/Isolated Codex summary/)
  assert.equal(page.source.conversation_id,'thr_worker');assert.equal(page.source.harness,'codex')
}))
test('existing alpha.5 origins migrate without losing provenance',fixture(async ({dir})=>{
  const legacy=join(dir,'legacy-index');mkdirSync(legacy)
  const db=new DatabaseSync(join(legacy,'lcm.sqlite'))
  db.exec('CREATE TABLE sources(session TEXT PRIMARY KEY,path TEXT,kind TEXT,offset INTEGER,status TEXT);CREATE TABLE session_origins(session TEXT PRIMARY KEY,harness TEXT)')
  db.prepare('INSERT INTO sources VALUES(?,?,?,?,?)').run('old-conversation',join(dir,'old.txt'),'text',0,'ok')
  db.prepare('INSERT INTO session_origins VALUES(?,?)').run('old-conversation','claude-code');db.close()
  const upgraded=new ClaudeStore(legacy)
  try{assert.equal(upgraded.metadata('old-conversation').harness,'claude-code');assert.equal(upgraded.nameSession('old-conversation','Legacy title').name,'Legacy title')}
  finally{upgraded.close()}
}))
test('duplicate names remain ambiguous; source identity is returned with summary pages',fixture(async ({dir,store})=>{
  for(const session of ['one','two']) {
    const path=join(dir,session+'.txt');writeFileSync(path,Array.from({length:8},(_,i)=>'decision '+session+' '+i+'\n').join(''))
    importFile(store,path,session,'other','Shared title')
    await buildHierarchy(store,session,{model:'test',summarize:async()=> 'A deliberately separate summary'})
  }
  assert.equal((await call(store,'lcm_find',{query:'Shared title'})).conversations.length,2)
  await assert.rejects(call(store,'lcm_outline',{conversation:'Shared title'}),/matches 2 conversations/)
  const page=await call(store,'lcm_outline',{conversation:'one'})
  assert.equal(page.source.name,'Shared title');assert.equal(page.source.harness,'other');assert.equal(page.nodes.length,1)
  assert.equal(page.nodes[0].summary,'A deliberately separate summary')
  assert.equal((await call(store,'lcm_outline',{conversation:'#'+store.metadata('two').code})).source.conversation_id,'two')
}))
test('global defaults and per-harness overrides persist without a conversation selector',fixture(async ({dir,store})=>{
  for(const [id,harness] of [['a','claude-code'],['b','codex']]){const file=join(dir,id+'.txt');writeFileSync(file,'A user decision\n');importFile(store,file,id,harness)}
  assert.equal(store.effectiveSetting('a',{}).mode,'cli')
  store.setGlobalSetting('off');assert.equal(store.effectiveSetting('a').mode,'off');assert.equal(store.effectiveSetting('b').mode,'off')
  assert.throws(()=>store.setHarnessSetting('codex','codex-cli','gpt-test'),/Invalid/)
  store.setHarnessSetting('codex','cli','gpt-test');assert.equal(store.effectiveSetting('a').scope,'global');assert.deepEqual([store.effectiveSetting('b').mode,store.effectiveSetting('b').model,store.effectiveSetting('b').scope],['cli','gpt-test','harness'])
  store.setGlobalSetting('cli');assert.equal(store.effectiveSetting('a').model,null)
  store.setPreference('b','agent');assert.equal(store.effectiveSetting('b').mode,'cli')
  const reopened=new ClaudeStore(store.dir);try{assert.equal(reopened.effectiveSetting('b').mode,'cli');assert.equal(reopened.listSessions().sessions.find(x=>x.session==='b').summary_mode,'cli')}finally{reopened.close()}
  // An older index: a Claude model chosen globally moves to Claude Code's own setting; a Codex model picked for Hermes no longer applies.
  store.db.exec("PRAGMA user_version=0;UPDATE global_summary_settings SET mode='cli',model='opus';INSERT OR REPLACE INTO harness_summary_settings(harness,mode,model) VALUES('hermes','codex-cli','gpt-x'),('codex','codex-cli','gpt-y')")
  const upgraded=new ClaudeStore(store.dir);try{assert.deepEqual(upgraded.harnessSettings().map(x=>[x.harness,x.mode,x.model]),[['claude-code','cli','opus'],['codex','cli','gpt-y'],['hermes','cli',null]]);assert.deepEqual([upgraded.globalSetting().mode,upgraded.globalSetting().model],['cli',null])}finally{upgraded.close()}
  store.clearHarnessSetting('claude-code');store.clearHarnessSetting('hermes');store.setHarnessSetting('codex','cli','gpt-test')
  store.setGlobalSetting('off')
  store.clearHarnessSetting('codex');assert.equal(store.effectiveSetting('b').mode,'off')
  assert.throws(()=>store.setGlobalSetting('off','gpt-test'),/does not use/);assert.throws(()=>store.setHarnessSetting('codex','cli','bad model'),/Invalid/)
}))
test('CLI model metadata uses real catalog and explicit cache fallback',fixture(async ({dir})=>{
  writeFileSync(join(dir,'models_cache.json'),JSON.stringify({fetched_at:'test-date',models:[{slug:'gpt-listed',display_name:'GPT Listed',visibility:'list'},{slug:'gpt-hidden',visibility:'hide'}]}))
  const codex=await modelCatalog('codex-cli',{env:{CODEX_HOME:dir},runCommand:async()=>{throw Error('offline')}});assert.deepEqual(codex.models.map(x=>x.id),['gpt-listed']);assert.equal(codex.status,'cached');assert.equal(codex.updated_at,'test-date')
  const calls=[];const live=await modelCatalog('codex-cli',{env:{CODEX_HOME:dir},runCommand:async(bin,args)=>{calls.push(args);return {stdout:JSON.stringify({models:[{slug:'provider/model',visibility:'list'}]})}}});assert.deepEqual(calls,[['debug','models']]);assert.equal(live.models[0].id,'provider/model');assert.equal(live.status,'live')
  const claude=await modelCatalog('cli',{readClaude:async()=>[{value:'opus[1m]',resolvedModel:'claude-real[1m]',displayName:'Actual CLI model'}]});assert.equal(claude.models[0].id,'opus[1m]');assert.equal(claude.models[0].resolved_model,'claude-real[1m]');assert.equal(claude.source,'Claude CLI · initialize.models')
  const hermes=await modelCatalog('hermes',{readHermes:async()=>({model:'up/solar:free',provider:'nous',models:['a/one','a/one:batch','up/solar:free','$(bad)']})});assert.deepEqual(hermes.models.map(x=>x.id),['up/solar:free','a/one'],'default first, batch variants and unsafe IDs dropped');assert.equal(hermes.provider,'nous')
  const failed=await modelCatalog('cli',{readClaude:async()=>{throw Error('No catalog')}});assert.deepEqual(failed.models,[]);assert.equal(failed.status,'unavailable')
}))
test('a custom API saved on a tool before added models existed becomes an added model with its key',()=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-models-'));try{
    let store=new ClaudeStore(dir);store.db.exec('DROP TABLE api_models')
    store.db.prepare("INSERT OR REPLACE INTO harness_summary_settings(harness,mode,model,api_provider,api_url,api_ref) VALUES('claude-code','api','luna','openai','https://old.example.test/v1/chat/completions',NULL)").run()
    saveApiKey(store.dir,'harness:claude-code','old-secret-123456');store.close()
    store=new ClaudeStore(dir);try{
      const [m]=store.apiModels();assert.equal(m.model,'luna');assert.equal(store.harnessSetting('claude-code').api_ref,m.id)
      assert.equal(store.hasApiCredential('model:'+m.id),true);assert.equal(store.harnessKeyScope('claude-code'),'model:'+m.id)
    }finally{store.close()}
  }finally{rmSync(dir,{recursive:true,force:true})}
})

test('custom API settings require scoped endpoint, model and private write-only key',fixture(async ({dir,store})=>{
  const path=join(dir,'api-source.txt');writeFileSync(path,'source message\n');importFile(store,path,'api-session','codex')
  assert.throws(()=>store.setGlobalSetting('api',null,'openai','https://api.example.test/v1/chat/completions'),/model ID/)
  assert.throws(()=>normalizeApiEndpoint('openai','http://remote.example/v1/chat/completions'),/HTTPS/)
  assert.throws(()=>normalizeApiEndpoint('anthropic','https://key@api.example.test/v1/messages'),/HTTPS/)
  store.setGlobalSetting('api','model-v1','openai','https://api.example.test/v1/chat/completions')
  saveApiKey(store.dir,'global','global-secret-123456');assert.equal(store.apiCredential('api-session',{}),'global-secret-123456')
  assert.equal(store.globalSetting().api_provider,'openai');assert.equal(statSync(join(store.dir,'api-credentials.json')).mode&0o077,0)
  assert.equal(readFileSync(join(store.dir,'lcm.sqlite')).includes('global-secret-123456'),false)
  store.setHarnessSetting('codex','api','model-v2','anthropic','https://api.example.test')
  assert.equal(store.apiCredential('api-session',{}),null,'a harness override must never borrow a key for another endpoint')
  saveApiKey(store.dir,'harness:codex','codex-secret-7890');assert.equal(store.apiCredential('api-session',{}),'codex-secret-7890')
}))
test('Anthropic and OpenAI custom API requests use configured URL/model/key only',async()=>{
  const sent=[];const fetchImpl=async(url,init)=>{sent.push({url,init});return {ok:true,json:async()=>sent.length===1?{content:[{type:'text',text:'Anthropic summary'}]}:{choices:[{message:{content:'OpenAI summary'}}]}}}
  assert.equal(await summarizeWithModel('source',{model:'claude-test',apiKey:'key-a',apiProvider:'anthropic',apiURL:'https://api.example.test',fetchImpl}),'Anthropic summary')
  assert.equal(await summarizeWithModel('source',{model:'gpt-test',apiKey:'key-b',apiProvider:'openai',apiURL:'https://api.example.test/v1/chat/completions',fetchImpl}),'OpenAI summary')
  assert.equal(sent[0].url,'https://api.example.test/v1/messages');assert.equal(sent[1].url,'https://api.example.test/v1/chat/completions')
  assert.equal(sent[0].init.headers['x-api-key'],'key-a');assert.equal(sent[1].init.headers.authorization,'Bearer key-b')
  assert.equal(JSON.parse(sent[1].init.body).model,'gpt-test')
  // 思考程度 and base URLs: OpenAI reasoning_effort, Anthropic thinking budget, SDK-style path completion.
  const bodies=[];const ok=async(url,init)=>{bodies.push({url,body:JSON.parse(init.body)});return {ok:true,json:async()=>({choices:[{message:{content:'x'}}],content:[{type:'thinking',thinking:'t'},{type:'text',text:'y'}]})}}
  await summarizeWithModel('s',{model:'g',apiKey:'k-123456789',apiProvider:'openai',apiURL:'https://gen.example.test/v1beta/openai',effort:'high',fetchImpl:ok})
  assert.equal(bodies[0].url,'https://gen.example.test/v1beta/openai/chat/completions');assert.equal(bodies[0].body.reasoning_effort,'high');assert.ok(bodies[0].body.max_tokens>750)
  assert.equal(await summarizeWithModel('s',{model:'c',apiKey:'k-123456789',apiProvider:'anthropic',apiURL:'https://mm.example.test/anthropic',effort:'low',fetchImpl:ok}),'y')
  assert.equal(bodies[1].url,'https://mm.example.test/anthropic/v1/messages');assert.deepEqual(bodies[1].body.thinking,{type:'enabled',budget_tokens:2048});assert.ok(bodies[1].body.max_tokens>2048)
  await summarizeWithModel('s',{model:'g',apiKey:'k-123456789',apiProvider:'openai',apiURL:'https://api.example.test/v1',fetchImpl:ok});assert.equal(bodies[2].body.reasoning_effort,undefined,'unset sends nothing')
  // A reasoning model that refuses max_tokens is retried once with max_completion_tokens.
  const tries=[];const picky=async(url,init)=>{const b=JSON.parse(init.body);tries.push(b);return b.max_tokens?{ok:false,status:400,text:async()=>'Unsupported parameter: max_tokens; use max_completion_tokens'}:{ok:true,json:async()=>({choices:[{message:{content:'z'}}]})}}
  assert.equal(await summarizeWithModel('s',{model:'o',apiKey:'k-123456789',apiProvider:'openai',apiURL:'https://api.example.test/v1',fetchImpl:picky}),'z');assert.equal(tries.length,2);assert.equal(tries[1].max_completion_tokens,2048)
  await assert.rejects(summarizeWithModel('s',{model:'o',apiKey:'k-123456789',apiProvider:'openai',apiURL:'https://api.example.test/v1',fetchImpl:async()=>({ok:false,status:401,text:async()=>'{"error":"invalid key"}'})}),/HTTP 401: .*invalid key/)
})
test('background worker actually uses saved API settings against a local fake endpoint',fixture(async ({dir,store})=>{
  const received=[];const server=createServer((req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{received.push({url:req.url,auth:req.headers.authorization,body:JSON.parse(body)});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'The decisions were preserved in a local fake response.'}}]}))})})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    const file=join(dir,'api-worker.txt');writeFileSync(file,Array.from({length:8},(_,i)=>'record '+i+'\n').join(''));importFile(store,file,'api-worker','codex')
    store.setGlobalSetting('api','gpt-local','openai','http://127.0.0.1:'+server.address().port+'/v1/chat/completions');saveApiKey(store.dir,'global','local-key-123456')
    const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url)),child=spawn(process.execPath,[cli,'summarize','api-worker'],{env:{...process.env,SUPERLCM_HOME:store.dir,SUPERLCM_SUMMARY_MODE:'off'},stdio:['ignore','pipe','pipe']})
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x)
    const code=await new Promise(resolve=>child.on('close',resolve))
    assert.equal(code,0,stderr);assert.equal(received.length,1);assert.equal(received[0].auth,'Bearer local-key-123456');assert.equal(received[0].url,'/v1/chat/completions');assert.equal(received[0].body.model,'gpt-local')
    assert.equal(store.summaries('api-worker').nodes[0].summary,'The decisions were preserved in a local fake response.')
    assert.doesNotMatch(stdout,/local-key-123456/)
  }finally{await new Promise(resolve=>server.close(resolve))}
}))
test('metadata-only Codex batches never invoke a summary model',fixture(async ({dir,store})=>{
  const path=join(dir,'metadata.jsonl')
  writeFileSync(path,Array.from({length:8},(_,i)=>JSON.stringify(i===0?{type:'custom-title',customTitle:'Title without messages'}:{type:'event_msg',payload:{type:'token_count',info:{i}}})+'\n').join(''))
  store.ingest('metadata-session',path)
  let called=0
  const result=await buildHierarchy(store,'metadata-session',{model:'mock',summarize:async()=>{called++;return 'incorrect'}})
  assert.equal(result.created,0);assert.equal(called,0)
  assert.equal(store.summaries('metadata-session').total,0)
}))
test('lcm_continue hands off outline, recent originals and how to verify, with or without summaries',fixture(async ({dir,store})=>{
  const file=join(dir,'source.txt');writeFileSync(file,Array.from({length:37},(_,i)=>'source decision '+i+'\n').join(''))
  importFile(store,file,'source-A','claude-code','Architecture A')
  await buildHierarchy(store,'source-A',{model:'mock',summarize:async()=> 'We decided to preserve original evidence across harnesses.'})
  const code=store.metadata('source-A').code
  const packet=await call(store,'lcm_continue',{conversation:'Architecture A'})
  assert.equal(packet.records,37);assert.equal(packet.summarized_to,32)
  assert.match(packet.content,new RegExp('#'+code))
  assert.match(packet.content,/preserve original evidence/)
  assert.match(packet.content,/Records #32–#36 are not summarized yet/)
  assert.match(packet.content,/\[#36\] source decision 36/)
  assert.match(packet.content,/lcm_read/)
  const bare=join(dir,'bare.txt');writeFileSync(bare,'only raw 1\nonly raw 2\n');importFile(store,bare,'bare-B','codex','Bare B')
  const raw=await call(store,'lcm_continue',{conversation:'#'+store.metadata('bare-B').code})
  assert.match(raw.content,/No summaries yet/);assert.match(raw.content,/only raw 2/)
  await assert.rejects(call(store,'lcm_continue',{conversation:'missing'}),/No conversation matches/)
}))
test('main-agent summary mode requires explicit opt-in and exact unchanged source',fixture(async ({dir,store})=>{
  const file=join(dir,'agent.txt');writeFileSync(file,Array.from({length:8},(_,i)=>'agent decision '+i+'\n').join(''))
  importFile(store,file,'agent-A','codex','Agent authored A')
  store.setGlobalSetting('off');await assert.rejects(call(store,'lcm_summary_task',{conversation:'agent-A'}),/not enabled/)
  store.setGlobalSetting('off');store.setHarnessSetting('codex','agent');store.setPreference('agent-A','off')
  assert.equal(store.effectiveSetting('agent-A').mode,'agent')
  const work=(await call(store,'lcm_summary_task',{conversation:'agent-A'})).work
  assert.ok(work.batch_id);assert.equal(work.level,0)
  const saved=await call(store,'lcm_summary_submit',{conversation:'agent-A',batch_id:work.batch_id,summary:'The user chose a source-preserving cross-harness design.'})
  assert.equal(saved.saved,true);assert.equal(store.summaries('agent-A').nodes[0].model,'mcp-agent')
  await assert.rejects(call(store,'lcm_summary_submit',{conversation:'agent-A',batch_id:work.batch_id,summary:'The user chose a source-preserving cross-harness design.'}),/Stale/)
  const another=join(dir,'tamper.txt');writeFileSync(another,Array.from({length:8},(_,i)=>'before '+i+'\n').join(''));importFile(store,another,'tamper-A','codex')
  const pending=(await call(store,'lcm_summary_task',{conversation:'tamper-A'})).work
  for(const bound of [store.source('tamper-A').path,store.archivePath('tamper-A')]){const bytes=readFileSync(bound);bytes[3]=bytes[3]===65?66:65;writeFileSync(bound,bytes)}
  await assert.rejects(call(store,'lcm_summary_submit',{conversation:'tamper-A',batch_id:pending.batch_id,summary:'This should not persist with a changed original.'}),/changed/)
}))
test('Codex CLI backend follows the user config and captures final JSONL item',fixture(async ({dir})=>{
  let seen
  const spawnProcess=(bin,args,options)=>{seen={bin,args,options};const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{}});queueMicrotask(()=>{child.stdout.end(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Codex factual summary'}})+'\n');child.stderr.end();child.emit('close',0)});return child}
  const value=await summarizeWithCodexCli('decision',{model:'gpt-model',bin:'fake-codex',cwd:join(dir,'scratch'),env:{OPENAI_API_KEY:'secret',OPENAI_BASE_URL:'https://paid.example',CODEX_API_KEY:'paid',ANTHROPIC_API_KEY:'other',CODEX_HOME:'safe-home'},spawnProcess})
  assert.equal(value,'Codex factual summary');assert.ok(seen.args.includes('--ephemeral'));assert.ok(!seen.args.includes('--ignore-user-config'));assert.ok(seen.args.includes('mcp_servers={}'));assert.ok(seen.args.includes('read-only'));assert.deepEqual(seen.args.slice(-4),['-m','gpt-model','--json','-']);assert.equal(seen.options.env.OPENAI_BASE_URL,'https://paid.example');assert.equal(seen.options.env.CODEX_HOME,'safe-home');assert.equal(seen.options.env.SUPERLCM_CLI_WORKER,'1')
}))
test('session Codex CLI choice dispatches through an isolated fake executable',fixture(async ({dir,store})=>{
  const file=join(dir,'codex-backend.txt');writeFileSync(file,Array.from({length:8},(_,i)=>'decision '+i+'\n').join(''))
  importFile(store,file,'chosen-backend','codex');store.setGlobalSetting('off');store.setHarnessSetting('codex','cli','gpt-test')
  const bin=join(dir,'fake-codex');writeFileSync(bin,'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:\'item.completed\',item:{type:\'agent_message\',text:\'Independent Codex worker summary recorded decisions.\'}})+\'\\n\')\n',{mode:0o700})
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url)),r=spawnSync(process.execPath,[cli,'summarize','chosen-backend'],{encoding:'utf8',env:{...process.env,SUPERLCM_HOME:store.dir,SUPERLCM_CODEX_CLI_BIN:bin,SUPERLCM_SUMMARY_MODE:'off'},timeout:15000})
  assert.equal(r.status,0,r.stderr);assert.match(store.summaries('chosen-backend').nodes[0].model,/codex-cli:gpt-test/)
  // Hermes and Pi write through their own one-shot modes, marked so SuperLcm's hooks skip the run.
  const fake=out=>{let seen={};const spawnProcess=(bin,args,options)=>{seen={bin,args,options};const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{}});child.stdin.on('data',d=>{seen.input=(seen.input||'')+d});queueMicrotask(()=>{child.stdout.end(out);child.stderr.end();child.emit('close',0)});return child};return {seen:()=>seen,spawnProcess}}
  const h=fake('{"type": "system"}\n{"type": "result", "exit_code": 0, "text": "Hermes summary"}\n')
  assert.equal(await summarizeWithHermes('decision',{model:'m/x',bin:'hermes',cwd:join(dir,'w'),env:{},spawnProcess:h.spawnProcess}),'Hermes summary')
  assert.deepEqual(h.seen().args.slice(0,7),['chat','--query-file','-','--format','stream-json','--source','tool']);assert.deepEqual(h.seen().args.slice(-2),['-m','m/x']);assert.equal(h.seen().options.env.SUPERLCM_CLI_WORKER,'1');assert.match(h.seen().input,/conversation_excerpt/)
  const pi=fake('Pi summary\n')
  assert.equal(await summarizeWithPi('decision',{bin:'pi',cwd:join(dir,'w'),env:{},spawnProcess:pi.spawnProcess}),'Pi summary')
  for(const flag of ['-p','--no-session','--no-tools','--no-extensions'])assert.ok(pi.seen().args.includes(flag),flag)
  const hook=spawnSync(process.execPath,[cli,'pi-hook'],{input:JSON.stringify({hook_event_name:'agent_settled'}),encoding:'utf8',env:{...process.env,SUPERLCM_HOME:store.dir,SUPERLCM_CLI_WORKER:'1'}});assert.equal(hook.stdout.trim(),'{}');assert.doesNotMatch(hook.stderr,/SuperLcm/)
}))
test('Codex pre-turn hook indexes and current agent saves without MCP import permission',fixture(async ({dir,store})=>{
  const home=join(dir,'codex-pre-turn'),sessions=join(home,'sessions'),file=join(sessions,'current.jsonl');mkdirSync(sessions,{recursive:true});writeFileSync(file,Array.from({length:8},(_,i)=>line(i)).join(''))
  store.setGlobalSetting('off');store.setHarnessSetting('codex','agent')
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url)),env={...process.env,CODEX_HOME:home,SUPERLCM_HOME:store.dir}
  const input={session_id:'thr_pre_turn',transcript_path:file,cwd:dir,hook_event_name:'UserPromptSubmit',prompt:'Please write a summary'}
  const hook=spawnSync(process.execPath,[cli,'codex-hook'],{input:JSON.stringify(input),encoding:'utf8',env,timeout:15000})
  assert.equal(hook.status,0,hook.stderr);assert.match(hook.stdout,/lcm_summary_task/)
  const session='codex-thr_pre_turn';assert.equal(store.listSessions(5,0,'codex').total,1)
  assert.equal(store.eventRows(session).length,8)
  const {work}=await call(store,'lcm_summary_task',{conversation:session});assert.ok(work?.batch_id)
  const result=await call(store,'lcm_summary_submit',{conversation:session,batch_id:work.batch_id,summary:'The active session discussed eight events and retained their exact source references.'});assert.equal(result.saved,true)
  assert.equal(store.summaries(session).total,1)
  await assert.rejects(call(store,'lcm_import',{path:file}),/Unknown tool/,'file import is CLI-only')
}))
test('Codex UserPromptSubmit nudges opted-in agent without a transcript path',fixture(async ({dir,store})=>{
  const file=join(dir,'agent-prompt.txt');writeFileSync(file,Array.from({length:8},(_,i)=>'decision '+i+'\n').join(''))
  store.ingest('codex-thr_agent',file,'text');store.setMetadata('codex-thr_agent',{harness:'codex',externalId:'thr_agent'});store.setGlobalSetting('off');store.setHarnessSetting('codex','agent')
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url)),r=spawnSync(process.execPath,[cli,'codex-hook'],{input:JSON.stringify({session_id:'thr_agent',transcript_path:null,cwd:dir,hook_event_name:'UserPromptSubmit'}),encoding:'utf8',env:{...process.env,SUPERLCM_HOME:store.dir},timeout:15000})
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/lcm_summary_task/);assert.equal(store.summaries('codex-thr_agent').total,0)
}))
test('every Chinese interface string has an English translation',()=>{
  const src=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8')
  const i18n=src('web-i18n.js'),env={localStorage:{getItem:()=> 'en'},navigator:{language:'en-US'},document:{documentElement:{}}}
  const {LANGS,t}=new Function('localStorage','navigator','document',i18n+';return {LANGS,t}')(env.localStorage,env.navigator,env.document)
  const cjk=/[一-龥]/,missing=new Set(),native=new Set(['中文'])
  for(const file of ['web-client.js','web-admin.js','web-dsh.js','web-dsh-controls.js','web-compression.js'])for(const [,key] of src(file).matchAll(/\bt\('([^']*)'/g))if(cjk.test(key)&&LANGS.en[key]===undefined)missing.add(key)
  const html=webPage('n'),shell=html.slice(html.indexOf('<body>'),html.indexOf('<script'))
  for(const [,text] of shell.matchAll(/>([^<>]+)</g)){const key=text.trim();if(cjk.test(key)&&!native.has(key)&&LANGS.en[key]===undefined)missing.add(key)}
  for(const [,text] of shell.matchAll(/(?:placeholder|title|aria-label)="([^"]+)"/g))if(cjk.test(text)&&LANGS.en[text]===undefined)missing.add(text)
  assert.deepEqual([...missing],[])
  for(const value of Object.values(LANGS.en))assert.doesNotMatch(value,cjk)
  assert.equal(t('{n} 个对话',{n:3}),'3 conversations')
  assert.match(t('Claude 报告 SuperLcm 状态：failed'),/^Claude reports SuperLcm status: failed/)
})
test('Web console page inlines a syntactically valid script with the new views',()=>{
  const html=webPage('nonce'),js=html.match(/<script nonce="nonce">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(js);assert.doesNotThrow(()=>new Function(js));assert.match(html,/--accent: #C96442/)
  for(const view of ['conversations','connect','settings'])assert.match(html,new RegExp('id="view-'+view+'"'))
  for(const label of ['对话','接入','设置','摘要','自定义 API 模型','粒度'])assert.match(html,new RegExp('>'+label+'<'))
  assert.match(js,/对话模型生成/);assert.match(js,/function boot\(/);assert.doesNotMatch(html,/lcm_sessions|lcm_deliver|当前会话 AI/)
})
test('local Web console needs no login, refuses foreign writes and probes actual MCP protocol',fixture(async ({store})=>{
  const probes=[];const web=await startWeb({store:new ClaudeStore(store.dir),discovery:async()=>[{harness:'codex',detected:true,configured:true}],probeModel:async o=>{probes.push(o);if(o.model==='m-bad')throw new Error('Summarization HTTP 404: model not found')}})
  try {
    const initial=await fetch(web.url),html=await initial.text();assert.match(html,/<title>SuperLcm<\/title>/)
    assert.equal(initial.headers.get('set-cookie'),null,'no login cookie')
    const base=new URL(web.url).origin,headers={Authorization:'Bearer '+web.token}
    assert.equal(new URL(web.url).search,'','no login token in the console address')
    assert.equal((await fetch(base+'/api/conversations')).status,200)
    assert.equal((await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://evil.test'},body:'{}'})).status,403,'cross-origin writes are refused')
    assert.equal((await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415,'form-style writes are refused')
    const rebound=await new Promise(resolve=>{const req=request({host:'127.0.0.1',port:new URL(base).port,path:'/api/conversations',headers:{Host:'evil.test'}},res=>resolve(res.statusCode));req.end()})
    assert.equal(rebound,403,'DNS-rebinding Host is refused')
    assert.equal((await fetch(base+'/api/state',{headers})).status,404)
    const original=await fetch(base+'/api/settings',{headers}).then(r=>r.json());assert.equal(typeof original.global.mode,'string')
    const saved=await fetch(base+'/api/settings',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:base},body:JSON.stringify({scope:'global',mode:'off'})});assert.equal(saved.status,200);assert.equal(store.globalSetting().mode,'off')
    store.markClient('codex','hook')
    const configured=await fetch(base+'/api/settings',{headers}).then(r=>r.json());assert.equal(configured.index_home,store.dir);assert.deepEqual(configured.api_models,[])
    const post=body=>fetch(base+'/api/settings',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)})
    assert.equal((await post({scope:'harness',harness:'codex',mode:'cli',model:'opus'})).status,200);assert.equal(store.harnessSetting('codex').model,'opus')
    assert.equal((await post({scope:'harness',harness:'bogus',mode:'off'})).status,400)
    assert.equal((await post({scope:'harness',harness:'codex',mode:'inherit'})).status,200);assert.equal(store.harnessSetting('codex'),null)
    const apiSetting={scope:'global',mode:'api',model:'gpt-test',api_provider:'openai',api_url:'https://api.example.test/v1/chat/completions'}
    assert.equal((await post(apiSetting)).status,400,'API configuration without a key must be rejected')
    const apiResponse=await post({...apiSetting,api_key:'web-secret-123456'});assert.equal(apiResponse.status,200);assert.doesNotMatch(await apiResponse.text(),/web-secret-123456/)
    const apiRead=await fetch(base+'/api/settings',{headers}).then(r=>r.json());assert.equal(apiRead.global.api_key_configured,true);assert.equal(JSON.stringify(apiRead).includes('web-secret-123456'),false);assert.equal(store.globalSetting().model,'gpt-test')
    assert.equal((await post({...apiSetting,model:'gpt-updated'})).status,200,'blank key retains the saved credential')
    // Added API models: one key per model, reused for the same endpoint, picked per tool, never echoed.
    const addModel=body=>fetch(base+'/api/api-models',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)})
    const endpoint={api_provider:'openai',api_url:'https://models.example.test/v1/chat/completions'}
    assert.equal((await addModel({...endpoint,model:'m-one'})).status,400,'a remote model needs a key');assert.equal(store.apiModels().length,0)
    const one=await addModel({...endpoint,model:'m-one',api_key:'model-secret-123456'});const oneText=await one.text();assert.equal(one.status,200);assert.doesNotMatch(oneText,/model-secret/)
    const two=await addModel({...endpoint,model:'m-two',label:'Two',effort:'high'}).then(r=>r.json());assert.equal(two.key_configured,true,'same endpoint reuses the key');assert.deepEqual([two.label,two.effort],['Two','high'])
    assert.equal(probes.at(-1).apiKey,'model-secret-123456','the test call uses the reused key');assert.equal(probes.at(-1).effort,'high')
    assert.equal((await addModel({...endpoint,model:'m-two',effort:'high'})).status,400,'no duplicates');assert.equal((await addModel({...endpoint,model:'m-two',effort:'low'})).status,200,'another effort is another entry')
    const bad=await addModel({...endpoint,model:'m-bad'});assert.equal(bad.status,400);assert.match((await bad.json()).error,/Test call failed: .*model not found/);assert.equal(store.apiModels().some(m=>m.model==='m-bad'),false,'a failed test saves nothing')
    assert.equal((await addModel({...endpoint,model:'m-bad',skip_test:true})).status,200,'save anyway')
    assert.equal((await addModel({...endpoint,model:'vertex/claude@2025 x'})).status,400,'spaces are refused');assert.equal((await addModel({...endpoint,model:'claude-opus@20251101'})).status,200,'API model IDs may use @')
    assert.equal((await post({scope:'harness',harness:'codex',mode:'api',api_ref:two.id})).status,200)
    assert.equal(store.harnessSetting('codex').model,'m-two');assert.equal(store.harnessKeyScope('codex'),'model:'+two.id)
    assert.equal((await addModel({...endpoint,id:two.id,model:'m-renamed'})).status,200);assert.equal(store.harnessSetting('codex').model,'m-renamed','editing a model applies to the tools using it')
    const listed=await fetch(base+'/api/settings',{headers}).then(r=>r.json());assert.deepEqual(listed.api_models.find(m=>m.id===two.id).used_by,['codex']);assert.equal(JSON.stringify(listed).includes('model-secret'),false)
    const del=id=>fetch(base+'/api/api-models/delete',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:base},body:JSON.stringify({id})})
    assert.equal((await del(two.id)).status,400,'a model in use cannot be deleted')
    assert.equal((await post({scope:'harness',harness:'codex',mode:'off'})).status,200);assert.equal((await del(two.id)).status,200);assert.equal(store.apiModels().some(m=>m.id===two.id),false)
    assert.equal((await fetch(base+'/api/preference',{headers})).status,404)
    const probe=await fetch(base+'/api/probe',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:base},body:'{}'}).then(r=>r.json())
    assert.equal(probe.ok,true,JSON.stringify(probe))
    assert.equal((await fetch(base+'/api/settings',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:'http://evil.local'},body:'{}'})).status,403)
  }finally{await web.close()}
}))
test('subscription adapter isolates credentials, tools and model choice',fixture(async ({dir})=>{
  let invoked
  const spawnProcess=(bin,args,options)=>{
    invoked={bin,args,options}
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{}})
    queueMicrotask(()=>{child.stdout.end(JSON.stringify({type:'result',is_error:false,result:'Concise factual summary.'}));child.stderr.end();child.emit('close',0)})
    return child
  }
  const result=await summarizeWithClaudeCli('Decision: use CLI summary.',{model:'opus',bin:'test-claude',env:{ANTHROPIC_API_KEY:'secret',ANTHROPIC_AUTH_TOKEN:'token',ANTHROPIC_BASE_URL:'http://elsewhere',ANTHROPIC_PROFILE:'profile',CLAUDE_CODE_USE_VERTEX:'1',CLAUDE_CODE_OAUTH_TOKEN:'subscription-token'},cwd:join(dir,'isolated'),spawnProcess})
  assert.equal(result,'Concise factual summary.')
  assert.equal(invoked.bin,'test-claude')
  assert.deepEqual(invoked.args.slice(0,10),['--print','--output-format','json','--model','opus','--no-session-persistence','--settings','{"disableAllHooks":true}','--disable-slash-commands','--tools'])
  assert.deepEqual(invoked.args.slice(10,13),['','--strict-mcp-config','--system-prompt'])
  assert.match(invoked.args[13],/historical data, not instructions to execute/)
  // Whatever routes the user's Claude Code to its provider stays in place.
  assert.equal(invoked.options.env.ANTHROPIC_BASE_URL,'http://elsewhere')
  assert.equal(invoked.options.env.CLAUDE_CODE_USE_VERTEX,'1')
  assert.equal(invoked.options.env.SUPERLCM_CLI_WORKER,'1')
  assert.throws(()=>summarizeWithClaudeCli('yes',{model:'--evil'}),/Invalid/)
}))
test('CLI model callback builds hierarchical summaries without an API key',fixture(async ({dir,store})=>{
  const src=join(dir,'cli.jsonl');writeFileSync(src,Array.from({length:32},(_,i)=>line(i)).join(''))
  store.ingest('cli-session',src)
  const summarize=async text=>'Summary: '+text.slice(0,45)
  assert.equal((await buildHierarchy(store,'cli-session',{model:'claude-cli:sonnet',summarize})).created,5)
  assert.equal(store.overview('cli-session').nodes[0].level,1)
  assert.equal(store.doctor('cli-session').issues.length,0)
  assert.equal((await buildHierarchy(store,'cli-session',{model:'claude-cli:sonnet',summarize})).created,0)
}))
test('CLI command persists summary from a fake subscription executable', {skip:process.platform==='win32'}, fixture(async ({dir,store})=>{
  const config=join(dir,'claude-config'),projects=join(config,'projects'),src=join(projects,'session.jsonl')
  mkdirSync(projects,{recursive:true});writeFileSync(src,Array.from({length:8},(_,i)=>line(i)).join(''))
  const fake=join(dir,'fake-claude'),receipt=join(dir,'receipt.json')
  writeFileSync(fake,`#!/usr/bin/env node
const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.writeFileSync(process.env.SUPERLCM_TEST_RECEIPT,JSON.stringify({args:process.argv.slice(2),inputChars:input.length,apiKeyPresent:Boolean(process.env.ANTHROPIC_API_KEY)}));process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'Decisions concern alpha project.'}));});
`)
  chmodSync(fake,0o700)
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url))
  const env={...process.env,CLAUDE_CONFIG_DIR:config,SUPERLCM_CLAUDE_HOME:store.dir,SUPERLCM_SUMMARY_MODE:'cli',SUPERLCM_CLAUDE_CLI_MODEL:'opus',SUPERLCM_CLAUDE_CLI_BIN:fake,SUPERLCM_TEST_RECEIPT:receipt,ANTHROPIC_API_KEY:'user-configured'}
  delete env.SUPERLCM_ANTHROPIC_API_KEY
  const index=spawnSync(process.execPath,[cli,'index',src,'integration-session'],{encoding:'utf8',env,timeout:15000})
  assert.equal(index.status,0,index.stderr)
  const worker=spawnSync(process.execPath,[cli,'summarize','integration-session'],{encoding:'utf8',env,timeout:15000})
  assert.equal(worker.status,0,worker.stderr)
  assert.equal(JSON.parse(worker.stdout).created,1)
  const args=JSON.parse(readFileSync(receipt,'utf8'))
  assert.equal(args.args[4],'opus');assert.equal(args.apiKeyPresent,true);assert.ok(args.inputChars>50)
  const nodeId=store.overview('integration-session').nodes[0].id
  assert.equal(store.node('integration-session',nodeId).model,'claude-cli:opus')
}))
test('background summary refuses changed original before any model call',fixture(async ({dir,store})=>{
  const src=join(dir,'changed.jsonl');writeFileSync(src,Array.from({length:8},(_,i)=>line(i)).join(''))
  store.ingest('changed-session',src)
  for(const file of [src,store.archivePath('changed-session')])writeFileSync(file,Array.from({length:8},(_,i)=>line(i).replace('alpha','omega')).join(''))
  let called=false
  await assert.rejects(buildHierarchy(store,'changed-session',{model:'claude-cli:sonnet',summarize:async()=>{called=true;return 'must never save'}}),/changed/)
  assert.equal(called,false)
  assert.deepEqual(store.overview('changed-session').nodes,[])
}))
test('CLI mode never injects agent writing prompts and worker hooks do not recurse',fixture(async ({dir})=>{
  const config=join(dir,'claude-config'),projects=join(config,'projects'),db=join(dir,'hook-index')
  mkdirSync(projects,{recursive:true});const src=join(projects,'hook.jsonl')
  writeFileSync(src,Array.from({length:32},(_,i)=>line(i)).join(''))
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url))
  const env={...process.env,CLAUDE_CONFIG_DIR:config,SUPERLCM_CLAUDE_HOME:db,SUPERLCM_SUMMARY_MODE:'cli'}
  delete env.SUPERLCM_ANTHROPIC_API_KEY;delete env.SUPERLCM_CLAUDE_MODEL
  const run=(hook, extra={})=>spawnSync(process.execPath,[cli,'hook'],{input:JSON.stringify({session_id:'hook-session',transcript_path:src,...hook}),encoding:'utf8',env:{...env,...extra},timeout:5000})
  const prompt=run({hook_event_name:'UserPromptSubmit'})
  assert.equal(prompt.status,0,prompt.stderr);assert.equal(prompt.stdout,'')
  const nested=run({hook_event_name:'Stop'},{SUPERLCM_CLI_WORKER:'1'})
  assert.equal(nested.status,0,nested.stderr);assert.equal(nested.stdout,'')
  const check=new ClaudeStore(db);assert.equal(check.sources().length,1);assert.equal(check.eventRows('hook-session').length,32);assert.equal(check.summaries('hook-session').total,0);check.close()
  env.SUPERLCM_SUMMARY_MODE='api';env.SUPERLCM_ANTHROPIC_API_KEY='test-not-used'
  const missingModel=run({hook_event_name:'Stop'})
  assert.equal(missingModel.status,0,missingModel.stderr);assert.match(missingModel.stderr,/api mode needs/)
  const indexed=new ClaudeStore(db);assert.equal(indexed.summaryMode('hook-session'),'api');assert.equal(indexed.sources()[0].status,'summary_unconfigured');indexed.close()
}))
test('legacy agent policy row does not block independent CLI policy',fixture(async ({dir,store})=>{
  const src=join(dir,'legacy.jsonl');writeFileSync(src,line(0));store.ingest('legacy-session',src)
  store.db.exec("CREATE TABLE IF NOT EXISTS session_modes(session TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('off','agent','api')))")
  store.db.prepare('INSERT INTO session_modes(session,mode) VALUES(?,?)').run('legacy-session','agent')
  store.setSummaryMode('legacy-session','cli')
  assert.equal(store.summaryMode('legacy-session'),'cli')
  assert.equal(store.db.prepare('SELECT mode FROM session_modes WHERE session=?').get('legacy-session').mode,'agent')
}))
test('mode defaults to background writing and preserves explicit CLI or API choice',()=>{
  assert.equal(summaryMode({}),'cli')
  assert.equal(summaryMode({SUPERLCM_ANTHROPIC_API_KEY:'test'}),'api')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'cli',SUPERLCM_ANTHROPIC_API_KEY:'test'}),'cli')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'off',SUPERLCM_ANTHROPIC_API_KEY:'test'}),'off')
  assert.equal(summaryMode({SUPERLCM_SUMMARIZE_ON_HOOK:'1'}),'api')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'agent'}),'agent')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'agent',SUPERLCM_ANTHROPIC_API_KEY:'test'}),'agent')
  assert.equal(workerEnv({SUPERLCM_ANTHROPIC_API_KEY:'secret',SUPERLCM_CLI_WORKER:'0'}).SUPERLCM_CLI_WORKER,'1')
  assert.equal(workerEnv({SUPERLCM_ANTHROPIC_API_KEY:'secret'}).SUPERLCM_ANTHROPIC_API_KEY,undefined)
  assert.equal(summaryMode({}),'cli');assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'codex-cli'}),'cli')
})
test('merge work is planned as soon as four summaries exist, before the next raw batch',fixture(async ({dir,store})=>{
  const src=join(dir,'long.jsonl');writeFileSync(src,Array.from({length:48},(_,i)=>line(i)).join(''))
  store.ingest('long',src);store.setGlobalSetting('agent')
  const levels=[]
  for(let i=0;i<7;i++){const {work}=await call(store,'lcm_summary_task',{conversation:'long'});if(!work)break;levels.push(work.level);await call(store,'lcm_summary_submit',{conversation:'long',batch_id:work.batch_id,summary:'Summary of level '+work.level+' covering '+work.first+'-'+work.last})}
  assert.deepEqual(levels,[0,0,0,0,1,0,0],'fifth task merges before summarizing records 32-47')
  const outline=store.outline('long');assert.deepEqual(outline.nodes.map(n=>n.level),[1,0,0]);assert.equal(outline.unsummarized,null)
  assert.throws(()=>store.setTuning({target_chars:100,batch_size:8,fanout:4}),/Unsupported/)
  assert.equal(store.setTuning({target_chars:24000,batch_size:64,fanout:6}).fanout,6)
}))

test('Codex hook trust is read from hooks/list, and written only on request for SuperLcm hooks',fixture(async ({dir})=>{
  const fake=(status)=>{const bin=join(dir,'codex-'+status);writeFileSync(bin,'#!'+process.execPath+`
let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1)
if(m.id===1)console.log(JSON.stringify({id:1,result:{}}))
if(m.id===2)console.log(JSON.stringify({id:2,result:{data:[{hooks:[
{eventName:'stop',handlerType:'command',command:'node /x/src/cli.js codex-hook',enabled:true,trustStatus:'trusted'},
{eventName:'sessionStart',handlerType:'command',command:"'/n/node' '/x/src/cli.js' 'codex-hook' '--home' '/h'",enabled:true,trustStatus:'${status}'},
{eventName:'userPromptSubmit',handlerType:'command',command:"'/n/node' '/h/.superlcm-claude/superlcm.js' 'codex-hook'",enabled:true,trustStatus:'trusted'},
{eventName:'stop',handlerType:'command',command:'other-tool',enabled:true,trustStatus:'untrusted'}]}]}}))}})
`);chmodSync(bin,0o755);return bin}
  // The plugin's fixed entry (superlcm.js) counts as SuperLcm's too.
  assert.deepEqual(await codexHookTrust({bin:fake('trusted'),cwd:dir}),{checked:true,total:3,trusted:3,untrusted:[],ok:true})
  assert.deepEqual(await codexHookTrust({bin:fake('untrusted'),cwd:dir}),{checked:true,total:3,trusted:2,untrusted:['sessionStart'],ok:false})
  assert.equal((await codexHookTrust({bin:join(dir,'missing'),cwd:dir})).checked,false)
  // approve:true records Codex's own trust for SuperLcm's exact command only, through config/batchWrite.
  const log=join(dir,'writes.json'),bin=join(dir,'codex-approve');writeFileSync(bin,'#!'+process.execPath+`
const fs=require('node:fs');let b='',trusted=false;process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1)
if(m.id===1)console.log(JSON.stringify({id:1,result:{}}))
if(m.id===2||m.id===4)console.log(JSON.stringify({id:m.id,result:{data:[{hooks:[
{key:'k-ours',currentHash:'sha256:ours',eventName:'stop',handlerType:'command',command:'node /x/src/cli.js codex-hook',enabled:true,trustStatus:trusted?'trusted':'untrusted'},
{key:'k-other',currentHash:'sha256:other',eventName:'stop',handlerType:'command',command:'node /y/cli.js codex-hook --evil',enabled:true,trustStatus:'untrusted'}]}]}}))
if(m.id===3){fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(m.params));trusted=true;console.log(JSON.stringify({id:3,result:{status:'ok'}}))}}})
`);chmodSync(bin,0o755)
  const approved=await codexHookTrust({bin,cwd:dir,approve:true,command:'node /x/src/cli.js codex-hook'})
  assert.deepEqual(JSON.parse(readFileSync(log,'utf8')).edits,[{keyPath:'hooks.state',mergeStrategy:'upsert',value:{'k-ours':{trusted_hash:'sha256:ours'}}}],'only the exact SuperLcm command is trusted')
  assert.equal(approved.approved,true)
  // The other cli.js codex-hook entry is neither trusted nor counted when the exact command is known.
  assert.deepEqual([approved.total,approved.ok],[1,true])
}))

const python3=spawnSync('python3',['-c','pass']).status===0
test('reconnecting Hermes replaces the older SuperLcm hook instead of adding a second one',{skip:!python3||process.platform==='win32'},fixture(async ({dir})=>{
  const modules=join(dir,'py','hermes_cli');mkdirSync(modules,{recursive:true});writeFileSync(join(modules,'__init__.py'),'')
  writeFileSync(join(modules,'config.py'),"import json, os\ndef load_config():\n    return json.load(open(os.environ['TEST_CONFIG']))\ndef save_config(v):\n    json.dump(v, open(os.environ['TEST_CONFIG'], 'w'))\n")
  writeFileSync(join(modules,'mcp_config.py'),'def _save_mcp_server(name, value): return True\n')
  const config=join(dir,'config.json'),script='/h/.superlcm-claude/superlcm.js',shim=join(dir,'python-shim')
  writeFileSync(config,JSON.stringify({hooks:{on_session_end:[{command:`'/old/node' '${script}' hermes-hook`},{command:'echo other'}]}}))
  writeFileSync(shim,`#!/bin/sh\nexec python3 -c 'import sys;sys.path.insert(0, "${join(dir,'py')}");exec(sys.argv[1])' "$2"\n`,{mode:0o700})
  await writeHermesConfig({...process.env,HERMES_HOME:dir,SUPERLCM_HERMES_PYTHON:shim,TEST_CONFIG:config},{mcp:null,script,hooks:{on_session_end:{command:`'/new/node' '${script}' hermes-hook`}}})
  assert.deepEqual(JSON.parse(readFileSync(config,'utf8')).hooks.on_session_end.map(h=>h.command),['echo other',`'/new/node' '${script}' hermes-hook`])
}))

test('opening Codex for its own hook review launches only the fixed CLI in a terminal',fixture(async ({dir})=>{
  const calls=[],spawnProcess=(cmd,args)=>{calls.push([cmd,...args]);return {on(){},unref(){}}}
  assert.deepEqual(openInTerminal("/opt/co'dex",{dir,name:'open-codex',platform:'darwin',spawnProcess}),{opened:true,how:'Terminal'})
  const file=join(dir,'open-codex.command')
  assert.deepEqual(calls[0],['open','-a','Terminal',file])
  assert.equal(readFileSync(file,'utf8'),"#!/bin/sh\ncd \"$HOME\" && exec '/opt/co'\\''dex'\n")
  openInTerminal('C:\\codex.exe',{dir,platform:'win32',spawnProcess});assert.deepEqual(calls[1],['cmd.exe','/c','start','""','cmd.exe','/k','C:\\codex.exe'])
  assert.throws(()=>openInTerminal(null,{dir,spawnProcess}),/CLI not found/)
}))

test('deleting a conversation removes SuperLcm data only, stays deleted for hooks, and re-import revives it',fixture(async ({dir,store})=>{
  const src=join(dir,'talk.jsonl');writeFileSync(src,Array.from({length:10},(_,i)=>line(i)).join(''))
  store.ingest('talk',src);store.setOrigin('talk','claude-code')
  await buildHierarchy(store,'talk',{model:'fake',summarize:async()=> 'summary'})
  const archive=store.archivePath('talk');assert.ok(statSync(archive).size>0)
  const before=readFileSync(src)
  assert.deepEqual(store.deleteSession('talk'),{session:'talk',deleted:true,records:10})
  assert.equal(store.source('talk'),undefined)
  for(const table of ['events','nodes','event_fts','node_fts','session_origins'])assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session=?`).get('talk').n,0,table)
  assert.throws(()=>statSync(archive),/ENOENT/,'SuperLcm archive copy removed')
  assert.deepEqual(readFileSync(src),before,'the host transcript is never touched')
  assert.equal(store.isDeleted('talk'),true,'hooks skip a deleted conversation')
  store.ingest('talk',src);assert.equal(store.isDeleted('talk'),false);assert.equal(store.stats('talk').records,10,'explicit re-import revives it')
}))
test('bulk delete removes only conversations older than the cutoff and refuses a changed set',fixture(async ({dir,store})=>{
  for(const name of ['old1','old2','fresh']){const f=join(dir,name+'.jsonl');writeFileSync(f,line(0)+line(1));store.ingest(name,f);store.setOrigin(name,'codex')}
  const now=Date.now();store.db.prepare('UPDATE sources SET updated_ms=? WHERE session IN (?,?)').run(now-100*86400000,'old1','old2');store.db.prepare('UPDATE sources SET updated_ms=? WHERE session=?').run(now,'fresh')
  const web=await startWeb({store:new ClaudeStore(store.dir)})
  try {
    const post=(path,body)=>fetch(web.url+path.slice(1),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json())
    const before_ms=now-90*86400000
    const preview=await post('/api/delete-preview',{before_ms});assert.equal(preview.count,2);assert.equal(preview.records,4)
    assert.match((await post('/api/delete-bulk',{before_ms,expect_count:3})).error,/changed/)
    assert.deepEqual(await post('/api/delete-bulk',{before_ms,expect_count:2}),{deleted:2})
    const left=new ClaudeStore(store.dir);assert.deepEqual(left.db.prepare('SELECT session FROM sources').all().map(x=>x.session),['fresh']);left.close()
  } finally { await web.close() }
}))

test('segments are sized by characters: whole records up to the target, one oversized record alone with head and tail', async () => {
  const { summaryWork } = await import('../src/summarize.js')
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-seg-')), store = new ClaudeStore(join(dir, 'index'))
  try {
    store.setTuning({ target_chars: 2000, fanout: 4 })
    const file = join(dir, 't.jsonl'), line = (role, text) => JSON.stringify({ type: role, message: { role, content: text } }) + '\n'
    // 5 × 700 characters, then one 9,000-character reply, then more short text.
    writeFileSync(file, [0, 1, 2, 3, 4].map(i => line(i % 2 ? 'assistant' : 'user', String(i).repeat(700))).join('') + line('assistant', 'H'.repeat(5000) + 'T'.repeat(4000)) + line('user', 'x'.repeat(2500)))
    importFile(store, file, 'seg', 'claude-code')
    const first = summaryWork(store, 'seg')
    assert.equal(first.last - first.first + 1, 2, 'closes before the record that would pass 2,000 characters')
    assert.ok(first.content.includes('0'.repeat(700)) && first.content.includes('1'.repeat(700)), 'records are sent whole, not cut at 2,400')
    for (const r of store.eventRows('seg').slice(0, 5)) store.addNode({ session: 'seg', id: 'n' + r.ordinal, level: 0, first: r.ordinal, last: r.ordinal, children: [], summary: 's', digest: 'd', model: 'm' })
    const big = summaryWork(store, 'seg', { fanout: 99 })
    assert.equal(big.first, big.last, 'an oversized record forms its own segment')
    assert.match(big.content, /^\[event \d+\] assistant:\nH+ …\[\d+ characters omitted; lcm_read event \d+ for the full text\]… T+$/)
    assert.ok(big.content.length < 2100)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('a card warns when the tool wrote a conversation after the last SuperLcm hook ran',()=>{
  const now=Date.parse('2026-09-27T15:20:00Z')
  assert.equal(captureStale(Date.parse('2026-09-27T15:10:00Z'),'2026-09-27 14:42:52',now),true)
  assert.equal(captureStale(Date.parse('2026-09-27T15:10:00Z'),'2026-09-27 15:10:05',now),false,'hook ran after the last write')
  assert.equal(captureStale(Date.parse('2026-09-27T15:19:30Z'),'2026-09-27 14:00:00',now),false,'still being written')
  assert.equal(captureStale(null,null,now),false)
})

test('a local gateway on this computer needs no API key',fixture(async ({dir,store})=>{
  let seen;const fetchImpl=async(url,init)=>{seen={url,headers:init.headers};return {ok:true,json:async()=>({choices:[{message:{content:'Local gateway summary'}}]})}}
  assert.equal(await summarizeWithModel('decision',{model:'gpt-6-luna',apiProvider:'openai',apiURL:'http://127.0.0.1:10100/v1',fetchImpl}),'Local gateway summary')
  assert.equal(seen.url,'http://127.0.0.1:10100/v1/chat/completions');assert.equal(seen.headers.authorization,undefined)
  await assert.rejects(summarizeWithModel('decision',{model:'m',apiProvider:'openai',apiURL:'https://api.example.com/v1',fetchImpl}),/credential/)
  const file=join(dir,'gw.txt');writeFileSync(file,'A user decision\n');importFile(store,file,'gw','claude-code')
  store.setHarnessSetting('claude-code','api','gpt-6-luna','openai','http://127.0.0.1:10100/v1')
  assert.equal(store.apiCredential('gw'),'');assert.equal(store.apiConfig('gw').apiKey,'')
  store.setHarnessSetting('claude-code','api','m','openai','https://api.example.com/v1');assert.equal(store.apiCredential('gw'),null);assert.equal(store.apiConfig('gw'),null)
}))

test('Hermes captures running at the same time store each message once',fixture(async ({dir})=>{
  const hermes=join(dir,'hermes-state'),home=join(dir,'capture-home');mkdirSync(hermes,{recursive:true})
  const native=new DatabaseSync(join(hermes,'state.db'))
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,parent_session_id TEXT,end_reason TEXT,title TEXT,started_at INTEGER);CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT);INSERT INTO sessions VALUES('root',NULL,NULL,'t',1)")
  const code=`import {ClaudeStore} from ${JSON.stringify(new URL('../src/store.js',import.meta.url).href)};import {captureHermes} from ${JSON.stringify(new URL('../src/hermes.js',import.meta.url).href)};const s=new ClaudeStore(${JSON.stringify(home)});captureHermes(s,'root',{env:{...process.env,HERMES_HOME:${JSON.stringify(hermes)}}});s.close()`
  const capture=()=>new Promise(done=>spawn(process.execPath,['--no-warnings','--input-type=module','-e',code],{stdio:'ignore'}).on('close',done))
  let id=1
  for(let round=0;round<4;round++){for(let k=0;k<3;k++)native.exec(`INSERT INTO messages VALUES(${id},'root','user','m${id++}')`);await Promise.all([capture(),capture(),capture()])}
  native.close()
  const store=new ClaudeStore(home),[session]=store.db.prepare('SELECT session FROM sources').all().map(r=>r.session)
  assert.equal(store.eventRows(session).length,id-1)
  store.close()
}))

test('Hermes Python is found through a launcher that execs the entry script quoted or bare', async () => {
  const { hermesRuntime,hermesRuntimeAsync } = await import('../src/hermes-config.js')
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-hermes-launcher-')), entry = join(dir, 'entry'), launcher = join(dir, 'hermes')
  // Hermes 0.21.5+: the entry script reports its runtime command with --print-runtime-command.
  writeFileSync(entry, `#!/bin/sh\n# --print-runtime-command\necho '${JSON.stringify([process.execPath, '-I', '-c', 'import sys; runpy.run_module("hermes_cli.main")'])}'\n`); chmodSync(entry, 0o755)
  for (const line of [`exec ${entry} "$@"`, `exec "${entry}" "$@"`]) {
    writeFileSync(launcher, `#!/bin/sh\n${line}\n`); chmodSync(launcher, 0o755)
    const runtime = hermesRuntime({ ...process.env, SUPERLCM_HERMES_BIN: launcher, SUPERLCM_HERMES_PYTHON: '' })
    assert.equal(runtime?.python, process.execPath, line)
    assert.deepEqual(runtime.args, ['-I'])
    assert.deepEqual(await hermesRuntimeAsync({ ...process.env, SUPERLCM_HERMES_BIN: launcher, SUPERLCM_HERMES_PYTHON: '' }),runtime)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('Hermes runtime discovery yields while a launcher is starting',async()=>{
  const {hermesRuntimeAsync}=await import('../src/hermes-config.js')
  const dir=mkdtempSync(join(tmpdir(),'superlcm-hermes-async-')),launcher=join(dir,'hermes')
  const command=[process.execPath,'-I','-c','import sys; runpy.run_module("hermes_cli.main")']
  writeFileSync(launcher,`#!${process.execPath}\n// --print-runtime-command\nsetTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify(command)+'\n')}),100)\n`);chmodSync(launcher,0o755)
  let yielded=false
  const timer=setTimeout(()=>{yielded=true},10)
  try {
    const runtime=await hermesRuntimeAsync({...process.env,SUPERLCM_HERMES_BIN:launcher,SUPERLCM_HERMES_PYTHON:''})
    assert.equal(runtime.python,process.execPath);assert.equal(yielded,true,'another console request can run while Hermes starts')
  }finally{clearTimeout(timer)}
})
