import './env.mjs'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore } from '../src/store.js'
import { summaryWork } from '../src/summarize.js'
import { paths,validModel } from '../src/runtime.js'
import { localConversations,indexLocalConversation } from '../src/local-conversations.js'
import { configFiles,hookInspection,script,matchingMcp,harnessConnections } from '../src/harness.js'
import { setupPreview,applySetup } from '../src/setup.js'
import { testHook } from '../src/diagnostics.js'
import { claudeModels } from '../src/model-catalog.js'
import { startWeb } from '../src/web.js'
import { call } from '../src/mcp.js'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
const fixture=fn=>async t=>{const dir=mkdtempSync(join(tmpdir(),'superlcm-dashboard-')),store=new ClaudeStore(join(dir,'index')),_small=store.db.prepare('INSERT INTO summary_tuning VALUES(1,12000,8,4)').run(),env={...process.env,HOME:dir,USERPROFILE:dir,CODEX_HOME:join(dir,'codex'),CLAUDE_CONFIG_DIR:join(dir,'claude')};t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});await fn({dir,store,env,t})}

test('DSH selected coverage UI uses effective counts, exact bands and plugin ownership', () => {
 const code=readFileSync(new URL('../src/web-client.js',import.meta.url),'utf8')
 const node={id:'summary',level:1,first:2,last:5,children:['leaf'],summary:'DSH native summary. Exact selected source records: 2, 4, 5. The range below is a reading envelope, not a claim that every intervening record was summarized.\nUseful navigation summary',source_records:[2,4,5],source_ranges:[{from:2,to:2},{from:4,to:5}]}
 const leaf={id:'leaf',level:0,first:2,last:2,summary:'Leaf summary',children:[],source_records:[2],source_ranges:[{from:2,to:2}]}
 const d={coverage:'selected-records',records:11,raw_records:5,summarized_records:3,unsummarized_records:2,summarized_to:8,summary_count:2,bands:[node,leaf],covered_ranges:node.source_ranges,unsummarized_ranges:[{from:8,to:8},{from:10,to:10}],latest_tail:{from:8,to:10,records:2},persistent_records:2,checkpoint_records:1,non_message_records:3,setting:{mode:'off',scope:'compaction-plugin'},backends:[]}
 const elements=new Map(['#rows','#listCount','#more'].map(key=>[key,{querySelectorAll:()=>[]}]))
 const context={state:{detail:d,open:new Set(),children:new Map(),rows:[{...d,session:'dsh-fixture',harness:'dsh',name:'DSH task'}],query:'',total:1,offset:null},t:(key,p={})=>key.replace(/\{([^}]+)\}/g,(_,k)=>p[k]),fmt:String,esc:String,writerLabel:()=> '关闭',mark:()=>'',ago:()=>'',delButton:()=>'',select:()=>{},$:key=>elements.get(key)}
 const sections=[code.slice(code.indexOf('const pct = (x, total)'),code.indexOf('// One clear action')),code.slice(code.indexOf('function generateButton('),code.indexOf('function openGenerate(')),code.slice(code.indexOf('function nodeHtml('),code.indexOf('async function ensureChildren(')),code.slice(code.indexOf('function renderList('),code.indexOf("$('#more').onclick"))]
 runInNewContext(sections.join('\n')+'\nthis.stripHtml=stripHtml;this.nodeHtml=nodeHtml;this.generateButton=generateButton;this.renderList=renderList',context)
 const strip=context.stripHtml(d)
 assert.match(strip,/SuperLcm 插件生成/);assert.doesNotMatch(strip,/摘要生成：关闭/)
 assert.match(strip,/最新 2 条尚未摘要/);assert.doesNotMatch(strip,/最新 3 条尚未摘要/)
 assert.match(strip,/已覆盖 3 条，未覆盖 2 条/)
 assert.match(strip,/left:72\.727%;width:9\.091%/);assert.match(strip,/left:90\.909%;width:9\.091%/)
 assert.doesNotMatch(strip,/left:0[^;]*;right:0|--p:/,'holes must not become one filled coverage envelope')
 assert.match(strip,/阅读范围 #2–#5；精确选中 3 条记录/)
 assert.equal((strip.match(/data-node=/g)||[]).length,2,'one clickable bar per real semantic node, including the leaf level')
 assert.match(strip,/lane-gap gap-mixed/,'mixed covered and pending regions must not be labelled fully covered')
 assert.match(strip,/历史消息已全部覆盖，最新 2 条待摘要/)
 const direct={...d,records:8,raw_records:8,summarized_records:8,unsummarized_records:0,latest_tail:null,covered_ranges:[{from:0,to:7}],unsummarized_ranges:[],bands:[{...node,first:0,last:7,source_ranges:[{from:0,to:7}]},{...leaf,first:0,last:3,source_ranges:[{from:0,to:3}]}]}
 const directStrip=context.stripHtml(direct)
 assert.match(directStrip,/data-cover-node="summary"/,'a missing lower layer links to the real summary covering its messages')
 assert.match(directStrip,/由第 2 层覆盖/)
 assert.match(directStrip,/有效消息已全部覆盖/)
 const missedStrip=context.stripHtml({...d,unsummarized_records:3,unsummarized_ranges:[{from:0,to:0},...d.unsummarized_ranges]})
 assert.match(missedStrip,/较早 1 条、最新 2 条消息待摘要/)
 assert.doesNotMatch(missedStrip,/历史消息已全部覆盖/,'a real historical hole must remain visible')
 assert.doesNotMatch(context.nodeHtml(node),/DSH native summary|Exact selected/)
 assert.match(context.nodeHtml(node),/Useful navigation summary/)
 context.state.open.add(node.id)
 assert.match(context.nodeHtml({...node,level:0}),/class="children"/,'navigation children remain expandable on a leaf model layer')
 assert.match(context.generateButton('生成摘要…'),/SuperLcm 插件生成/)
 assert.doesNotMatch(context.generateButton('生成摘要…'),/配置自定义 API|没有可用/)
 context.renderList();assert.match(elements.get('#rows').innerHTML,/width:60%/)
})
function transcript(env,h,id,name='Conversation'){const folder=configFiles(h,env).transcripts;mkdirSync(folder,{recursive:true});const path=join(folder,id+'.jsonl');const header=h==='codex'?{type:'session_meta',payload:{id}}:{sessionId:id,type:'custom-title',customTitle:name};writeFileSync(path,[header,...Array.from({length:8},(_,i)=>({role:i%2?'assistant':'user',content:name+' decision '+i,sessionId:id}))].map(x=>JSON.stringify(x)).join('\n')+'\n');return path}
test('real CLI IDs survive policy and workers, dangerous model strings fail',fixture(({store})=>{for(const model of ['opus[1m]','claude-fable-5-1[1m]','tianyi/glm-5.3-oc','opencode-go/deepseek-v4.1-flash']){assert.equal(validModel(model),true);store.setGlobalSetting('cli',model);assert.equal(store.globalSetting().model,model)}for(const model of ['--flag','$(whoami)','a b','a;cmd','a\nfoo'])assert.equal(validModel(model),false)}))
test('local conversations page by harness and index only a selected identity',fixture(async({env,store})=>{
 const a=transcript(env,'codex','a','Name A'),b=transcript(env,'codex','b','Name B');transcript(env,'claude-code','c','Name C')
 const page=localConversations(store,'codex',{env,limit:1});assert.equal(page.total,2);assert.equal(page.conversations.length,1);assert.equal(store.sources().length,0)
 assert.equal(page.next_offset,1);const next=localConversations(store,'codex',{env,limit:1,offset:1});assert.equal(next.next_offset,null)
 const selected=page.conversations[0];const saved=indexLocalConversation(store,'codex',selected.key,{env});assert.equal(saved.source.conversation_id,selected.conversation_id);assert.equal(store.sources().length,1);assert.equal(saved.summary_count,0)
 assert.equal(indexLocalConversation(store,'codex',selected.key,{env}).added,0)
 assert.throws(()=>indexLocalConversation(store,'claude-code',selected.key,{env}),/no longer available/)
 assert.throws(()=>indexLocalConversation(store,'codex','../../secrets',{env}),/Invalid/)
 assert.equal(localConversations(store,'claude-code',{env}).conversations[0].name,'Name C')
 store.setGlobalSetting('agent');const {work}=await call(store,'lcm_summary_task',{conversation:saved.session});assert.ok(work);assert.equal((await call(store,'lcm_summary_submit',{conversation:saved.session,batch_id:work.batch_id,summary:'This indexed conversation contains eight factual decision records.'})).saved,true)
 assert.equal(store.doctor(saved.session).issues.length,0)
}))
test('local scanning does not follow symlink files or directories',{skip:process.platform==='win32'},fixture(({env,dir,store})=>{const root=configFiles('codex',env).transcripts;mkdirSync(root,{recursive:true});const outside=join(dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'secret.jsonl'),'{}\n');symlinkSync(outside,join(root,'link'));symlinkSync(join(outside,'secret.jsonl'),join(root,'secret.jsonl'));assert.equal(localConversations(store,'codex',{env}).total,0)}))
test('guided setup preserves unrelated hooks, backs up, pins home and never trusts',fixture(async({env,dir,store})=>{
 const files=configFiles('codex',env);mkdirSync(env.CODEX_HOME,{recursive:true});writeFileSync(files.mcp,'# unrelated config\n');writeFileSync(files.hooks,JSON.stringify({description:'keep me',hooks:{Stop:[{hooks:[{type:'command',command:'echo keep-me'}]}]}}))
 const bin=join(dir,'codex-bin');writeFileSync(bin,'',{mode:0o700});env.SUPERLCM_CODEX_CLI_BIN=bin
 let reg=null,registered=0
 const runCommand=async(command,args)=>{if(args[1]==='get'){if(!reg)throw Error('absent');return {stdout:JSON.stringify({transport:reg,enabled:true})}}assert.equal(args[1],'add');registered++;reg={type:'stdio',command:process.execPath,args:[script,'mcp'],env:{SUPERLCM_HOME:store.dir}};writeFileSync(files.mcp,'# original preserved by simulated official CLI\n');return {stdout:''}}
 const options={env,runCommand},preview=await setupPreview(store,'codex',options);assert.equal(preview.can_apply,true);assert.equal(preview.hook_events_added.length,5);assert.equal(readFileSync(files.hooks,'utf8').includes('superlcm'),false)
 const applied=await applySetup(store,'codex',preview.revision,options);assert.equal(applied.saved,true);assert.equal(applied.trust_granted,false);assert.equal(applied.requires_review,true);assert.equal(registered,1);assert.equal(applied.backups.length,2)
 for(const b of applied.backups)assert.ok(existsSync(b.backup))
 const current=JSON.parse(readFileSync(files.hooks,'utf8'));assert.equal(current.description,'keep me');assert.equal(current.hooks.Stop.length,2);assert.equal(current.hooks.Stop[0].hooks[0].command,'echo keep-me');assert.ok(current.hooks.Stop[1].hooks[0].command.includes(store.dir))
 assert.equal(hookInspection('codex',env).status,'configured')
 const again=await setupPreview(store,'codex',options);assert.equal(again.hook_events_added.length,0);assert.equal(again.mcp_action,'preserve');await applySetup(store,'codex',again.revision,options);assert.equal(registered,1)
 const stale=await setupPreview(store,'codex',options);writeFileSync(files.hooks,JSON.stringify({...current,changed:true}));await assert.rejects(applySetup(store,'codex',stale.revision,options),/配置已变化/)
}))
test('setup refuses foreign same-name MCP and keeps native hook disabling',fixture(async({env,dir,store})=>{const bin=join(dir,'cli');writeFileSync(bin,'',{mode:0o700});env.SUPERLCM_CODEX_CLI_BIN=bin;const options={env,runCommand:async()=>({stdout:JSON.stringify({enabled:true,transport:{type:'stdio',command:'/foreign',args:[]}})})};const p=await setupPreview(store,'codex',options);assert.equal(p.can_apply,false);assert.match(p.blocker,/不覆盖/);const file=configFiles('claude-code',env).hooks;mkdirSync(env.CLAUDE_CONFIG_DIR,{recursive:true});writeFileSync(file,'{"disableAllHooks":true}');await assert.rejects(setupPreview(store,'claude-code',{env}),/禁用/)}))
test('real hook subprocesses write fixtures only, never invoke summarizers',fixture(async({env,store})=>{for(const h of ['codex','claude-code']){const result=await testHook(h,{env});assert.equal(result.ok,true);assert.equal(result.events,8);assert.equal(result.nodes,0);assert.equal(result.exit_code,0)}assert.equal(store.sources().length,0)}))
test('Claude catalog sends initialize only, without hooks, prompts or tools',async()=>{
 let seen,input='';const spawnProcess=(bin,args,options)=>{seen={bin,args,options};const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){this.killed=true},exitCode:null});child.stdin.on('data',chunk=>{input+=chunk;const req=JSON.parse(input);queueMicrotask(()=>child.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:req.request_id,response:{models:[{value:'runtime-only'}],account:{secret:'must-not-return'}}}})+'\n'))});return child}
 const models=await claudeModels({spawnProcess,env:{ANTHROPIC_API_KEY:'secret'}});assert.deepEqual(models,[{value:'runtime-only'}]);assert.equal(JSON.parse(input).request.subtype,'initialize');assert.equal(input.includes('"type":"user"'),false);assert.ok(seen.args.includes('--no-session-persistence'));assert.ok(seen.args.includes('{"disableAllHooks":true}'));assert.equal(seen.options.env.ANTHROPIC_API_KEY,'secret')
})
test('authenticated Web workflow detects, indexes, pages nodes and gates setup',fixture(async({env,store})=>{
 transcript(env,'codex','web','Web Local');const spawned=[];const web=await startWeb({store:new ClaudeStore(store.dir),env,discovery:async()=>[{harness:'codex',supported:true,detected:true}],catalog:async()=>({models:[{id:'runtime-only'}],status:'live'}),spawnWorker:(...args)=>{spawned.push(args);return {unref(){}}}});const base=new URL(web.url).origin,headers={Authorization:'Bearer '+web.token};const post=(path,data)=>fetch(base+path,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(data)})
 try {
  const rows=await fetch(base+'/api/local-conversations?harness=codex',{headers}).then(r=>r.json());assert.equal(rows.total,1);assert.equal(store.sources().length,0)
  const result=await post('/api/index-local',{harness:'codex',key:rows.conversations[0].key}).then(r=>r.json());assert.equal(result.source.conversation_id,'web');assert.equal(result.summary_count,0)
  const list=await fetch(base+'/api/conversations',{headers}).then(r=>r.json());assert.equal(list.total,1);assert.deepEqual(list.groups.map(g=>g.harness),['codex'])
  assert.equal((await fetch(base+'/api/conversations?harness=claude-code',{headers}).then(r=>r.json())).total,0)
  const detail=await fetch(base+'/api/conversation?session='+result.session,{headers}).then(r=>r.json());assert.equal(detail.summary_count,0);assert.deepEqual(detail.bands,[]);assert.equal(detail.summarizing,false)
  const events=await fetch(base+'/api/events?session='+result.session+'&from=0&to=5',{headers}).then(r=>r.json());assert.ok(events.events.length>0)
  const handoff=await fetch(base+'/api/continue?session='+result.session,{headers}).then(r=>r.json());assert.match(handoff.line,/#[0-9a-f]{5}/);assert.match(handoff.packet.content,/No summaries yet/)
  assert.equal((await post('/api/rename',{session:result.session,name:'Renamed'})).status,200);assert.equal(store.metadata(result.session).name,'Renamed')
  assert.ok((await fetch(base+'/api/search?q=Renamed',{headers}).then(r=>r.json())).conversations.length)
  assert.equal((await post('/api/tuning',{target_chars:24000,batch_size:64,fanout:6})).status,200);assert.equal(store.tuning().fanout,6)
  assert.equal((await post('/api/tuning',{target_chars:7,batch_size:64,fanout:6})).status,400)
  assert.equal((await post('/api/summarize',{session:result.session,backend:'api'})).status,400)
  assert.equal((await post('/api/summarize',{session:result.session,backend:'cli'}).then(r=>r.json())).started,true);assert.deepEqual(spawned[0][1].slice(1),['summarize',result.session,'--backend','cli'])
  assert.equal((await fetch(base+'/api/conversation?session='+result.session,{headers}).then(r=>r.json())).backends.includes('api'),false)
  {const r=await post('/api/settings',{scope:'global',mode:'api',model:'gpt-test',api_provider:'openai',api_url:'https://api.example.test/v1/chat/completions',api_key:'k-test-12345'});assert.equal(r.status,200,await r.text())}
  assert.equal((await post('/api/settings',{scope:'global',mode:'agent'})).status,200)
  assert.equal(store.apiConfig(result.session),null,'a custom API only counts while a scope is set to it')
  assert.equal((await post('/api/settings',{scope:'global',mode:'api',model:'gpt-test',api_provider:'openai',api_url:'https://api.example.test/v1/chat/completions'})).status,200)
  assert.ok((await fetch(base+'/api/conversation?session='+result.session,{headers}).then(r=>r.json())).backends.includes('api'))
  {const same={scope:'harness',harness:'codex',mode:'api',model:'gpt-tool',api_provider:'openai',api_url:'https://api.example.test/v1/chat/completions'}
   const r=await post('/api/settings',same).then(r=>r.json());assert.equal(r.api_key_configured,true,'same endpoint reuses the default key');assert.equal(store.harnessSetting('codex').model,'gpt-tool')
   assert.equal((await post('/api/settings',{...same,api_url:'https://other.example.test/v1/chat/completions'})).status,400,'a saved tool key cannot follow a different endpoint')
   assert.equal((await post('/api/settings',{scope:'harness',harness:'codex',mode:'inherit'})).status,200)}
  store.release(result.session)
  assert.equal((await post('/api/summarize',{session:result.session,backend:'api'}).then(r=>r.json())).started,true);assert.deepEqual(spawned.at(-1)[1].slice(-2),['--backend','api'])
  assert.equal((await post('/api/setup-apply',{harness:'codex',revision:'fake'})).status,400)
  assert.equal((await fetch(base+'/api/models?backend=cli',{headers}).then(r=>r.json())).models[0].id,'runtime-only')
  assert.equal((await post('/api/index-local',{harness:'codex',key:'not-a-local-selection'})).status,400)
  assert.equal((await fetch(base+'/api/statistics',{headers})).status,404)
 }finally{await web.close()}
}))

test('Hermes conversations are mirrored losslessly, compression chains merge, hooks append new rows',fixture(({env,store})=>{
 env.HERMES_HOME=join(env.HOME,'hermes');mkdirSync(env.HERMES_HOME);const file=join(env.HERMES_HOME,'state.db'),db=new DatabaseSync(file)
 db.exec('CREATE TABLE sessions(id TEXT,title TEXT,started_at REAL,parent_session_id TEXT,end_reason TEXT,source TEXT,model_config TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_name TEXT,active INTEGER)')
 const session=db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)'),message=db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)')
 session.run('h1','Hermes source',1000,null,'compression','tui',null);session.run('h2',null,2000,'h1',null,'tui',null);session.run('sub','Delegated',1500,'h1','agent_close','subagent','{"_delegate_from":"h1"}')
 message.run(1,'h1','user','first decision',null,0);message.run(2,'h1','tool','tool output kept',"terminal",1);message.run(3,'h2','assistant','after compaction',null,1);message.run(4,'sub','user','separate subagent',null,1)
 const list=localConversations(store,'hermes',{env});assert.deepEqual(list.conversations.map(c=>c.conversation_id),['h1'],'continuations and delegated subagent runs are not listed separately')
 const saved=indexLocalConversation(store,'hermes',list.conversations.find(c=>c.conversation_id==='h1').key,{env})
 assert.equal(saved.session,'hermes-h1');assert.equal(store.stats('hermes-h1').records,3,'inactive and tool rows are kept');assert.match(store.exact('hermes-h1',1),/tool output kept/);assert.equal(store.metadata('hermes-h1').name,'Hermes source');assert.equal(store.lastCompaction('hermes-h1'),2,'the first row of the continuation session marks the compaction')
 message.run(5,'h2','user','new turn',null,1);db.prepare("UPDATE messages SET content='rewritten' WHERE id=1").run();db.close()
 const hook=spawnSync(process.execPath,[script,'hermes-hook','--home',store.dir],{env:{...env,SUPERLCM_SUMMARY_MODE:'off'},input:JSON.stringify({hook_event_name:'on_session_end',session_id:'h2'}),encoding:'utf8',timeout:10000})
 assert.equal(hook.status,0,hook.stderr);assert.equal(hook.stdout.trim(),'{}')
 const again=new ClaudeStore(store.dir);try{assert.equal(again.stats('hermes-h1').records,4,'the hook appended the new row to the same conversation');assert.match(again.exact('hermes-h1',0),/first decision/,'the mirrored original is not rewritten')
 again.deleteSession('hermes-h1')}finally{again.close()}
 const skip=spawnSync(process.execPath,[script,'hermes-hook','--home',store.dir],{env,input:JSON.stringify({hook_event_name:'on_session_end',session_id:'h2'}),encoding:'utf8',timeout:10000})
 assert.equal(skip.status,0);const after=new ClaudeStore(store.dir);try{assert.equal(after.source('hermes-h1'),undefined,'a deleted conversation is not recaptured')}finally{after.close()}
}))
test('Pi session files are indexed byte for byte with every branch, and the hook appends new lines',fixture(({env,store})=>{
 env.PI_CODING_AGENT_DIR=join(env.HOME,'pi-agent');const root=configFiles('pi',env).transcripts;mkdirSync(join(root,'--proj--'),{recursive:true});const file=join(root,'--proj--','session.jsonl')
 const records=[{type:'session',id:'pi-1',version:3},{type:'message',id:'a',parentId:null,message:{role:'user',content:[{type:'text',text:'root question'}]}},{type:'message',id:'b',parentId:'a',message:{role:'assistant',content:[{type:'text',text:'abandoned answer'}]}},{type:'message',id:'c',parentId:'a',message:{role:'toolResult',content:[{type:'text',text:'tool result'}]}}]
 writeFileSync(file,records.map(x=>JSON.stringify(x)).join('\n')+'\n')
 const list=localConversations(store,'pi',{env});const saved=indexLocalConversation(store,'pi',list.conversations[0].key,{env})
 assert.equal(saved.session,'pi-pi-1');assert.equal(store.stats('pi-pi-1').records,4);assert.equal(store.search('pi-pi-1','abandoned').events.length,1);assert.match(store.exact('pi-pi-1',3),/tool result/)
 writeFileSync(file,JSON.stringify({type:'message',id:'d',parentId:'c',message:{role:'assistant',content:[{type:'text',text:'next answer'}]}})+'\n',{flag:'a'})
 const hook=spawnSync(process.execPath,[script,'pi-hook','--home',store.dir],{env:{...env,SUPERLCM_SUMMARY_MODE:'off'},input:JSON.stringify({hook_event_name:'turn_end',session_id:'pi-1',session_file:file}),encoding:'utf8',timeout:10000})
 assert.equal(hook.status,0,hook.stderr);const again=new ClaudeStore(store.dir);try{assert.equal(again.stats('pi-pi-1').records,5)}finally{again.close()}
 const outside=join(env.HOME,'elsewhere.jsonl');writeFileSync(outside,JSON.stringify(records[0])+'\n');assert.throws(()=>indexLocalConversation(store,'pi','0'.repeat(64),{env}),/no longer available/)
}))
test('Pi setup writes only its own extension file and refuses to overwrite a foreign one',fixture(async({env,store})=>{
 env.PI_CODING_AGENT_DIR=join(env.HOME,'pi');const p=await setupPreview(store,'pi',{env});assert.equal(p.files.mcp,join(env.PI_CODING_AGENT_DIR,'extensions','superlcm.ts'))
 if(p.can_apply){const r=await applySetup(store,'pi',p.revision,{env});assert.equal(r.configuration_verified,true);assert.match(readFileSync(p.files.mcp,'utf8'),/^\/\/ SuperLcm for Pi/);assert.equal((await setupPreview(store,'pi',{env})).mcp_action,'preserve')}
 mkdirSync(join(env.PI_CODING_AGENT_DIR,'extensions'),{recursive:true});writeFileSync(p.files.mcp,'// someone else\n');const foreign=await setupPreview(store,'pi',{env});assert.equal(foreign.can_apply,false)
}))

test('generated hook command handles spaces/quotes and writes explicit index home',{skip:process.platform==='win32'},fixture(async({env,dir})=>{
 const store=new ClaudeStore(join(dir,"chosen index's home"));store.setGlobalSetting('off');const source=transcript(env,'codex','generated','Generated hook')
 try{const p=await setupPreview(store,'codex',{env,runCommand:async()=>{throw Error('not configured')}});const processEnv={...env,SUPERLCM_HOME:join(dir,'wrong-index'),SUPERLCM_SUMMARY_MODE:'off'}
 const result=spawnSync('/bin/sh',['-c',p.hook_command],{env:processEnv,input:JSON.stringify({session_id:'generated',transcript_path:source,hook_event_name:'Stop',cwd:dir}),encoding:'utf8',timeout:10000})
 assert.equal(result.status,0,result.stderr);assert.equal(store.source('codex-generated').status,'ok');assert.equal(existsSync(join(dir,'wrong-index','lcm.sqlite')),false)
 }finally{store.close()}
}))

test('setup prefers a node no AI tool bundles, and replaces an older SuperLcm hook instead of adding a second', async () => {
  const { preferredNode, nodeOwner } = await import('../src/runtime.js')
  const { setupPreview } = await import('../src/setup.js')
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-node-'))
  try {
    const bundled = join(dir, '.hermes', 'node', 'bin'); mkdirSync(bundled, { recursive: true }); symlinkSync(process.execPath, join(bundled, 'node'))
    assert.equal(nodeOwner(join(bundled, 'node'), { HOME: dir }), null, 'the link resolves outside the tool folder, so it is not borrowed')
    assert.equal(preferredNode({ HOME: dir, PATH: '' }).path, process.execPath)
    const inside = join(dir, '.hermes', 'bin'); mkdirSync(inside, { recursive: true }); writeFileSync(join(inside, 'node'), '#!/bin/sh\n', { mode: 0o755 })
    assert.equal(nodeOwner(join(inside, 'node'), { HOME: dir }), 'Hermes', 'a node inside a tool folder is borrowed')
    const env = { ...process.env, HOME: dir, CODEX_HOME: join(dir, 'codex'), SUPERLCM_CODEX_CLI_BIN: process.execPath }
    const store = new ClaudeStore(join(dir, 'index'))
    try {
      mkdirSync(env.CODEX_HOME, { recursive: true })
      const stale = `'/old/node' '${script}' 'codex-hook' '--home' '${store.dir}'`
      writeFileSync(join(env.CODEX_HOME, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: stale }] }] } }))
      const p = await setupPreview(store, 'codex', { env, runCommand: async () => { throw Error('absent') } })
      const stop = p._next.hooks.Stop.flatMap(g => g.hooks)
      assert.equal(stop.length, 1, 'updated in place, not duplicated')
      assert.ok(stop[0].command.startsWith("'" + preferredNode(env).path + "'"))
      assert.ok(p.hook_events_added.includes('Stop'))
    } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('对话模型生成: the per-turn note asks for a piece from memory; after a compaction that piece comes with its text',fixture(({env,store})=>{
 env.PI_CODING_AGENT_DIR=join(env.HOME,'pi-agent');const root=configFiles('pi',env).transcripts;mkdirSync(join(root,'--p--'),{recursive:true});const file=join(root,'--p--','s.jsonl')
 const msg=(i)=>({type:'message',id:'m'+i,parentId:i?'m'+(i-1):null,message:{role:i%2?'assistant':'user',content:[{type:'text',text:'point '+i+' about the alpha plan'}]}})
 writeFileSync(file,[{type:'session',id:'mem',version:3},...Array.from({length:10},(_,i)=>msg(i))].map(x=>JSON.stringify(x)).join('\n')+'\n')
 store.setGlobalSetting('agent')
 const hook=event=>{const r=spawnSync(process.execPath,[script,'pi-hook','--home',store.dir],{env,input:JSON.stringify({hook_event_name:event,session_id:'mem',session_file:file}),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)}
 const reply=hook('before_agent_start')
 assert.match(reply.context,/lcm_summary_task \{"conversation":"pi-mem","recent":true\}/)
 assert.equal(hook('turn_end').context,undefined,'only the turn-start event carries a note')
 const again=new ClaudeStore(store.dir)
 try{
  const fresh=summaryWork(again,'pi-mem',{recent:true})
  assert.equal(fresh.from_memory,true);assert.equal(fresh.content,undefined,'nothing is sent again');assert.match(fresh.starts.text,/point 0/);assert.equal(summaryWork(again,'pi-mem').from_memory,undefined,'another caller gets the text')
  again.markCompaction('pi-mem',5)
  const after=summaryWork(again,'pi-mem',{recent:true})
  assert.equal(after.batch_id,fresh.batch_id,'same piece');assert.equal(after.from_memory,undefined);assert.match(after.content,/point 2 about/,'the compacted piece comes with its originals')
 }finally{again.close()}
}))

test('the console opens from your own Tailscale devices only when configured',async()=>{
  const { request } = await import('node:http')
  const dir=mkdtempSync(join(tmpdir(),'superlcm-tailnet-')),store=new ClaudeStore(join(dir,'index'))
  const host='mac.example.ts.net:8791'
  const web=await startWeb({store,env:{...process.env,HOME:dir,SUPERLCM_WEB_REMOTE_HOSTS:host,SUPERLCM_WEB_TAILSCALE_USERS:'me@example.com'},discovery:async()=>[],catalog:async()=>({models:[]})})
  const port=web.server.address().port
  const send=(headers,method='GET',body)=>new Promise((resolve,reject)=>{const r=request({host:'127.0.0.1',port,path:'/api/settings',method,headers},res=>{res.resume();resolve(res.statusCode)});r.on('error',reject);r.end(body)})
  try{
    assert.equal(await send({host,'tailscale-user-login':'me@example.com'}),200)
    assert.equal(await send({host}),403,'no Tailscale login (e.g. Funnel)')
    assert.equal(await send({host,'tailscale-user-login':'someone@else.com'}),403)
    assert.equal(await send({host:'evil.example:8791','tailscale-user-login':'me@example.com'}),403)
    const json={host,'tailscale-user-login':'me@example.com','content-type':'application/json'}
    assert.equal(await send({...json,origin:'https://'+host},'POST','{}'),400,'same-origin write reaches the route')
    assert.equal(await send({...json,origin:'https://evil.example'},'POST','{}'),403)
  }finally{await web.close();rmSync(dir,{recursive:true,force:true})}
  // '*' admits any tailnet device (also tagged ones without a login), never Funnel traffic.
  const open=await startWeb({store:new ClaudeStore(join(mkdtempSync(join(tmpdir(),'superlcm-any-')),'i')),env:{...process.env,SUPERLCM_WEB_REMOTE_HOSTS:host,SUPERLCM_WEB_TAILSCALE_USERS:'*'},discovery:async()=>[],catalog:async()=>({models:[]})})
  try{const p=open.server.address().port,get=headers=>new Promise(resolve=>request({host:'127.0.0.1',port:p,path:'/api/settings',headers},res=>{res.resume();resolve(res.statusCode)}).end())
    assert.equal(await get({host}),200);assert.equal(await get({host,'tailscale-user-login':'other@example.com'}),200);assert.equal(await get({host,'tailscale-funnel-request':'?1'}),403)}finally{await open.close()}
  // Without the settings, only 127.0.0.1 works.
  const plain=await startWeb({store:new ClaudeStore(join(mkdtempSync(join(tmpdir(),'superlcm-plain-')),'i')),env:{...process.env,SUPERLCM_WEB_REMOTE_HOSTS:''},discovery:async()=>[],catalog:async()=>({models:[]})})
  try{const p=plain.server.address().port;assert.equal(await new Promise(resolve=>request({host:'127.0.0.1',port:p,path:'/api/settings',headers:{host,'tailscale-user-login':'me@example.com'}},res=>{res.resume();resolve(res.statusCode)}).end()),403)}finally{await plain.close()}
})
