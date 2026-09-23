import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync, chmodSync, readFileSync } from 'node:fs'
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
  assert.equal(tools.length,9)
  assert.equal(tools.some(tool=>['lcm_summary_work','lcm_save_summary'].includes(tool.name)),false)
  assert.deepEqual(await call(store,'lcm_sessions'),[])
  input.end();await new Promise(r=>server.once('close',r));lines.close()
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
  const index=spawnSync(process.execPath,[cli,'index',src,'integration-session'],{encoding:'utf8',env,timeout:5000})
  assert.equal(index.status,0,index.stderr)
  const worker=spawnSync(process.execPath,[cli,'summarize','integration-session'],{encoding:'utf8',env,timeout:5000})
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
test('mode chooses CLI subscription by default, separate API only with dedicated key',()=>{
  assert.equal(summaryMode({}),'cli')
  assert.equal(summaryMode({SUPERLCM_ANTHROPIC_API_KEY:'test'}),'api')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'cli',SUPERLCM_ANTHROPIC_API_KEY:'test'}),'cli')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'off',SUPERLCM_ANTHROPIC_API_KEY:'test'}),'off')
  assert.equal(summaryMode({SUPERLCM_SUMMARIZE_ON_HOOK:'1'}),'api')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'agent'}),'cli')
  assert.equal(summaryMode({SUPERLCM_SUMMARY_MODE:'agent',SUPERLCM_ANTHROPIC_API_KEY:'test'}),'api')
  assert.equal(subscriptionEnv({ANTHROPIC_API_KEY:'secret',SUPERLCM_CLI_WORKER:'0'}).SUPERLCM_CLI_WORKER,'1')
})
