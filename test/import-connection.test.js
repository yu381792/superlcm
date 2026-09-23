import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { ClaudeStore } from '../src/store.js'
import { buildHierarchy } from '../src/summarize.js'
import { call } from '../src/mcp.js'
import { contextPacket,issuePending } from '../src/context.js'
import { openConnection,recordToolCall,closeConnection,connectionEvidence } from '../src/connections.js'
import { probeClaudeConnection } from '../src/claude-connection.js'
import { script } from '../src/harness.js'
import { page } from '../src/web-page.js'
import { startWeb } from '../src/web.js'
const fixture=fn=>async t=>{const dir=mkdtempSync(join(tmpdir(),'slcm-flow-')),store=new ClaudeStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});await fn({store,dir})}
async function seed(store,dir){for(const [session,harness] of [['a','codex'],['b','claude-code'],['c','pi']]){const file=join(dir,session+'.jsonl');writeFileSync(file,Array.from({length:8},(_,i)=>JSON.stringify({role:i%2?'assistant':'user',content:session+' decision '+i})).join('\n')+'\n');store.ingest(session,file);store.setMetadata(session,{harness,externalId:session,name:session+' title'});}await buildHierarchy(store,'a',{model:'fixture',summarize:async()=> 'Original source decisions saved before delivery.'})}
test('indexed import snapshots content and target MCP receives only its own packet',fixture(async({store,dir})=>{
 await seed(store,dir);const original=contextPacket(store,'a');const receipt=store.enqueue('a','b','mcp');assert.equal(receipt.status,'pending');assert.equal(store.deliveries()[0].status,'pending');assert.equal(issuePending(store,'claude-code','b').length,0)
 store.db.prepare('UPDATE nodes SET summary=? WHERE session=?').run('Changed after enqueue; must not replace selected imported snapshot.','a')
 assert.equal(store.enqueue('a','b','mcp').deduplicated,true);assert.equal((await call(store,'lcm_receive_context',{target:'c'})).packets.length,0)
 const read=await call(store,'lcm_receive_context',{target:'b'});assert.equal(read.packets.length,1);assert.equal(read.packets[0].content,original.content);assert.equal(read.packets[0].source.session,'a');assert.equal(store.summaries('b').total,0,'source summaries are not merged into target DAG')
 assert.equal(store.deliveries()[0].status,'mcp_received');assert.equal(store.deliveries()[0].target.name,'b title');assert.equal((await call(store,'lcm_receive_context',{target:'b'})).packets.length,0)
}))
test('hook import is pending until emitted; unsupported hooks fail instead of silently queueing',fixture(async({store,dir})=>{
 await seed(store,dir);assert.throws(()=>store.enqueue('a','c','hook'),/自动 hook/);store.enqueue('a','c','mcp');const receipt=store.enqueue('a','b','hook');const packets=issuePending(store,'claude-code','b');assert.equal(packets.length,1);assert.equal(store.deliveries().find(x=>x.id===receipt.id).issued_at,null);store.markIssued(receipt.id);assert.equal(store.deliveries().find(x=>x.id===receipt.id).status,'hook_issued');assert.equal(issuePending(store,'claude-code','b').length,0)
}))
test('connection evidence excludes probes, failed tools, closed peers and stale records',fixture(({store})=>{
 const probe=openConnection(store,'claude-code',{diagnostic:true});recordToolCall(store,probe,'lcm_sessions',true);assert.equal(connectionEvidence(store,'claude-code').state,'not_observed')
 const client=openConnection(store,'claude-code');assert.equal(connectionEvidence(store,'claude-code').state,'mcp_loaded');recordToolCall(store,client,'bad-tool',false);assert.equal(connectionEvidence(store,'claude-code').state,'mcp_loaded');recordToolCall(store,client,'lcm_sessions',true);assert.equal(connectionEvidence(store,'claude-code').state,'tool_verified');assert.equal(connectionEvidence(store,'codex').state,'not_observed');closeConnection(store,client);assert.equal(connectionEvidence(store,'claude-code').state,'not_observed');assert.equal(connectionEvidence(store,'claude-code').last_tool,'lcm_sessions')
 openConnection(store,'codex',{now:Date.now()-60000});assert.equal(connectionEvidence(store,'codex').state,'not_observed')
}))
test('real stdio tools call delivers receipt and records successful invocation',fixture(async({store,dir})=>{
 await seed(store,dir);store.enqueue('a','b','mcp');const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'claude-code-fixture'}}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'lcm_receive_context',arguments:{target:'b'}}}]
 const result=spawnSync(process.execPath,[script,'mcp'],{env:{...process.env,SUPERLCM_HOME:dir},input:messages.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);const response=result.stdout.trim().split('\n').map(x=>JSON.parse(x)).find(x=>x.id===2);assert.equal(response.result.isError,undefined,JSON.stringify(response));assert.equal(JSON.parse(response.result.content[0].text).packets.length,1);assert.equal(store.deliveries()[0].status,'mcp_received');assert.equal(connectionEvidence(store,'claude-code').last_tool,'lcm_receive_context');assert.equal(connectionEvidence(store,'claude-code').state,'not_observed','stdio process has closed')
}))
test('Claude runtime check uses native status not server self-test and sends no prompt',fixture(async({store})=>{
 const calls=[],registration={found:true,enabled:true,config:{command:process.execPath,args:[script,'mcp'],env:{SUPERLCM_HOME:store.dir}}};let receivedEnv
 const spawnProcess=(bin,args,options)=>{receivedEnv=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.superlcm.env;const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,kill(){this.exitCode=0}});child.stdin.on('data',raw=>{const req=JSON.parse(raw);calls.push(req.request.subtype);const response=req.request.subtype==='initialize'?{}:{mcpServers:[{name:'superlcm',status:'connected',tools:[{name:'lcm_context'}]}]};queueMicrotask(()=>child.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:req.request_id,response}})+'\n'))});return child}
 const result=await probeClaudeConnection(store,{registration,spawnProcess});assert.deepEqual(calls,['initialize','mcp_status']);assert.equal(receivedEnv.SUPERLCM_DIAGNOSTIC,'1');assert.equal(result.ok,true);assert.equal(result.existing_session_verified,false);assert.equal(result.scope,'claude-runtime-probe');assert.equal(result.tool_count,1)
}))
test('import view has no native collection and connection confirmation uses an immediate dialog',()=>{
 const html=page('token','nonce'),delivery=html.slice(html.indexOf('id="view-delivery"'),html.indexOf('id="view-summary"'));assert.doesNotMatch(delivery,/id="localSessions"|id="scanLocal"|data-index=/);assert.match(delivery,/从索引库导入/);assert.match(delivery,/directInstruction/);assert.match(delivery,/deliveryRoute/)
 assert.match(html,/<dialog id="setupDialog"/);assert.match(html,/\.showModal\(\)/);assert.doesNotMatch(html,/Promise\.all\(\[loadIndex\(true\),loadLocal/);new Function(html.match(/<script nonce="nonce">([\s\S]*?)<\/script>/)[1])
})
test('connection Web route returns native probe result and independent observed state',fixture(async({store})=>{
 const web=await startWeb({store:new ClaudeStore(store.dir),discovery:async()=>[],claudeProbe:async()=>({ok:true,scope:'claude-runtime-probe',existing_session_verified:false})});const base=new URL(web.url).origin,headers={Authorization:'Bearer '+web.token,'Content-Type':'application/json'}
 try{const r=await fetch(base+'/api/connection-check',{method:'POST',headers,body:JSON.stringify({harness:'claude-code'})});assert.equal(r.status,200);assert.equal((await r.json()).scope,'claude-runtime-probe');const x=await fetch(base+'/api/connections',{headers}).then(r=>r.json());assert.equal(x.connections.find(r=>r.harness==='claude-code').evidence.state,'not_observed')}finally{await web.close()}
}))

test('actual target hook emits the same saved navigation even beyond the old 2200-character limit',fixture(async({store,dir})=>{
 await seed(store,dir);store.setGlobalSetting('off');store.db.prepare('UPDATE nodes SET summary=? WHERE session=?').run('Source decision details. '.repeat(190),'a');const receipt=store.enqueue('a','b','hook'),expected=store.deliveryPacket({id:receipt.id});assert.ok(expected.content.length>2200)
 const result=spawnSync(process.execPath,[script,'hook','--home',dir],{env:{...process.env,SUPERLCM_SUMMARY_MODE:'off'},input:JSON.stringify({session_id:'b',hook_event_name:'UserPromptSubmit'}),encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.includes(expected.content));assert.equal(store.deliveries()[0].status,'hook_issued')
}))
