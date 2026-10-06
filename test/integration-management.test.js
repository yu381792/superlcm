import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {ClaudeStore} from '../src/store.js'
import {captureDshPacket,projectDshEvent} from '../src/dsh.js'
import {summarySource} from '../src/summary-source.js'
import {buildHierarchy,summaryWork} from '../src/summarize.js'
import {disconnectPreview,applyDisconnect} from '../src/disconnect.js'
import {dshSetupPreview,applyDshSetup} from '../src/dsh-setup.js'
import {dshConfiguration} from '../src/dsh-catalog.js'
import {dshEntries,inspectDshTree} from '../src/dsh-connection.js'
import {enableSummaryOnly} from '../src/integration.js'
import {script} from '../src/harness.js'
import {startWeb} from '../src/web.js'
const fixture=t=>{const dir=mkdtempSync(join(tmpdir(),'slcm-summary-only-'));const store=new ClaudeStore(join(dir,'archive'));t.after(()=>store.close());return {dir,store}}
const event=(seq,type,text,extra={})=>({seq,type,time:seq+1,surfaceOp:'append',data:{content:[{type:'text',text}],...extra}})
const packet=(id,events)=>({header:{id},records:events.map(e=>projectDshEvent(id,e,'preview only'))})

test('DSH uses full messages and preserves requested versus failed tools',()=>{
  const id='source',call=event(0,'assistant/message','',{message:{content:[{type:'tool-call',id:'c1',name:'deploy',arguments:'{}'}]}})
  const result=event(1,'tool/result','',{message:{toolCallId:'c1',isError:true,content:[{type:'text',text:'Permission denied'}]}})
  assert.match(summarySource(JSON.stringify(projectDshEvent(id,call,''))),/tool call deploy; id=c1; requested/)
  assert.match(summarySource(JSON.stringify(projectDshEvent(id,result,''))),/id=c1; ERROR \/ failed/)
  const original=event(2,'user/message','x'.repeat(20000)+' KEEP THE EXCEPTION')
  const record=projectDshEvent(id,original,original.data.content[0].text)
  assert.doesNotMatch(record.content,/KEEP THE EXCEPTION/)
  assert.match(summarySource(JSON.stringify(record)),/KEEP THE EXCEPTION/)
  const checkpoint={...original,data:{...original.data,source:{kind:'compact-checkpoint'}}}
  assert.equal(summarySource(JSON.stringify(projectDshEvent(id,checkpoint,''))),'')
})

test('DSH archive hierarchy covers gaps without treating old native envelopes as covered',async t=>{
  const {store}=fixture(t),id='gaps'
  const events=Array.from({length:9},(_,i)=>event(i,i%2?'assistant/message':'user/message','source '+i))
  const {session}=captureDshPacket(store,packet(id,events))
  store.setHarnessSetting('dsh','api','fixture','openai','http://127.0.0.1:9/v1')
  store.db.exec("CREATE TABLE IF NOT EXISTS dsh_node_sources(session TEXT,id TEXT,seq INTEGER,PRIMARY KEY(session,id,seq)); CREATE TABLE IF NOT EXISTS dsh_shared_nodes(session TEXT,id TEXT,visible INTEGER,PRIMARY KEY(session,id));")
  store.addNode({session,id:'dsh-native-old',level:0,first:0,last:7,children:[],summary:'Old exact selected facts only.',digest:'old',model:'native'})
  store.db.prepare('INSERT INTO dsh_shared_nodes VALUES(?,?,1)').run(session,'dsh-native-old')
  for(const seq of [0,7])store.db.prepare('INSERT INTO dsh_node_sources VALUES(?,?,?)').run(session,'dsh-native-old',seq)
  const work=summaryWork(store,session,{batchSize:2})
  assert.deepEqual(work.source_records,[1,2])
  assert.doesNotMatch(work.content,/source 0|source 7/)
  const before=readFileSync(store.source(session).path)
  const made=await buildHierarchy(store,session,{model:'fixture',batchSize:2,summarize:async text=>{assert.match(text,/source|facts/);return 'A faithful archive summary with exact source references.'}})
  assert.ok(made.created>0)
  assert.equal(store.stats(session).summarized_records,8)
  assert.equal(store.stats(session).unsummarized_records,1)
  assert.deepEqual(readFileSync(store.source(session).path),before)
  assert.equal(store.nodeRows(session,0).some(n=>n.id.startsWith('dsh-native-')),false)
})

test('cancel or tuning change fences a pending background result',async t=>{
  const {store,dir}=fixture(t),file=join(dir,'s.jsonl');writeFileSync(file,Array.from({length:4},(_,i)=>JSON.stringify({role:'user',content:'decision '+i})).join('\n')+'\n')
  store.ingest('s',file);store.setMetadata('s',{harness:'codex',externalId:'s'});store.setHarnessSetting('codex','api','fixture','openai','http://127.0.0.1:9/v1')
  let calls=0
  const result=await buildHierarchy(store,'s',{model:'fixture',batchSize:2,summarize:async()=>{calls++;store.setIntegrationEnabled('codex',false);return 'Late result that must not be saved.'}})
  assert.equal(result.stopped,'settings-changed');assert.equal(calls,1);assert.equal(store.nodeRows('s',0).length,0)
  store.setIntegrationEnabled('codex',true)
  const changed=await buildHierarchy(store,'s',{model:'fixture',batchSize:2,summarize:async()=>{store.setTuning({...store.tuning(),target_tokens:null,target_chars:24000});return 'Old granularity must not continue its backlog.'}})
  assert.equal(changed.stopped,'settings-changed');assert.equal(store.nodeRows('s',0).length,0)
})

test('Pi disconnect moves only its extension, keeps archives, and reconnect preserves explicit off',async t=>{
  const {store,dir}=fixture(t),env={...process.env,PI_CODING_AGENT_DIR:join(dir,'pi')},folder=join(env.PI_CODING_AGENT_DIR,'extensions');mkdirSync(folder,{recursive:true})
  const file=join(folder,'superlcm.ts'),other=join(folder,'other.ts');writeFileSync(file,'// SuperLcm for Pi\n// fixture');writeFileSync(other,'unrelated')
  const before=store.storageStats(),plan=await disconnectPreview(store,'pi',{env})
  const result=await applyDisconnect(store,'pi',plan.revision,{env})
  assert.equal(result.configuration_verified,true);assert.equal(existsSync(file),false);assert.equal(readFileSync(other,'utf8'),'unrelated')
  assert.equal(existsSync(join(result.backup,'superlcm.ts')),true);assert.equal(store.integrationEnabled('pi'),false);const after=store.storageStats();for(const key of ['conversations','records','summaries','originals_bytes'])assert.equal(after[key],before[key])
  store.setHarnessSetting('dsh','off');store.setIntegrationEnabled('dsh',false);enableSummaryOnly(store,'dsh',env);assert.equal(store.harnessSetting('dsh').mode,'off')
})

test('Claude cancellation preserves mixed hooks and refuses an MCP swapped during disable',async t=>{
  const {store,dir}=fixture(t),env={...process.env,HOME:dir,CLAUDE_CONFIG_DIR:join(dir,'claude')};mkdirSync(env.CLAUDE_CONFIG_DIR,{recursive:true})
  const settings=join(env.CLAUDE_CONFIG_DIR,'settings.json'),mcp=join(env.CLAUDE_CONFIG_DIR,'.claude.json')
  const own={type:'stdio',command:process.execPath,args:[script,'mcp'],env:{SUPERLCM_HOME:store.dir}}
  writeFileSync(settings,JSON.stringify({env:{KEEP:'yes'},hooks:{Stop:[{hooks:[{type:'command',command:"node '"+script+"' hook"},{type:'command',command:'other-hook'}]}]}}))
  writeFileSync(mcp,JSON.stringify({mcpServers:{superlcm:own,other:{command:'unrelated'}}}))
  let enabled=true,swap=true
  const run=async (_bin,args)=>{
    if(args[0]==='plugin'&&args[1]==='list')return {stdout:JSON.stringify([{id:'superlcm@superlcm',scope:'user',enabled,version:'0.5.13'}])}
    if(args[0]==='plugin'&&args[1]==='disable'){enabled=false;if(swap)writeFileSync(mcp,JSON.stringify({mcpServers:{superlcm:{command:'foreign'},other:{command:'unrelated'}}}));return {stdout:''}}
    if(args[0]==='mcp'&&args[1]==='remove'){const c=JSON.parse(readFileSync(mcp));delete c.mcpServers.superlcm;writeFileSync(mcp,JSON.stringify(c));return {stdout:''}}
    throw Error('unexpected '+args.join(' '))
  }
  let plan=await disconnectPreview(store,'claude-code',{env,runCommand:run})
  await assert.rejects(applyDisconnect(store,'claude-code',plan.revision,{env,runCommand:run}),/MCP 配置已变化/)
  assert.equal(JSON.parse(readFileSync(mcp)).mcpServers.superlcm.command,'foreign')
  swap=false;writeFileSync(mcp,JSON.stringify({mcpServers:{superlcm:own,other:{command:'unrelated'}}}));plan=await disconnectPreview(store,'claude-code',{env,runCommand:run})
  const result=await applyDisconnect(store,'claude-code',plan.revision,{env,runCommand:run});assert.equal(result.configuration_verified,true)
  const kept=JSON.parse(readFileSync(settings));assert.equal(kept.env.KEEP,'yes');assert.deepEqual(kept.hooks.Stop[0].hooks,[{type:'command',command:'other-hook'}]);assert.equal(JSON.parse(readFileSync(mcp)).mcpServers.other.command,'unrelated')
})

test('Claude cached host module cannot submit after cancellation or a settings change',t=>{
  const {store,dir}=fixture(t),file=join(dir,'s.jsonl');writeFileSync(file,Array.from({length:4},(_,i)=>JSON.stringify({role:'user',content:'decision '+i})).join('\n')+'\n')
  store.ingest('s',file);store.setMetadata('s',{harness:'claude-code',externalId:'s'});store.setHarnessSetting('claude-code','cli')
  const env={...process.env,SUPERLCM_HOME:store.dir,SUPERLCM_SEGMENT_MESSAGES:'2'}
  const run=(cmd,input='')=>{const r=spawnSync(process.execPath,['src/cli.js',cmd,'s'],{env,input,encoding:'utf8'});return JSON.parse(r.stdout)}
  const claim=run('summary-claim');assert.ok(claim.work)
  store.setIntegrationEnabled('claude-code',false)
  assert.equal(run('summary-save',JSON.stringify({batch_id:claim.work.batch_id,summary:'Late valid response that must not be written.'})).none,'Integration is disconnected')
  assert.equal(run('summary-claim').none,'Integration is disconnected');assert.equal(store.hostWriter('s'),false);assert.equal(store.nodeRows('s',0).length,0)
  store.setIntegrationEnabled('claude-code',true);const retry=run('summary-claim');assert.ok(retry.work);store.setHarnessSetting('claude-code','cli','different')
  assert.match(run('summary-save',JSON.stringify({batch_id:retry.work.batch_id,summary:'Response from the old settings should not be saved.'})).error,/setting changed/)
  assert.equal(store.nodeRows('s',0).length,0)
})

test('real DSH setup and disconnect retain configured models and native compaction without selecting a compression model',async t=>{
  const {store,dir}=fixture(t),env={...process.env,DSH_HOME:join(dir,'dsh')}
  for(const name of ['web','acp']){
    const folder=join(env.DSH_HOME,'profiles',name);mkdirSync(folder,{recursive:true})
    writeFileSync(join(folder,'package.json'),JSON.stringify({name:'fixture-'+name,private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base']}},dependencies:{}}))
    writeFileSync(join(folder,'cordis.patch.yml'),'# keep unrelated comment\n- id: agent-default-model\n  config:\n    provider: fixture\n    model: original-model\n')
  }
  const p=await dshSetupPreview(store,{env});assert.equal(p.can_apply,true);assert.equal(p.mode,'summary-only');assert.equal(p.model,null)
  const result=await applyDshSetup(store,p.revision,{env});assert.equal(result.native_compaction,true)
  let configuration=await dshConfiguration({env})
  for(const row of configuration.profiles){assert.equal(inspectDshTree(row.tree).archive_only,true);assert.equal(inspectDshTree(row.tree).configured,true);assert.ok(dshEntries(row.tree).some(e=>e.name==='@deepseek-ai/dsh-compaction-basic'));assert.ok(row.patch.includes('# keep unrelated comment'));assert.equal(dshEntries(row.tree).find(e=>e.id==='agent-default-model').config.model,'original-model')}
  const off=await disconnectPreview(store,'dsh',{env});const disconnected=await applyDisconnect(store,'dsh',off.revision,{env});assert.equal(disconnected.configuration_verified,true)
  configuration=await dshConfiguration({env})
  for(const row of configuration.profiles){assert.equal(inspectDshTree(row.tree).configured,false);assert.ok(dshEntries(row.tree).some(e=>e.name==='@deepseek-ai/dsh-compaction-basic'));assert.equal(dshEntries(row.tree).some(e=>e.name==='superlcm'),false);assert.equal(dshEntries(row.tree).find(e=>e.id==='agent-default-model').config.model,'original-model')}
})

test('a one-off API catch-up also stops after disconnect instead of finishing the backlog',async t=>{
  const {createServer}=await import('node:http'),{spawn}=await import('node:child_process')
  const {store,dir}=fixture(t),file=join(dir,'one-off.jsonl');writeFileSync(file,Array.from({length:8},(_,i)=>JSON.stringify({role:'user',content:'decision '+i})).join('\n')+'\n')
  store.ingest('one-off',file);store.setMetadata('one-off',{harness:'codex',externalId:'one-off'})
  let calls=0
  const server=createServer(async(req,res)=>{for await(const _ of req){};calls++;store.setIntegrationEnabled('codex',false);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'A valid late summary that should be discarded.'},finish_reason:'stop'}]}))})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  store.setHarnessSetting('codex','api','fixture','openai','http://127.0.0.1:'+server.address().port+'/v1')
  const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['src/cli.js','summarize','one-off','--backend','api'],{env:{...process.env,SUPERLCM_HOME:store.dir,SUPERLCM_SEGMENT_MESSAGES:'2'},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('exit',code=>resolve({code,out,err}))})
  assert.equal(result.code,0,result.err);assert.equal(JSON.parse(result.out).stopped,'settings-changed');assert.equal(calls,1);assert.equal(store.nodeRows('one-off',0).length,0)
})

test('cancellation during final original verification is fenced inside the node transaction',async t=>{
  const {store,dir}=fixture(t),file=join(dir,'race.jsonl');writeFileSync(file,Array.from({length:4},(_,i)=>JSON.stringify({role:'user',content:'decision '+i})).join('\n')+'\n')
  store.ingest('race',file);store.setMetadata('race',{harness:'codex',externalId:'race'})
  let returned=false,changed=false;const exact=store.exact.bind(store)
  store.exact=(...args)=>{const value=exact(...args);if(returned&&!changed){changed=true;store.setIntegrationEnabled('codex',false)}return value}
  await assert.rejects(buildHierarchy(store,'race',{model:'fixture',batchSize:2,summarize:async()=>{returned=true;return 'The result must not commit after the setting changes.'}}),/setting changed/)
  assert.equal(changed,true);assert.equal(store.nodeRows('race',0).length,0)
})
