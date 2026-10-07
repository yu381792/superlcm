import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {ClaudeStore} from '../src/store.js'
import {refreshConversationNames,paseoNames,claudeSidecarTitle} from '../src/conversation-names.js'
import {localConversations,indexLocalConversation} from '../src/local-conversations.js'
import {startWeb} from '../src/web.js'
const fixture=fn=>async t=>{
 const dir=mkdtempSync(join(tmpdir(),'superlcm-names-')),store=new ClaudeStore(join(dir,'index'))
 const env={...process.env,HOME:dir,CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),PASEO_HOME:join(dir,'paseo')}
 t.after(()=>store.close());await fn({dir,store,env,t})
}
function claude(env,id='claude-1'){
 const folder=join(env.CLAUDE_CONFIG_DIR,'projects','project');mkdirSync(join(folder,id),{recursive:true})
 const file=join(folder,id+'.jsonl');writeFileSync(file,JSON.stringify({sessionId:id,type:'user',message:{content:'First prompt'}})+'\n')
 return {file,title:join(folder,id,'custom-title.json')}
}
function shell(env,id,title,provider='claude',updatedAt='2026-10-07T10:00:00Z',filename='agent'){
 const dir=join(env.PASEO_HOME,'agents','project');mkdirSync(dir,{recursive:true})
 writeFileSync(join(dir,filename+'.json'),JSON.stringify({provider,title,updatedAt,persistence:{provider,sessionId:id}}))
 paseoNames(env,{force:true})
}
test('Claude sidecar rename refreshes unchanged history and preserves a manual override',fixture(async({store,env})=>{
 const {file,title}=claude(env);store.ingest('claude-1',file)
 store.setMetadata('claude-1',{harness:'claude-code',externalId:'claude-1',name:'First prompt'})
 writeFileSync(title,JSON.stringify({customTitle:'V9 顾问'}))
 const before=store.stats('claude-1').records
 assert.equal(refreshConversationNames(store,{env}).changed,1)
 assert.equal(store.metadata('claude-1').name,'V9 顾问')
 writeFileSync(title,JSON.stringify({customTitle:'New name'}));refreshConversationNames(store,{env})
 assert.equal(store.metadata('claude-1').name,'New name');assert.equal(store.stats('claude-1').records,before)
 store.nameSession('claude-1','My archive name');refreshConversationNames(store,{env})
 assert.equal(store.metadata('claude-1').name,'My archive name')
 writeFileSync(title,'incomplete');assert.equal(claudeSidecarTitle('claude-1',file),null)
 assert.equal(claudeSidecarTitle('../bad',file),null)
}))
test('Paseo title uses exact provider session identity and refreshes after shell rename',fixture(async({store,env})=>{
 const {file}=claude(env);store.ingest('claude-1',file)
 store.setMetadata('claude-1',{harness:'claude-code',externalId:'claude-1',name:'First prompt'})
 shell(env,'claude-1','Wrong provider','codex');refreshConversationNames(store,{env});assert.equal(store.metadata('claude-1').name,'First prompt')
 shell(env,'claude-1','V9 顾问');refreshConversationNames(store,{env});assert.equal(store.metadata('claude-1').name,'V9 顾问')
 writeFileSync(join(env.PASEO_HOME,'agents','project','not-started.json'),JSON.stringify({provider:'claude',title:'Not started'}))
 paseoNames(env,{force:true});assert.equal(paseoNames(env).get('claude-code\0claude-1').title,'V9 顾问')
 shell(env,'claude-1','Next title');refreshConversationNames(store,{env});assert.equal(store.metadata('claude-1').name,'Next title')
 shell(env,'claude-1','Conflicting title','claude','2026-10-07T10:00:00Z','duplicate')
 assert.equal(paseoNames(env).get('claude-code\0claude-1').title,null)
}))
test('Local Claude import reads a title beyond the preview and retains native provenance',fixture(async({store,env})=>{
 const {file,title}=claude(env)
 writeFileSync(file,JSON.stringify({sessionId:'claude-1',type:'user',message:{content:'x'.repeat(600000)}})+'\n'+JSON.stringify({sessionId:'claude-1',type:'custom-title',customTitle:'Late native title'})+'\n')
 const entry=localConversations(store,'claude-code',{env}).conversations[0]
 const result=indexLocalConversation(store,'claude-code',entry.key,{env})
 assert.equal(result.source.name,'Late native title');assert.equal(result.source.name_source,'native')
 writeFileSync(title,JSON.stringify({customTitle:'V9 顾问'}))
 assert.equal(localConversations(store,'claude-code',{env}).conversations[0].name,'V9 顾问')
}))
test('Console list and search pick up host rename without another message',fixture(async({store,env,t})=>{
 const {file,title}=claude(env);store.ingest('claude-1',file)
 store.setMetadata('claude-1',{harness:'claude-code',externalId:'claude-1',name:'First prompt'})
 const web=await startWeb({store,env,nameRefreshMs:0});t.after(()=>web.server.close())
 writeFileSync(title,JSON.stringify({customTitle:'V9 顾问'}))
 const list=await fetch(web.url+'api/conversations').then(r=>r.json());assert.equal(list.sessions[0].name,'V9 顾问')
 writeFileSync(title,JSON.stringify({customTitle:'V9 主线程'}))
 const search=await fetch(web.url+'api/search?q='+encodeURIComponent('V9 主线程')).then(r=>r.json())
 assert.ok(JSON.stringify(search).includes('V9 主线程'))
}))
test('Codex native name refresh is still bound to its own rollout',fixture(async({store,env})=>{
 mkdirSync(join(env.CODEX_HOME,'sessions'),{recursive:true});const file=join(env.CODEX_HOME,'sessions','rollout.jsonl');writeFileSync(file,'{"type":"session_meta","payload":{"id":"codex-1"}}\n{"role":"user","content":"First prompt"}\n')
 const db=new DatabaseSync(join(env.CODEX_HOME,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT,title TEXT,name TEXT,rollout_path TEXT)')
 db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('codex-1','Old','V9 顾问',file)
 store.ingest('codex-codex-1',file);store.setMetadata('codex-codex-1',{harness:'codex',externalId:'codex-1',name:'First prompt'})
 refreshConversationNames(store,{env});assert.equal(store.metadata('codex-codex-1').name,'V9 顾问')
 db.prepare('UPDATE threads SET name=?,rollout_path=?').run('Wrong name','/absent')
 refreshConversationNames(store,{env});assert.equal(store.metadata('codex-codex-1').name,'V9 顾问');db.close()
}))
test('Portable imports with a real host ID keep their own label and refresh is cached',fixture(async({dir,store,env})=>{
 const {file}=claude(env);shell(env,'claude-1','Host title')
 const imported=join(dir,'claude-1.jsonl');writeFileSync(imported,'{"role":"user","content":"Imported material"}\n')
 store.ingest('claude-1',imported);store.setMetadata('claude-1',{harness:'claude-code',externalId:'claude-1',name:'Import label'})
 refreshConversationNames(store,{env});assert.equal(store.metadata('claude-1').name,'Import label')
 assert.equal(refreshConversationNames(store,{env,minIntervalMs:15000}).cached,true)
 assert.equal(refreshConversationNames(store,{env,session:'absent'}).checked,0)
 assert.ok(file)
}))
