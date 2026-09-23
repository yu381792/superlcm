import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync, chmodSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore, importFile } from '../src/store.js'
import { buildHierarchy } from '../src/summarize.js'
import { summarizeWithClaudeCli, subscriptionEnv } from '../src/claude-cli.js'
import { summaryMode } from '../src/mode.js'
import { call, startServer, tools } from '../src/mcp.js'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { summarizeWithCodexCli, codexSubscriptionEnv } from '../src/codex-cli.js'
import { startWeb } from '../src/web.js'
import { page as webPage } from '../src/web-page.js'
import { codexTranscript, codexSessionKey } from '../src/codex.js'
const fixture = fn => async t => {
  const dir=mkdtempSync(join(tmpdir(),'superlcm-claude-'))
  const store=new ClaudeStore(join(dir,'private'))
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
  assert.equal((await call(store,'lcm_read_event',{session:'session1',ordinal:16})).content,'{"type":"assistant"}\n')
}))
test('reject source changes, enforce private exact source, import text',fixture(async ({dir,store})=>{
  const src=join(dir,'conversation.txt')
  writeFileSync(src,'first line\nsecond line\nthird line')
  assert.equal(importFile(store,src,'desktop-1').added,3)
  assert.equal(store.exact('desktop-1',2),'third line')
  const imported=store.source('desktop-1').path
  writeFileSync(imported,'tampered')
  assert.throws(()=>store.exact('desktop-1',0),/changed/)
  assert.ok(store.doctor('desktop-1').issues.length)
  assert.throws(()=>store.ingest('desktop-1',src,'text'),/different source/)
}))
test('MCP modern discovery, legacy handshake and tools',fixture(async ({store,dir})=>{
  const input=new PassThrough(),output=new PassThrough(),received=[]
  const lines=createInterface({input:output});lines.on('line',l=>received.push(JSON.parse(l)))
  const server=startServer(new ClaudeStore(join(dir,'server')),input,output)
  const send=async msg=>{input.write(JSON.stringify(msg)+'\n');for(let n=0;n<30;n++){if(received.some(x=>x.id===msg.id))return received.find(x=>x.id===msg.id);await new Promise(r=>setTimeout(r,5))}throw Error('no response')}
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}
  assert.ok((await send({jsonrpc:'2.0',id:1,method:'server/discover',params:{_meta:meta}})).result.supportedVersions.includes('2026-07-28'))
  assert.equal((await send({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-11-25'}})).result.protocolVersion,'2025-11-25')
  assert.equal((await send({jsonrpc:'2.0',id:3,method:'tools/list',params:{_meta:meta}})).result.resultType,'complete')
  assert.equal((await send({jsonrpc:'2.0',id:4,method:'tools/call',params:{_meta:meta,name:'lcm_sessions',arguments:{}}})).result.isError,undefined)
  assert.equal((await send({jsonrpc:'2.0',id:5,method:'tools/list',params:{_meta:{...meta,'io.modelcontextprotocol/protocolVersion':'2039-01-01'}}})).error.code,-32022)
  assert.equal(tools.length,17)
  assert.equal(tools.filter(tool=>['lcm_summary_work','lcm_save_summary'].includes(tool.name)).length,2)
  assert.deepEqual(await call(store,'lcm_sessions'),{sessions:[],total:0,next_offset:null})
  input.end();await new Promise(r=>server.once('close',r));lines.close()
}))

test('any MCP client reads a chosen Claude conversation without merging other summaries',fixture(async ({dir,store})=>{
  const claude=join(dir,'claude.jsonl');writeFileSync(claude,Array.from({length:32},(_,i)=>line(i)).join(''))
  store.ingest('claude-conversation',claude);store.setOrigin('claude-conversation','claude-code')
  assert.equal((await buildHierarchy(store,'claude-conversation',{model:'fake',summarize:async text=>'Claude decision: '+text.slice(0,50)})).created,5)
  const codex=join(dir,'codex.jsonl')
  const codexLines=Array.from({length:8},(_,i)=>JSON.stringify(i%2?{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Codex response '+i}]}}:{type:'event_msg',payload:{type:'user_message',message:'Codex user '+i}})+'\n').join('')
  writeFileSync(codex,codexLines)
  assert.equal(importFile(store,codex,'codex-conversation','codex').added,8)
  assert.ok(store.search('codex-conversation','Codex').events.length)
  assert.equal((await buildHierarchy(store,'codex-conversation',{model:'fake',summarize:async()=> 'Codex-only findings'})).created,1)
  const client=new ClaudeStore(store.dir)
  try {
    const claudeOnly=await call(client,'lcm_sessions',{harness:'claude-code',limit:1})
    assert.equal(claudeOnly.total,1);assert.equal(claudeOnly.sessions[0].session,'claude-conversation')
    assert.equal(claudeOnly.sessions[0].summary_count,5);assert.match(claudeOnly.sessions[0].first_message,/alpha project/)
    const all=await call(client,'lcm_sessions',{limit:1})
    assert.equal(all.total,2);assert.equal(all.next_offset,1)
    assert.equal((await call(client,'lcm_sessions',{limit:1,offset:1})).sessions.length,1)
    let page=await call(client,'lcm_summaries',{session:'claude-conversation',limit:2})
    assert.equal(page.total,5);assert.equal(page.nodes.length,2);assert.equal(page.next_offset,2)
    const ids=new Set(page.nodes.map(n=>n.id))
    while(page.next_offset!==null){page=await call(client,'lcm_summaries',{session:'claude-conversation',limit:2,offset:page.next_offset});page.nodes.forEach(n=>ids.add(n.id))}
    assert.equal(ids.size,5)
    assert.equal((await call(client,'lcm_summaries',{session:'codex-conversation'})).total,1)
    assert.equal(client.search('claude-conversation','Codex-only').nodes.length,0)
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
  assert.equal((await call(store,'lcm_resolve_session',{name_or_id:'My named discussion'})).matches[0].session,'claude-9')
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
    assert.equal((await call(store,'lcm_resolve_session',{name_or_id:'Named research thread',harness:'codex'})).matches[0].session,'codex-thr_42')
    assert.equal((await call(store,'lcm_resolve_session',{name_or_id:'thr_42'})).matches[0].session,'codex-thr_42')
    assert.equal(store.nameSession('codex-thr_42','My renamed thread').name_source,'manual')
  } finally {store.close()}
  const again=run('PostCompact');assert.equal(again.status,0,again.stderr)
  const compact=run('SessionStart');assert.equal(compact.status,0,compact.stderr);assert.match(compact.stdout,/SuperLcm session codex-thr_42/)
  const final=new ClaudeStore(dbPath);assert.equal(final.metadata('codex-thr_42').name,'My renamed thread');final.close()
  const outside=join(dir,'outside.jsonl');writeFileSync(outside,'{"role":"user","content":"private"}\n')
  assert.notEqual(run('Stop',outside).status,0)
}))
test('Codex Stop schedules an isolated fake CLI summary worker', {skip:process.platform==='win32'},fixture(async ({dir,store})=>{
  const codexHome=join(dir,'codex-home'),sessions=join(codexHome,'sessions'),file=join(sessions,'run.jsonl')
  mkdirSync(sessions,{recursive:true})
  writeFileSync(file,Array.from({length:8},(_,i)=>JSON.stringify({role:i%2?'assistant':'user',content:'isolated detail '+i})+'\n').join(''))
  const fake=join(dir,'fake-summary-cli')
  writeFileSync(fake,`#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'Isolated Codex summary from background worker.'})));\n`)
  chmodSync(fake,0o700)
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url))
  const env={...process.env,CODEX_HOME:codexHome,SUPERLCM_HOME:store.dir,SUPERLCM_SUMMARY_MODE:'cli',SUPERLCM_CLAUDE_CLI_BIN:fake}
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
  const found=await call(store,'lcm_resolve_session',{name_or_id:'Shared title'})
  assert.equal(found.ambiguous,true);assert.equal(found.matches.length,2)
  const page=await call(store,'lcm_summaries',{session:'one'})
  assert.equal(page.source.name,'Shared title');assert.equal(page.source.harness,'other');assert.equal(page.nodes.length,1)
  assert.equal(page.nodes[0].summary,'A deliberately separate summary')
  assert.equal((await call(store,'lcm_summaries',{session:'two'})).source.conversation_id,'two')
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
test('MCP directly imports context and target hook issues a bounded delivery',fixture(async ({dir,store})=>{
  const file=join(dir,'source.txt');writeFileSync(file,Array.from({length:8},(_,i)=>'source decision '+i+'\n').join(''))
  importFile(store,file,'source-A','claude-code','Architecture A')
  await buildHierarchy(store,'source-A',{model:'mock',summarize:async()=> 'We decided to preserve original evidence across harnesses.'})
  const home=join(dir,'codex-home'),sessions=join(home,'sessions'),targetFile=join(sessions,'target.jsonl');mkdirSync(sessions,{recursive:true});writeFileSync(targetFile,JSON.stringify({role:'user',content:'Continue B'})+'\n')
  store.ingest('codex-thr_B',targetFile);store.setMetadata('codex-thr_B',{harness:'codex',externalId:'thr_B',name:'Conversation B'})
  const direct=await call(store,'lcm_context',{session:'source-A'});assert.match(direct.content,/preserve original evidence/)
  await assert.rejects(call(store,'lcm_enqueue_context',{source:'source-A',target:'codex-thr_B'}),/disabled/)
  const oldGate=process.env.SUPERLCM_ALLOW_MCP_DELIVERY;process.env.SUPERLCM_ALLOW_MCP_DELIVERY='1'
  try {
    const queued=await call(store,'lcm_enqueue_context',{source:'source-A',target:'codex-thr_B'});assert.equal(queued.status,'pending')
    assert.equal((await call(store,'lcm_enqueue_context',{source:'source-A',target:'codex-thr_B'})).deduplicated,true)
  } finally { if(oldGate===undefined)delete process.env.SUPERLCM_ALLOW_MCP_DELIVERY;else process.env.SUPERLCM_ALLOW_MCP_DELIVERY=oldGate }
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url)),env={...process.env,CODEX_HOME:home,SUPERLCM_HOME:store.dir,SUPERLCM_SUMMARY_MODE:'off'}
  const result=spawnSync(process.execPath,[cli,'codex-hook'],{input:JSON.stringify({session_id:'thr_B',transcript_path:null,cwd:dir,hook_event_name:'UserPromptSubmit',prompt:'Find A'}),encoding:'utf8',env,timeout:15000})
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/SuperLcm delivery #/);assert.match(result.stdout,/Architecture A/)
  assert.ok(store.deliveries()[0].issued_at);assert.equal(store.pendingFor('codex','thr_B').length,0)
}))
test('main-agent summary mode requires explicit opt-in and exact unchanged source',fixture(async ({dir,store})=>{
  const file=join(dir,'agent.txt');writeFileSync(file,Array.from({length:8},(_,i)=>'agent decision '+i+'\n').join(''))
  importFile(store,file,'agent-A','codex','Agent authored A')
  await assert.rejects(call(store,'lcm_summary_work',{session:'agent-A'}),/disabled/)
  store.setPreference('agent-A','agent')
  const work=(await call(store,'lcm_summary_work',{session:'agent-A'})).work
  assert.ok(work.batch_id);assert.equal(work.level,0)
  const saved=await call(store,'lcm_save_summary',{session:'agent-A',batch_id:work.batch_id,summary:'The user chose a source-preserving cross-harness design.'})
  assert.equal(saved.saved,true);assert.equal(store.summaries('agent-A').nodes[0].model,'mcp-agent')
  await assert.rejects(call(store,'lcm_save_summary',{session:'agent-A',batch_id:work.batch_id,summary:'The user chose a source-preserving cross-harness design.'}),/Stale/)
  const another=join(dir,'tamper.txt');writeFileSync(another,Array.from({length:8},(_,i)=>'before '+i+'\n').join(''));importFile(store,another,'tamper-A','codex')
  store.setPreference('tamper-A','agent');const pending=(await call(store,'lcm_summary_work',{session:'tamper-A'})).work
  const bound=store.source('tamper-A').path;const bytes=readFileSync(bound);bytes[3]=bytes[3]===65?66:65;writeFileSync(bound,bytes)
  await assert.rejects(call(store,'lcm_save_summary',{session:'tamper-A',batch_id:pending.batch_id,summary:'This should not persist with a changed original.'}),/changed/)
}))
test('Codex CLI backend strips API credentials and captures final JSONL item',fixture(async ({dir})=>{
  let seen
  const spawnProcess=(bin,args,options)=>{seen={bin,args,options};const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{}});queueMicrotask(()=>{child.stdout.end(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Codex factual summary'}})+'\n');child.stderr.end();child.emit('close',0)});return child}
  const value=await summarizeWithCodexCli('decision',{model:'gpt-model',bin:'fake-codex',cwd:join(dir,'scratch'),env:{OPENAI_API_KEY:'secret',OPENAI_BASE_URL:'https://paid.example',CODEX_API_KEY:'paid',ANTHROPIC_API_KEY:'other',CODEX_HOME:'safe-home'},spawnProcess})
  assert.equal(value,'Codex factual summary');assert.ok(seen.args.includes('--ephemeral'));assert.ok(seen.args.includes('--ignore-user-config'));assert.ok(seen.args.includes('read-only'));assert.deepEqual(seen.args.slice(-4),['-m','gpt-model','--json','-']);assert.equal(seen.options.env.OPENAI_API_KEY,undefined);assert.equal(seen.options.env.OPENAI_BASE_URL,undefined);assert.equal(seen.options.env.CODEX_API_KEY,undefined);assert.equal(seen.options.env.CODEX_HOME,'safe-home')
  assert.equal(codexSubscriptionEnv({OPENAI_API_KEY:'secret'}).OPENAI_API_KEY,undefined)
}))
test('session Codex CLI choice dispatches through an isolated fake executable',fixture(async ({dir,store})=>{
  const file=join(dir,'codex-backend.txt');writeFileSync(file,Array.from({length:8},(_,i)=>'decision '+i+'\n').join(''))
  importFile(store,file,'chosen-backend','codex');store.setPreference('chosen-backend','codex-cli','gpt-test')
  const bin=join(dir,'fake-codex');writeFileSync(bin,'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:\'item.completed\',item:{type:\'agent_message\',text:\'Independent Codex worker summary recorded decisions.\'}})+\'\\n\')\n',{mode:0o700})
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url)),r=spawnSync(process.execPath,[cli,'summarize','chosen-backend'],{encoding:'utf8',env:{...process.env,SUPERLCM_HOME:store.dir,SUPERLCM_CODEX_CLI_BIN:bin,SUPERLCM_SUMMARY_MODE:'off'},timeout:15000})
  assert.equal(r.status,0,r.stderr);assert.match(store.summaries('chosen-backend').nodes[0].model,/codex-cli:gpt-test/)
}))
test('Codex UserPromptSubmit nudges opted-in agent without a transcript path',fixture(async ({dir,store})=>{
  const file=join(dir,'agent-prompt.txt');writeFileSync(file,Array.from({length:8},(_,i)=>'decision '+i+'\n').join(''))
  store.ingest('codex-thr_agent',file,'text');store.setMetadata('codex-thr_agent',{harness:'codex',externalId:'thr_agent'});store.setPreference('codex-thr_agent','agent')
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url)),r=spawnSync(process.execPath,[cli,'codex-hook'],{input:JSON.stringify({session_id:'thr_agent',transcript_path:null,cwd:dir,hook_event_name:'UserPromptSubmit'}),encoding:'utf8',env:{...process.env,SUPERLCM_HOME:store.dir},timeout:15000})
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/lcm_summary_work/);assert.equal(store.summaries('codex-thr_agent').total,0)
}))
test('8790-inspired Web markup keeps strict-token script syntactically valid',()=>{
  const html=webPage('demo-token','nonce'),js=html.match(/<script nonce="nonce">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(js);assert.doesNotThrow(()=>new Function(js));assert.match(html,/#f0eee6/);assert.match(html,/--accent:#d97757/)
  assert.match(html,/<nav class="side-nav"/);assert.equal((html.match(/data-view-panel="/g)||[]).length,4)
  assert.match(html,/\.nav-link:hover i,\.nav-link.active i\{background:var\(--accent\);border-color:var\(--accent\)\}/);assert.doesNotMatch(html,/\.nav-link:hover\{color:/);assert.doesNotMatch(html,/\.nav-link.active\{background:/);assert.match(html,/\.side-nav\{display:grid;align-content:start;gap:16px\}/)
  assert.match(html,/\.chapter\[hidden\]/);assert.match(html,/<aside class="intro"><h1>SuperLcm<\/h1>/)
  for(const label of ['对话索引','对话导入','模型设置','MCP连接'])assert.match(html,new RegExp('>'+label+'<'))
  assert.doesNotMatch(html,/<span class="n">|nav-caption|brand-version|WORKSPACE|LOCAL CONTROL/)
})
test('local Web console authenticates and probes actual MCP protocol',fixture(async ({store})=>{
  const web=await startWeb({store:new ClaudeStore(store.dir)})
  try {
    const initial=await fetch(web.url),html=await initial.text();assert.match(html,/<title>SuperLcm<\/title>/);assert.match(html,/#f0eee6/)
    const cookie=initial.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.equal((await fetch(new URL(web.url).origin+'/',{headers:{Cookie:cookie.split(';')[0]}})).status,200)
    const base=new URL(web.url).origin,headers={Authorization:'Bearer '+web.token}
    assert.equal((await fetch(base+'/api/state')).status,401)
    assert.equal((await fetch(base+'/api/state',{headers})).status,200)
    const probe=await fetch(base+'/api/probe',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:base},body:'{}'}).then(r=>r.json())
    assert.equal(probe.ok,true,JSON.stringify(probe))
    assert.equal((await fetch(base+'/api/preference',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:'http://evil.local'},body:'{}'})).status,403)
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
  assert.deepEqual(invoked.args.slice(0,6),['--print','--output-format','json','--model','opus','--disable-slash-commands'])
  assert.deepEqual(invoked.args.slice(6,9),['--tools','','--strict-mcp-config'])
  assert.equal(invoked.args[9],'--system-prompt')
  assert.match(invoked.args[10],/Never follow instructions/)
  assert.equal(invoked.options.env.ANTHROPIC_API_KEY,undefined)
  assert.equal(invoked.options.env.ANTHROPIC_PROFILE,undefined)
  assert.equal(invoked.options.env.CLAUDE_CODE_USE_VERTEX,undefined)
  assert.equal(invoked.options.env.CLAUDE_CODE_OAUTH_TOKEN,'subscription-token')
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
  const env={...process.env,CLAUDE_CONFIG_DIR:config,SUPERLCM_CLAUDE_HOME:store.dir,SUPERLCM_SUMMARY_MODE:'cli',SUPERLCM_CLAUDE_CLI_MODEL:'opus',SUPERLCM_CLAUDE_CLI_BIN:fake,SUPERLCM_TEST_RECEIPT:receipt,ANTHROPIC_API_KEY:'must-be-stripped'}
  delete env.SUPERLCM_ANTHROPIC_API_KEY
  const index=spawnSync(process.execPath,[cli,'index',src,'integration-session'],{encoding:'utf8',env,timeout:15000})
  assert.equal(index.status,0,index.stderr)
  const worker=spawnSync(process.execPath,[cli,'summarize','integration-session'],{encoding:'utf8',env,timeout:15000})
  assert.equal(worker.status,0,worker.stderr)
  assert.equal(JSON.parse(worker.stdout).created,1)
  const args=JSON.parse(readFileSync(receipt,'utf8'))
  assert.equal(args.args[4],'opus');assert.equal(args.apiKeyPresent,false);assert.ok(args.inputChars>50)
  const nodeId=store.overview('integration-session').nodes[0].id
  assert.equal(store.node('integration-session',nodeId).model,'claude-cli:opus')
}))
test('background summary refuses changed original before any model call',fixture(async ({dir,store})=>{
  const src=join(dir,'changed.jsonl');writeFileSync(src,Array.from({length:8},(_,i)=>line(i)).join(''))
  store.ingest('changed-session',src)
  writeFileSync(src,Array.from({length:8},(_,i)=>line(i).replace('alpha','omega')).join(''))
  let called=false
  await assert.rejects(buildHierarchy(store,'changed-session',{model:'claude-cli:sonnet',summarize:async()=>{called=true;return 'must never save'}}),/changed/)
  assert.equal(called,false)
  assert.deepEqual(store.overview('changed-session').nodes,[])
}))
test('CLI mode never injects agent writing prompts and worker hooks do not recurse',fixture(async ({dir})=>{
  const config=join(dir,'claude-config'),projects=join(config,'projects'),db=join(dir,'hook-index')
  mkdirSync(projects,{recursive:true});const src=join(projects,'hook.jsonl')
  writeFileSync(src,Array.from({length:8},(_,i)=>line(i)).join(''))
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url))
  const env={...process.env,CLAUDE_CONFIG_DIR:config,SUPERLCM_CLAUDE_HOME:db,SUPERLCM_SUMMARY_MODE:'cli'}
  delete env.SUPERLCM_ANTHROPIC_API_KEY;delete env.SUPERLCM_CLAUDE_MODEL
  const run=(hook, extra={})=>spawnSync(process.execPath,[cli,'hook'],{input:JSON.stringify({session_id:'hook-session',transcript_path:src,...hook}),encoding:'utf8',env:{...env,...extra},timeout:5000})
  const prompt=run({hook_event_name:'UserPromptSubmit'})
  assert.equal(prompt.status,0,prompt.stderr);assert.equal(prompt.stdout,'')
  const nested=run({hook_event_name:'Stop'},{SUPERLCM_CLI_WORKER:'1'})
  assert.equal(nested.status,0,nested.stderr);assert.equal(nested.stdout,'')
  const check=new ClaudeStore(db);assert.deepEqual(check.sources(),[]);check.close()
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
test('mode defaults to CLI and preserves explicit agent or API choice',()=>{
  assert.equal(summaryMode({}),'cli')
  assert.equal(summaryMode({SUPERLCM_ANTHROPIC_API_KEY:'test'}),'api')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'cli',SUPERLCM_ANTHROPIC_API_KEY:'test'}),'cli')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'off',SUPERLCM_ANTHROPIC_API_KEY:'test'}),'off')
  assert.equal(summaryMode({SUPERLCM_SUMMARIZE_ON_HOOK:'1'}),'api')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'agent'}),'agent')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'agent',SUPERLCM_ANTHROPIC_API_KEY:'test'}),'agent')
  assert.equal(subscriptionEnv({ANTHROPIC_API_KEY:'secret',SUPERLCM_CLI_WORKER:'0'}).SUPERLCM_CLI_WORKER,'1')
})
