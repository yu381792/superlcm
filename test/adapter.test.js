import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore, importFile } from '../src/store.js'
import { buildHierarchy, summaryWork, saveAgentSummary } from '../src/summarize.js'
import { call, startServer, tools } from '../src/mcp.js'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { spawnSync } from 'node:child_process'
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
  assert.equal(tools.length,11)
  assert.deepEqual(await call(store,'lcm_sessions'),[])
  input.end();await new Promise(r=>server.once('close',r));lines.close()
}))

test('agent-written summaries create verified hierarchical DAG without an API key',fixture(async ({dir,store})=>{
  const src=join(dir,'agent.jsonl');writeFileSync(src,Array.from({length:32},(_,i)=>line(i)).join(''))
  assert.equal(store.ingest('agent-session',src).added,32)
  const first=await call(store,'lcm_summary_work',{session:'agent-session'})
  assert.equal(first.level,0);assert.equal(first.first,0);assert.equal(first.last,7)
  assert.equal((await call(store,'lcm_save_summary',{session:'agent-session',batch_id:first.batch_id,summary:'Decisions 0–7 concern alpha project.'})).created,true)
  assert.equal(saveAgentSummary(store,'agent-session',first.batch_id,'Duplicate summary is ignored.').created,false)
  let work=summaryWork(store,'agent-session'),count=1
  while(work){saveAgentSummary(store,'agent-session',work.batch_id,`Summary level ${work.level} from event ${work.first} to ${work.last}.`);count++;work=summaryWork(store,'agent-session');if(count>10)throw Error('summary loop did not converge')}
  assert.equal(count,5);assert.equal(store.overview('agent-session').nodes[0].level,1)
  assert.equal(store.doctor('agent-session').issues.length,0)
  assert.rejects(call(store,'lcm_save_summary',{session:'agent-session',batch_id:'fake',summary:'Fabricated summary content.'}),/Batch changed/)
}))
test('agent summary refuses changed original source',fixture(async ({dir,store})=>{
  const src=join(dir,'changed.jsonl');writeFileSync(src,Array.from({length:8},(_,i)=>line(i)).join(''))
  store.ingest('changed-session',src);const work=summaryWork(store,'changed-session')
  writeFileSync(src,Array.from({length:8},(_,i)=>line(i).replace('alpha','omega')).join(''))
  assert.throws(()=>saveAgentSummary(store,'changed-session',work.batch_id,'Facts must reflect verified original content.'),/changed/)
}))

test('agent hook nudges locally, explicit agent mode wins over legacy API flag',fixture(async ({dir})=>{
  const config=join(dir,'claude-config'),projects=join(config,'projects'),db=join(dir,'hook-index')
  mkdirSync(projects,{recursive:true});const src=join(projects,'hook.jsonl')
  writeFileSync(src,Array.from({length:8},(_,i)=>line(i)).join(''))
  const hook={hook_event_name:'UserPromptSubmit',session_id:'hook-session',transcript_path:src}
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url))
  const env={...process.env,CLAUDE_CONFIG_DIR:config,SUPERLCM_CLAUDE_HOME:db,SUPERLCM_SUMMARY_MODE:'agent',SUPERLCM_SUMMARIZE_ON_HOOK:'1'}
  const run=()=>spawnSync(process.execPath,[cli,'hook'],{input:JSON.stringify(hook),encoding:'utf8',env,timeout:5000})
  const result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/lcm_summary_work/);assert.doesNotMatch(result.stderr,/api mode/)
  env.SUPERLCM_SUMMARY_MODE='off';const off=run();assert.equal(off.status,0,off.stderr);assert.equal(off.stdout,'')
}))
