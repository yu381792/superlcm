import './env.mjs'
import { preferredNode } from '../src/runtime.js'
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
import { openConnection,recordToolCall,closeConnection,connectionEvidence } from '../src/connections.js'
import { probeClaudeConnection } from '../src/claude-connection.js'
import { script } from '../src/harness.js'
import { startWeb } from '../src/web.js'
const fixture=fn=>async t=>{const dir=mkdtempSync(join(tmpdir(),'slcm-flow-')),store=new ClaudeStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});await fn({store,dir})}
async function seed(store,dir){for(const [session,harness] of [['a','codex'],['b','claude-code'],['c','pi']]){const file=join(dir,session+'.jsonl');writeFileSync(file,Array.from({length:8},(_,i)=>JSON.stringify({role:i%2?'assistant':'user',content:session+' decision '+i})).join('\n')+'\n');store.ingest(session,file);store.setMetadata(session,{harness,externalId:session,name:session+' title'});}await buildHierarchy(store,'a',{model:'fixture',summarize:async()=> 'Original source decisions saved before delivery.'})}
test('connection evidence excludes probes, failed tools, closed peers and stale records',fixture(({store})=>{
 const probe=openConnection(store,'claude-code',{diagnostic:true});recordToolCall(store,probe,'lcm_sessions',true);assert.equal(connectionEvidence(store,'claude-code').state,'not_observed')
 const client=openConnection(store,'claude-code');assert.equal(connectionEvidence(store,'claude-code').state,'mcp_loaded');recordToolCall(store,client,'bad-tool',false);assert.equal(connectionEvidence(store,'claude-code').state,'mcp_loaded');recordToolCall(store,client,'lcm_sessions',true);assert.equal(connectionEvidence(store,'claude-code').state,'tool_verified');assert.equal(connectionEvidence(store,'codex').state,'not_observed');closeConnection(store,client);assert.equal(connectionEvidence(store,'claude-code').state,'not_observed');assert.equal(connectionEvidence(store,'claude-code').last_tool,'lcm_sessions')
 openConnection(store,'codex',{now:Date.now()-60000});assert.equal(connectionEvidence(store,'codex').state,'not_observed')
}))
test('real stdio lcm_continue call returns the handoff and records the successful invocation',fixture(async({store,dir})=>{
 await seed(store,dir);const code=store.metadata('a').code;const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'claude-code-fixture'}}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'lcm_continue',arguments:{conversation:'#'+code}}}]
 const result=spawnSync(process.execPath,[script,'mcp'],{env:{...process.env,SUPERLCM_HOME:dir},input:messages.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr)
 const response=result.stdout.trim().split('\n').map(x=>JSON.parse(x)).find(x=>x.id===2);assert.equal(response.result.isError,undefined,JSON.stringify(response))
 const packet=JSON.parse(response.result.content[0].text);assert.equal(packet.source.session,'a');assert.match(packet.content,/a decision 7/)
 assert.equal(connectionEvidence(store,'claude-code').last_tool,'lcm_continue');assert.equal(connectionEvidence(store,'claude-code').state,'not_observed','stdio process has closed')
}))
test('Claude runtime check uses native status not server self-test and sends no prompt',fixture(async({store})=>{
 const calls=[],registration={found:true,enabled:true,config:{command:preferredNode().path,args:[script,'mcp'],env:{SUPERLCM_HOME:store.dir}}};let receivedEnv
 const spawnProcess=(bin,args,options)=>{receivedEnv=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.superlcm.env;const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,kill(){this.exitCode=0}});child.stdin.on('data',raw=>{const req=JSON.parse(raw);calls.push(req.request.subtype);const response=req.request.subtype==='initialize'?{}:{mcpServers:[{name:'superlcm',status:'connected',tools:[{name:'lcm_context'}]}]};queueMicrotask(()=>child.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:req.request_id,response}})+'\n'))});return child}
 const result=await probeClaudeConnection(store,{registration,spawnProcess});assert.deepEqual(calls,['initialize','mcp_status']);assert.equal(receivedEnv.SUPERLCM_DIAGNOSTIC,'1');assert.equal(result.ok,true);assert.equal(result.existing_session_verified,false);assert.equal(result.scope,'claude-runtime-probe');assert.equal(result.tool_count,1)
}))
test('connection Web route returns native probe result and independent observed state',fixture(async({store})=>{
 const web=await startWeb({store:new ClaudeStore(store.dir),discovery:async()=>[],claudeProbe:async()=>({ok:true,scope:'claude-runtime-probe',existing_session_verified:false})});const base=new URL(web.url).origin,headers={Authorization:'Bearer '+web.token,'Content-Type':'application/json'}
 try{const r=await fetch(base+'/api/connection-check',{method:'POST',headers,body:JSON.stringify({harness:'claude-code'})});assert.equal(r.status,200);assert.equal((await r.json()).scope,'claude-runtime-probe');const x=await fetch(base+'/api/connections',{headers}).then(r=>r.json());assert.equal(x.connections.find(r=>r.harness==='claude-code').evidence.state,'not_observed')}finally{await web.close()}
}))

