// Installed DSH persistence, compressed real artifacts; no model or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {dshHost} from '../src/dsh-connection.js'
import {ClaudeStore} from '../src/store.js'
import {localConversations,indexLocalConversation} from '../src/local-conversations.js'
import {captureDshPacket,projectDshEvent} from '../src/dsh.js'
import {call} from '../src/mcp.js'
import {startWeb} from '../src/web.js'
const host=dshHost(),load=name=>import(pathToFileURL(host.require.resolve(name)).href)
const [{Context},{default:Persistence},{extractSessionEventText}]=await Promise.all([load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-session-persistence-jsonl'),load('@deepseek-ai/dsh-session-query')])
for(const compression of ['zstd','none'])test('DSH history import ('+compression+') preserves originals, deduplicates and shares live continuation',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'superlcm-dsh-history-')),root=join(folder,'native/sessions'),env={...process.env,DSH_HOME:join(folder,'native')}
  const ctx=new Context(),persistence=new Persistence(ctx,{root,compression}),store=new ClaudeStore(join(folder,'archive'))
  let handle,web
  const header={id:'history-main',version:4,createdAt:1,isSeeded:false,delegationDepth:0,cwd:'/fixture'}
  const events=[
    {seq:0,time:1,type:'user/message',surfaceOp:'append',data:{role:'user',id:'user-one',source:{kind:'user'},content:[{type:'text',text:'继续此前任务 '+ '长'.repeat(18000)}]}},
    {seq:1,time:4,type:'session/title',data:{title:'压缩历史测试',source:{kind:'user'},messageSeqs:[]}},
  ]
  try {
    handle=await persistence.create(header);await handle.append(events);await handle.flush()
    const page=await localConversations(store,'dsh',{env,limit:1})
    assert.equal(page.conversations[0].can_index,true,page.conversations[0].error);assert.equal(page.total,1);assert.equal(page.conversations[0].name,'压缩历史测试');assert.equal(page.conversations[0].indexed,false)
    const selected=page.conversations[0],before=readFileSync(selected.path),beforeStat=statSync(selected.path)
    await assert.rejects(indexLocalConversation(store,'dsh','f'.repeat(64),{env}),/会话已变化/)
    assert.equal(store.sources().length,0)
    const imported=await indexLocalConversation(store,'dsh',selected.key,{env})
    assert.equal(imported.added,2);assert.equal(imported.session,'dsh-history-main');assert.equal(imported.source.name,'压缩历史测试')
    assert.deepEqual(JSON.parse(store.exact(imported.session,0)).event,events[0],'complete original survives short preview')
    assert.equal(store.effectiveSetting(imported.session).mode,'off')
    assert.equal(store.clients().some(c=>c.client==='dsh'&&c.kind==='hook'),false,'manual import does not claim live capture')
    assert.equal((await indexLocalConversation(store,'dsh',selected.key,{env})).added,0)
    assert.deepEqual(readFileSync(selected.path),before);assert.equal(statSync(selected.path).mtimeMs,beforeStat.mtimeMs,'source stays untouched')
    assert.equal((await localConversations(store,'dsh',{env})).conversations[0].indexed,true)
    const next={seq:2,time:5,type:'user/message',surfaceOp:'append',data:{role:'user',id:'user-two',source:{kind:'user'},content:[{type:'text',text:'新消息'}]}}
    await handle.append([next]);await handle.flush()
    assert.equal(captureDshPacket(store,{header,title:'压缩历史测试',records:[projectDshEvent(header.id,next,extractSessionEventText(next))]}).added,1)
    assert.equal(store.stats(imported.session).records,3)
    const continuation=await call(store,'lcm_continue',{conversation:'#'+imported.code});assert.match(JSON.stringify(continuation),/新消息/)
    web=await startWeb({store:new ClaudeStore(store.dir),env,discovery:async()=>[]})
    const listed=await fetch(web.url+'api/local-conversations?harness=dsh').then(r=>r.json());assert.equal(listed.conversations[0].session,imported.session)
    const response=await fetch(web.url+'api/index-local',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({harness:'dsh',key:selected.key})})
    assert.equal(response.status,200);assert.equal((await response.json()).added,0)
    store.deleteSession(imported.session)
    assert.equal(store.isDeleted(imported.session),true)
    assert.equal((await indexLocalConversation(store,'dsh',selected.key,{env})).records,3)
    assert.equal(store.isDeleted(imported.session),false)
  }finally{await web?.close();await handle?.close();await ctx.fiber.dispose();store.close()}
})
