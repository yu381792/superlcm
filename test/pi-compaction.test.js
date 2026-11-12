import './env.mjs'
import test, {afterEach} from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore } from '../src/store.js'
import { compactPi, preparePi, readPreparedPi, stagePi, piSourceChunks, readPiPolicy, savePiPolicy } from '../src/pi-compaction.js'
import { registerPiCompaction, serializePiMessages, piCompactRequest } from '../src/pi-runtime.js'
import {capturePiContext} from '../src/pi-fork.js'
import { estimateSummaryTokens } from '../src/summary-tokens.js'
import { makePiSnapshot, snapshotMatches, piSignature } from '../src/pi-snapshot.js'
import { forkHash, parseForkTree } from '../src/fork-summary.js'
import { SUMMARY_POLICY_VERSION } from '../src/summary-policy.js'
import { summarySettingsRevision } from '../src/summarize.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-pi-compact-')), store = new ClaudeStore(join(dir, 'archive'))
  t.after(() => store.close())
  const root = join(dir, 'pi'), sessions = join(root, 'sessions'); mkdirSync(sessions, { recursive: true })
  const session_id = 'pi-test', session_file = join(sessions, 'test.jsonl')
  const entries = [{ type: 'session', id: session_id },
    { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'Please inspect the project, preserving every original. '+ 'Historical inspection evidence. '.repeat(400) } },
    { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'Inspection is unfinished.' }] } },
    { type: 'message', id: 'c', parentId: 'b', message: { role: 'user', content: 'Keep the newest request exactly.' } }]
  writeFileSync(session_file, entries.map(JSON.stringify).join('\n') + '\n')
  const m = store.saveApiModel({ provider: 'openai', model: 'fixture-luna', url: 'http://127.0.0.1:9/v1', effort: 'high' })
  store.setHarnessSetting('pi', 'api', null, null, null, m.id); store.setIntegrationEnabled('pi', true)
  savePiPolicy(store, { enabled: true, ratio: 0.8 })
  const input = { session_id, session_file, leafId: 'c', firstKeptEntryId: 'c', tokensBefore: 100000, source: serializePiMessages(entries.slice(1,3).map(e=>e.message)) }
  return { dir, store, input, entries, env: { ...process.env, PI_CODING_AGENT_DIR: root } }
}
const summary = '# Current state\nThe inspection is unfinished. All source records remain available.\n\n## Recall for details\nRead the original tool outputs before using exact values.'

test('Pi changing image blocking invalidates the prepared-context signature',()=>{
 const ctx={model:{provider:'fixture',id:'fixture',contextWindow:100000}},policy={enabled:true,summaryMode:'main-fork'}
 const open=piSignature(ctx,policy,{images:{blockImages:false}})
 assert.notEqual(open,piSignature(ctx,policy,{images:{blockImages:true}}))
 assert.equal(open,piSignature(ctx,policy,{}))
})

test('Pi takeover archives exact bytes, uses the selected Luna API, and preserves Pi cut point', async t => {
  const f = fixture(t), original = readFileSync(f.input.session_file, 'utf8'); let options
  const result = await compactPi(f.store, f.input, { env: f.env, summarize: async (_text, opt) => { options = opt; return summary } })
  assert.equal(result.firstKeptEntryId, 'c'); assert.equal(result.tokensBefore, 100000)
  assert.equal(options.model, 'fixture-luna'); assert.equal(options.effort, 'high'); assert.equal(options.apiProvider, 'openai')
  assert.match(result.summary, /lcm_read/); assert.equal(result.details.calls, 1)
  assert.equal(f.store.eventRows('pi-pi-test').map(row => f.store.exact('pi-pi-test', row.ordinal)).join(''), original)
  assert.equal(readFileSync(f.input.session_file, 'utf8'), original)
})
test('completed Pi pieces are reused on retries but not after model settings change', async t => {
  const f = fixture(t); let calls = 0
  const run = () => compactPi(f.store, f.input, { env: f.env, summarize: async () => { calls++; return summary } })
  await run(); const retry = await run(); assert.equal(calls, 1); assert.equal(retry.details.cached, 1)
  const m = f.store.saveApiModel({ provider: 'openai', model: 'fixture-new-luna', url: 'http://127.0.0.1:9/v1' })
  f.store.setHarnessSetting('pi', 'api', null, null, null, m.id)
  await run(); assert.equal(calls, 2)
})
test('a corrupted Pi source-piece cache is invalidated and regenerated once',async t=>{
  const f=fixture(t);let calls=0
  const options={env:f.env,summarize:async()=>{calls++;return summary}}
  await compactPi(f.store,f.input,options);assert.equal(calls,1)
  f.store.db.prepare('UPDATE pi_compaction_chunks SET summary=?').run('broken summary without heading')
  const repaired=await compactPi(f.store,f.input,options);assert.equal(calls,2);assert.equal(repaired.details.cached,0)
  const again=await compactPi(f.store,f.input,options);assert.equal(calls,2);assert.equal(again.details.cached,1)
})
test('broken Pi prepared JSON is discarded without repurchasing valid chunks',async t=>{
  const f=fixture(t);f.input.draftKey='7'.repeat(64);let calls=0
  const options={env:f.env,summarize:async()=>{calls++;return summary}}
  await preparePi(f.store,f.input,options);assert.equal(calls,1)
  for(const column of ['snapshot','compaction']){
   f.store.db.prepare(`UPDATE pi_prepared_compactions SET ${column}=?`).run('{broken-json')
   assert.equal(readPreparedPi(f.store,f.input,{env:f.env}),null)
   assert.equal(f.store.db.prepare('SELECT count(*) n FROM pi_prepared_compactions').get().n,0)
   assert.ok((await preparePi(f.store,f.input,options)).compaction)
  }
  assert.equal(calls,1,'valid source pieces remain reusable')
})
test('Pi lookup can recover the completed earlier prefix without invoking a model',async t=>{
 const f=fixture(t);f.input.draftKey='9'.repeat(64);f.input.signature='fixture-signature';f.input.prefixDigest='fixture-prefix'
 let calls=0
 const prepared=await preparePi(f.store,f.input,{env:f.env,summarize:async()=>{calls++;return summary}})
 const query={session_id:f.input.session_id,draftKey:'a'.repeat(64),allowEarlier:true}
 const found=readPreparedPi(f.store,query,{env:f.env})
 assert.equal(found?.draftKey,f.input.draftKey);assert.deepEqual(found.compaction,prepared.compaction)
 assert.equal(found.snapshot.signature,f.input.signature);assert.equal(found.snapshot.prefixDigest,f.input.prefixDigest)
 assert.equal(calls,1)
 assert.equal(readPreparedPi(f.store,{...query,allowEarlier:false},{env:f.env}),null)
})

test('Pi does not reuse a draft prepared before visible shell commands were preserved',async t=>{
  const f=fixture(t); f.input.draftKey='8'.repeat(64)
  await preparePi(f.store,f.input,{env:f.env,summarize:async()=>summary})
  const policy=readPiPolicy(f.store.dir),session='pi-'+f.input.session_id
  const oldRevision=forkHash(['pi-api-preparation-v2',SUMMARY_POLICY_VERSION,policy,summarySettingsRevision(f.store,session,f.env)])
  f.store.db.prepare('UPDATE pi_prepared_compactions SET revision=? WHERE session=?').run(oldRevision,session)
  assert.equal(readPreparedPi(f.store,f.input,{env:f.env}),null)
})
test('a non-shrinking merge is regenerated on retry while successful source pieces are reused',async t=>{
  const f=fixture(t);let leaves=0,merges=0
  const input={...f.input,tokensBefore:1000,source:'Historical source record. '.repeat(2000)}
  const large='# State\n'+'保留证据。'.repeat(600)
  const summarize=async(_source,{summaryTask})=>{
    if(summaryTask.level===0){leaves++;return large}
    merges++
    return merges===1?large:'# State\nThe historical inspection remains unfinished.'
  }
  await assert.rejects(compactPi(f.store,input,{env:f.env,summarize}),/未能缩短/)
  const result=await compactPi(f.store,input,{env:f.env,summarize})
  assert.equal(leaves,1);assert.equal(merges,2);assert.equal(result.details.cached,1)
  assert.match(result.summary,/unfinished/)
})
test('Pi rejects a wrong branch boundary, deleted capture and missing API before any model call', async t => {
  const f = fixture(t); let calls = 0
  const options = { env: f.env, summarize: async () => { calls++; return summary } }
  await assert.rejects(compactPi(f.store, { ...f.input, firstKeptEntryId: 'other-branch' }, options), /保留边界/)
  f.store.setHarnessSetting('pi', 'cli')
  await assert.rejects(compactPi(f.store, f.input, options), /接管未启用|摘要 API|后台分支摘要/)
  f.store.setHarnessSetting('pi','api',null,null,null,f.store.apiModels()[0].id)
  f.store.db.prepare('INSERT INTO deleted_sessions VALUES(?,?)').run('pi-pi-test', Date.now())
  await assert.rejects(compactPi(f.store, f.input, options), /归档尚未完成/)
  assert.equal(calls, 0)
})
test('Pi cancellation and settings changes retain context and cannot publish a stale summary', async t => {
  const f = fixture(t), controller = new AbortController()
  await assert.rejects(compactPi(f.store, f.input, { env: f.env, signal: controller.signal, summarize: async () => { controller.abort(); return summary } }), /abort/i)
  await assert.rejects(compactPi(f.store, f.input, { env: f.env, summarize: async () => { savePiPolicy(f.store, { enabled: false, ratio: 0.8,keep:40000,summaryEnabled:false,summaryMode:'main-fork' }); return summary } }), /设置已变化/)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM pi_compaction_chunks').get().n, 0)
})
test('Pi verifies originals again if source bytes change during summarization', async t => {
  const f = fixture(t)
  await assert.rejects(compactPi(f.store, f.input, { env: f.env, summarize: async () => {
    // Neither the live file nor the archive may supply modified bytes.
    const file = f.store.archivePath('pi-pi-test')
    appendFileSync(file, 'tampered\n')
    const raw = readFileSync(file, 'utf8').replace('Inspection is unfinished.', 'Inspection was modified.')
    writeFileSync(file, raw); writeFileSync(f.input.session_file, raw); return summary
  } }), /digest|changed|mismatch|integrity|modified/i)
})
test('Pi chunks are bounded and concatenate to the complete multilingual input', () => {
  const source = ('中文：完整保留工具结果 😀\n' + 'x'.repeat(300) + '\n').repeat(100)
  const chunks = piSourceChunks(source, 500)
  assert.equal(chunks.join(''), source); assert.ok(chunks.length > 2)
  assert.ok(chunks.every(chunk => estimateSummaryTokens(chunk) <= 500))
})
test('Pi rejects mechanically shortened navigation instead of using it to replace live context', async t => {
  const f = fixture(t)
  await assert.rejects(compactPi(f.store, f.input, { env: f.env, summarize: async () => summary + '\n[SuperLcm reduced navigation]' }), /机械截短/)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM pi_compaction_chunks').get().n, 0)
})
test('Pi serializer keeps long tool results, failure evidence and call identifiers', () => {
  const text = 'result '.repeat(2000) + 'FINAL ERROR: quota exceeded'
  const output = serializePiMessages([{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } }] },
    { role: 'toolResult', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text }] }])
  assert.ok(output.includes(text)); assert.match(output, /ERROR \/ failed/); assert.match(output, /call-1/)
})
test('Pi API summary receives visible shell commands and failure details but never excluded commands', async t => {
  const f = fixture(t)
  const visible = { role: 'bashExecution', command: 'inspect fixtures', output: 'FAILED: missing result', exitCode: 23, cancelled: false, truncated: true, fullOutputPath: '/tmp/complete-output' }
  const hidden = { role: 'bashExecution', command: 'PRIVATE COMMAND', output: 'PRIVATE OUTPUT', exitCode: 0, excludeFromContext: true }
  f.entries.splice(3, 0, { type: 'message', id: 'shell', parentId: 'b', message: visible }, { type: 'message', id: 'hidden', parentId: 'shell', message: hidden })
  f.entries.at(-1).parentId = 'hidden'
  writeFileSync(f.input.session_file, f.entries.map(JSON.stringify).join('\n') + '\n')
  const original = readFileSync(f.input.session_file, 'utf8')
  f.input.source = serializePiMessages(f.entries.slice(1, -1).map(e => e.message))
  let submitted
  await compactPi(f.store, f.input, { env: f.env, summarize: async text => { submitted = text; return summary } })
  assert.match(submitted, /inspect fixtures/)
  assert.match(submitted, /FAILED: missing result/)
  assert.match(submitted, /23/)
  assert.match(submitted, /truncat/i)
  assert.match(submitted, /\/tmp\/complete-output/)
  assert.doesNotMatch(submitted, /PRIVATE COMMAND|PRIVATE OUTPUT/)
  assert.equal((submitted.match(/bashExecution/g) || []).length, 1)
  assert.equal(readFileSync(f.input.session_file, 'utf8'), original)
})
const runtimeCleanups=new Set()
afterEach(()=>{for(const close of runtimeCleanups)close();runtimeCleanups.clear()})
function runtime({ tokens = 70000, idle = false, responder, compactEffect, guardTimeoutMs,attemptTimeoutMs,fork, readPolicy = () => ({ enabled: true, ratio: .8 }) } = {}) {
  const handlers = new Map(), commands = [], draft = {}, settings = { compaction: { keepRecentTokens: 512 } }
  const rows = [
    { sourceEntry: { id: 'u1', type: 'message' }, messages: [{ role: 'user', content: 'Original request. ' + 'constraint '.repeat(1000) }] },
    { sourceEntry: { id: 'a1', type: 'message' }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Old work. '.repeat(500) }] }] },
    { sourceEntry: { id: 'u2', type: 'message' }, messages: [{ role: 'user', content: 'Recent request. ' + 'recent '.repeat(300) }] },
    { sourceEntry: { id: 'a2', type: 'message' }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Keep newest assistant. '.repeat(100) }] }] },
  ]
  let compactCalls = 0, abortCalls = 0, api = null, resolvePrepare, rejectPrepare
  const deferredInputs = []
  const pending = new Promise((resolve, reject) => { resolvePrepare = resolve; rejectPrepare = reject })
  const ctx = { tokens, idle, model: { contextWindow: 100000, provider: 'test', id: 'chat' }, isIdle: () => ctx.idle,
    getContextUsage: () => ({ tokens: ctx.tokens }),
    sessionManager: { getSessionId: () => 's', getSessionFile: () => '/test.jsonl', getLeafId: () => rows.at(-1).sourceEntry.id, buildSessionProjection: () => ({ entries: rows }) },
    ui: { notify() {}, setStatus() {} }, abort() { abortCalls++ }, compact(options) { compactCalls++; if (compactEffect) { compactEffect(ctx, rows); options.onComplete() } } }
  const request = (options, input, signal) => {
    commands.push(options.command)
    if (responder) return responder(options, input, signal)
    if (options.command === 'pi-prepare') { draft.snapshot = input; draft.signal = signal; return pending }
    return Promise.resolve(draft.prepared)
  }
  // Simulate the host's final provider boundary without a transport. Provider
  // chain composition itself is exercised by the installed-SDK integration test.
  let requestMessages,armController
  const createBoundary=handle=>{
    const dispatch=(event,context)=>handle({raw:structuredClone(event.payload),payload:event.payload,model:context.model,
      messages:requestMessages||rows.flatMap(e=>e.messages),transformPayload:async value=>value,signal:context.signal},context).catch(()=>undefined)
    handlers.set('before_provider_request',dispatch)
    return {arm(context,messages){
      requestMessages=messages
      if(!context.modelRegistry?.streamSimple)return
      armController=new AbortController()
      return capturePiContext(context,messages,undefined,armController.signal).then(c=>dispatch({payload:c.payload},context)).catch(()=>undefined)
    },disarm(){armController?.abort(Error('Pi 会话已切换或结束'))},close(){armController?.abort()}}
  }
  api = registerPiCompaction({ on: (name, fn) => handlers.set(name, fn), getSettings: () => settings, registerCommand() {}, appendEntry: (type, data) => deferredInputs.push({ type, data }) }, { home: '/unused' }, { policy: readPolicy, request, guardTimeoutMs,attemptTimeoutMs,fork,createBoundary })
  runtimeCleanups.add(()=>handlers.get('session_shutdown')())
  const complete = async () => {
    draft.prepared = { draftKey: draft.snapshot.draftKey, compaction: { summary, firstKeptEntryId: draft.snapshot.firstKeptEntryId, tokensBefore: 70000, details: { model: 'fixture-luna' } } }
    resolvePrepare(draft.prepared); await api.getState()?.promise
  }
  return { handlers, commands, ctx, rows, api, draft, settings, complete, rejectPrepare, deferredInputs, get compactCalls() { return compactCalls }, get abortCalls() { return abortCalls } }
}
const turn = r => r.handlers.get('turn_end')({ entries: [], context: { contextEntries: r.rows } }, r.ctx)
test('Pi announces replacement only after its checkpoint exists, once across lifecycle hooks',async()=>{
 const r=runtime(),notices=[],statuses=[]
 r.ctx.ui.notify=(text,type)=>notices.push({text,type})
 r.ctx.ui.setStatus=(_key,text)=>{if(text)statuses.push(text)}
 await turn(r);await r.complete()
 assert.equal(notices.length,0,'preparation and ready drafts stay silent')
 assert.deepEqual(statuses,[],'normal preparation is silent in the footer too')
 const successes=()=>notices.filter(n=>n.text.includes('上下文已压缩'))
 assert.equal(successes().length,0,'a prepared draft is not an installed replacement')
 r.ctx.tokens=80000
 const draft=(await turn(r)).entries[0]
 assert.equal(draft.details.superlcmTokensBefore,80000,'preserve the pre-request value even if Pi later recalculates its own metadata')
 assert.equal(successes().length,0,'returning a boundary draft does not prove persistence')
 r.handlers.get('agent_settled')({},r.ctx)
 assert.equal(successes().length,0,'a cancelled or failed boundary write must not report success')
 r.rows.splice(0,3,{sourceEntry:{...draft,id:'installed-checkpoint',tokensBefore:80000},messages:[{role:'compactionSummary',summary:draft.summary}]})
 r.ctx.tokens=2000
 r.handlers.get('session_compact')({},r.ctx)
 assert.equal(successes().length,1);assert.equal(successes()[0].type,'info')
 assert.equal(successes()[0].text,'上下文已压缩（80K-1K）')
 r.handlers.get('agent_settled')({},r.ctx)
 assert.equal(successes().length,1,'subsequent settled hooks must not duplicate the notice')
})
test('Pi reports measured post-compaction context only when a matching new receipt exists',async()=>{
 const r=runtime(),notices=[];r.ctx.ui.notify=text=>notices.push(text)
 await turn(r);await r.complete();r.ctx.tokens=80000
 const draft=(await turn(r)).entries[0]
 const checkpoint={...draft,id:'installed-checkpoint',tokensBefore:80000}
 r.rows.splice(0,3,{sourceEntry:checkpoint,messages:[{role:'compactionSummary',summary:draft.summary}]})
 const reply={type:'message',id:'paid-reply',message:{role:'assistant',provider:'test',model:'chat',stopReason:'stop',usage:{input:39000,output:3000,cacheRead:0,cacheWrite:0}}}
 r.ctx.sessionManager.getBranch=()=>[checkpoint,reply];r.ctx.tokens=42000
 r.handlers.get('agent_settled')({},r.ctx)
 assert.deepEqual(notices,['上下文已压缩（80K-42K）'])
})

test('Pi never reports another model or an aborted response as post-compaction usage',async()=>{
 for(const reply of [
  {provider:'other',model:'chat',stopReason:'stop'},
  {provider:'test',model:'other',stopReason:'stop'},
  {provider:'test',model:'chat',stopReason:'aborted'},
 ]){
  const r=runtime(),notices=[];r.ctx.ui.notify=text=>notices.push(text)
  try{
   await turn(r);await r.complete();r.ctx.tokens=80000
   const draft=(await turn(r)).entries[0],checkpoint={...draft,id:'installed-checkpoint',tokensBefore:80000}
   r.rows.splice(0,3,{sourceEntry:checkpoint,messages:[{role:'compactionSummary',summary:draft.summary}]})
   r.ctx.sessionManager.getBranch=()=>[checkpoint,{type:'message',message:{role:'assistant',...reply,usage:{input:39000,output:3000,cacheRead:0,cacheWrite:0}}}]
   r.ctx.tokens=42000;r.handlers.get('agent_settled')({},r.ctx)
   assert.deepEqual(notices,['上下文已压缩（80K-1K）'])
  }finally{r.handlers.get('session_shutdown')()}
 }
})

test('Pi archive-only background preparation and completion stay silent',async()=>{
 const r=runtime({readPolicy:()=>({enabled:false,summaryEnabled:true,summaryMode:'api',ratio:.8})}),notices=[],statuses=[]
 r.ctx.ui.notify=text=>notices.push(text)
 r.ctx.ui.setStatus=(_key,text)=>{if(text)statuses.push(text)}
 try{
  await turn(r);await r.complete()
  assert.ok(r.api.getState()?.ready)
  assert.deepEqual(notices,[]);assert.deepEqual(statuses,[])
  assert.equal(r.compactCalls,0)
 }finally{r.handlers.get('session_shutdown')()}
})
test('Pi does not announce a pending replacement in a different session',async()=>{
 const r=runtime(),notices=[]
 r.ctx.ui.notify=text=>notices.push(text)
 await turn(r);await r.complete();r.ctx.tokens=80000
 const draft=(await turn(r)).entries[0]
 r.handlers.get('session_before_switch')()
 r.rows.splice(0,3,{sourceEntry:{...draft,id:'other-session-checkpoint',tokensBefore:80000},messages:[{role:'compactionSummary',summary:draft.summary}]})
 r.ctx.tokens=2000;r.handlers.get('agent_settled')({},r.ctx)
 assert.equal(notices.filter(n=>n.includes('上下文已压缩')).length,0)
})
const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function until(check){for(let i=0;i<100;i++){if(check())return;await tick()}throw Error('Pi state did not advance')}
const mainForkPolicy=()=>({enabled:true,summaryEnabled:true,summaryMode:'main-fork',ratio:.8})
function captureRuntime(r,payload={messages:[{role:'user',content:'captured prefix'}],max_tokens:50000}){
 r.handlers.get('context_with_system')({messages:r.rows.flatMap(e=>e.messages)},r.ctx)
 return r.handlers.get('before_provider_request')({payload},r.ctx)
}

test('Pi never starts a branch when image blocking changes during archive staging',async()=>{
 let entered,release,sends=0
 const begun=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve)
 const responder=async options=>options.command==='pi-ready'?null:options.command==='pi-stage'?(entered(),waiting):null
 const fork=async(_ctx,_snapshot,_capture,{stage})=>{await stage();sends++;return {}}
 const r=runtime({tokens:70000,readPolicy:mainForkPolicy,responder,fork})
 captureRuntime(r);await begun
 const active=r.api.getState();assert.ok(active)
 r.settings.images={blockImages:true};release({checkpoints:[]})
 await active.promise
 assert.equal(sends,0,'old image-visible capture must not be sent after images are blocked')
})

test('Pi session switch cancels a stalled request capture without pausing the next session',async()=>{
 const r=runtime({tokens:90000,readPolicy:mainForkPolicy})
 let started,release,options
 const begun=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve)
 r.ctx.modelRegistry={streamSimple(_model,_context,opts){options=opts;started();return {result:()=>blocked}}}
 const work=r.handlers.get('context_with_system')({messages:r.rows.flatMap(e=>e.messages)},r.ctx)
 await begun;r.handlers.get('session_before_switch')()
 const observed=await Promise.race([work.then(()=> 'finished'),new Promise(resolve=>setTimeout(()=>resolve('hung'),100))])
 assert.throws(()=>options.onPayload({messages:[]}),/会话已切换或结束/)
 release({stopReason:'aborted'});await work
 assert.equal(observed,'finished');assert.equal(r.abortCalls,0)
})

for(const provider of ['google','pi-messages'])test('Pi excludes '+provider+' conversation contents from fixed request overhead',async()=>{
 let started,release
 const begun=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve)
 const r=runtime({tokens:90000,readPolicy:mainForkPolicy,
  responder:async opts=>opts.command==='pi-stage'?{revision:'fixture'}:null,
  fork:async(_ctx,_snapshot,_capture,{stage})=>{await stage();started();return blocked}})
 r.ctx.model.api=provider==='google'?'google-generative-ai':'pi-messages';r.ctx.model.maxTokens=2048
 r.ctx.modelRegistry={streamSimple(_model,_context,options){return {result(){
  const content='中'.repeat(100000)
  const payload=provider==='google'?{contents:[{role:'user',parts:[{text:content}]}],config:{maxOutputTokens:2048}}:{context:{messages:[{role:'user',content}]},options:{maxTokens:2048}}
  try{options.onPayload(payload)}catch{};return new Promise(()=>{})
 }}}}
 const work=r.handlers.get('context_with_system')({messages:r.rows.flatMap(e=>e.messages)},r.ctx)
 const observed=await Promise.race([begun.then(()=> 'prepared'),work.then(()=> 'stopped'),new Promise(resolve=>setTimeout(()=>resolve('hung'),500))])
 r.handlers.get('session_before_switch')();release();await work
 assert.equal(observed,'prepared');assert.equal(r.abortCalls,0)
})

test('Pi shrinks an oversized branch to an earlier complete boundary without retrying the same source',async()=>{
 const cuts=[],diagnostics=[];let prepared
 const r=runtime({tokens:75000,readPolicy:mainForkPolicy,
  responder:async(opts,snap)=>opts.command==='pi-stage'?{revision:'fixture'}:opts.command==='pi-prepare'?(prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}):prepared||null,
  fork:async(_ctx,snap,_capture,{stage})=>{await stage();cuts.push({cut:snap.firstKeptEntryId,tokens:snap.sourceTokens,ids:snap.sourceEntryIds});if(cuts.length<3)throw Object.assign(Error('no room'),{code:'SUPERLCM_PI_PREFIX_CAPACITY'});return {blocks:[],tree:[]}}})
 r.rows.splice(0,r.rows.length,...Array.from({length:14},(_,i)=>({sourceEntry:{id:'source-'+i,type:'message'},messages:[{role:i%2?'assistant':'user',content:i%2?[{type:'text',text:'Inspection evidence. '.repeat(200)}]:'Keep the original constraints. '.repeat(200)}]})))
 try{
  captureRuntime(r);await until(()=>r.api.getState()?.ready)
  assert.equal(cuts.length,3)
  assert.ok(cuts[1].tokens<cuts[0].tokens&&cuts[2].tokens<cuts[1].tokens)
  assert.equal(new Set(cuts.map(c=>c.cut)).size,3)
  assert.equal(r.api.getState().snapshot.firstKeptEntryId,cuts[2].cut)
  assert.deepEqual(cuts[2].ids,cuts[0].ids.slice(0,cuts[2].ids.length))
  assert.equal(r.commands.filter(c=>c==='pi-prepare').length,1)
  assert.equal(r.deferredInputs.filter(e=>e.type==='superlcm-summary-resize').length,2)
  assert.equal(r.deferredInputs.filter(e=>e.type==='superlcm-summary-failure').length,0)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi capacity resizing uses the nearest complete boundary when an eighty-percent step is too small',async()=>{
 const cuts=[];let prepared
 const r=runtime({readPolicy:mainForkPolicy,responder:async(opts,snap)=>opts.command==='pi-stage'?{revision:'fixture'}:opts.command==='pi-prepare'?(prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}):prepared||null,
  fork:async(_ctx,snap,_capture,opts)=>{await opts.stage();cuts.push(snap);if(cuts.length===1)throw Object.assign(Error('no room'),{code:'SUPERLCM_PI_PREFIX_CAPACITY'});assert.equal(opts.forcePrefix,true);return {blocks:[],tree:[]}}})
 r.rows[0].messages[0].content='x'.repeat(48000)
 try{
  captureRuntime(r);await until(()=>r.api.getState()?.ready)
  assert.equal(cuts.length,2)
  assert.ok(cuts[1].sourceTokens>cuts[0].sourceTokens*.8&&cuts[1].sourceTokens<cuts[0].sourceTokens)
  assert.notEqual(cuts[1].firstKeptEntryId,cuts[0].firstKeptEntryId)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi cold restart restores a completed resized prefix without another summary request',async()=>{
 let saved,forks=0
 const r=runtime({readPolicy:mainForkPolicy,responder:async(opts,input)=>opts.command==='pi-ready'&&input.allowEarlier?saved:opts.command==='pi-ready'?{draftKey:saved.draftKey,compaction:saved.compaction}:null,
  fork:async()=>{forks++;throw Error('must reuse completed prefix')}})
 r.rows.splice(0,r.rows.length,...Array.from({length:14},(_,i)=>({sourceEntry:{id:'restart-'+i,type:'message'},messages:[{role:i%2?'assistant':'user',content:i%2?[{type:'text',text:'Historical result. '.repeat(200)}]:'Keep these constraints. '.repeat(200)}]})))
 const initial=makePiSnapshot(r.ctx,mainForkPolicy(),r.settings)
 const smaller=makePiSnapshot(r.ctx,mainForkPolicy(),r.settings,{sourceLimit:Math.floor(initial.sourceTokens*.8)})
 saved={draftKey:smaller.draftKey,snapshot:smaller,compaction:{summary,firstKeptEntryId:smaller.firstKeptEntryId}}
 try{
  await turn(r);await until(()=>r.api.getState()?.ready)
  assert.equal(forks,0);assert.equal(r.api.getState().snapshot.draftKey,smaller.draftKey)
  assert.deepEqual(r.api.getState().snapshot.sourceEntryIds,smaller.sourceEntryIds)
  assert.ok((await r.api.ready(r.ctx))?.summary)
 }finally{r.handlers.get('session_shutdown')()}
})

for(const changed of ['prefix','settings','boundary'])test('Pi cold restart refuses a resized draft with changed '+changed,async()=>{
 let saved,prepared,forks=0
 const r=runtime({readPolicy:mainForkPolicy,responder:async(opts,snap)=>opts.command==='pi-ready'?(snap.allowEarlier?saved:prepared):opts.command==='pi-stage'?{revision:'fixture'}:(prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}),
  fork:async(_ctx,_snap,_capture,{stage})=>{forks++;await stage();return {blocks:[],tree:[]}}})
 const original=makePiSnapshot(r.ctx,mainForkPolicy(),r.settings)
 const earlier=makePiSnapshot(r.ctx,mainForkPolicy(),r.settings,{firstKeptEntryId:r.rows[1].sourceEntry.id})
 saved={draftKey:earlier.draftKey,snapshot:{...earlier},compaction:{summary,firstKeptEntryId:earlier.firstKeptEntryId}}
 if(changed==='prefix')saved.snapshot.prefixDigest='modified'
 if(changed==='settings')saved.snapshot.signature='modified'
 if(changed==='boundary')saved.compaction.firstKeptEntryId='other-branch'
 try{
  captureRuntime(r);await until(()=>r.api.getState()?.ready)
  assert.equal(forks,1);assert.equal(r.api.getState().snapshot.draftKey,original.draftKey)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi reports an indivisible oversized prefix once instead of retrying it forever',async t=>{
 let forks=0;const notices=[]
 const r=runtime({tokens:70000,readPolicy:mainForkPolicy,responder:async()=>null,
  fork:async()=>{forks++;throw Object.assign(Error('no room'),{code:'SUPERLCM_PI_PREFIX_CAPACITY'})}})
 r.rows[0].messages[0].content='证'.repeat(20000);r.rows.splice(1,2)
 r.ctx.ui.notify=text=>notices.push(text)
 try{
  t.mock.timers.enable({apis:['setTimeout','Date']});captureRuntime(r)
  await until(()=>forks===1&&!r.api.getState())
  t.mock.timers.tick(86400000);await turn(r);await tick()
  assert.equal(forks,1);assert.equal(notices.length,1)
  assert.match(notices[0],/完整消息组/)
 }finally{r.handlers.get('session_shutdown')();t.mock.timers.reset()}
})

test('Pi resumes a blocked capacity prefix when the captured tools change, but not on identical recapture',async()=>{
 let forks=0,prepared
 const r=runtime({readPolicy:mainForkPolicy,responder:async(opts,snap)=>opts.command==='pi-stage'?{revision:'fixture'}:opts.command==='pi-prepare'?(prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}):prepared||null,
  fork:async(_ctx,_snap,_capture,{stage})=>{forks++;if(forks===1)throw Object.assign(Error('no room'),{code:'SUPERLCM_PI_PREFIX_CAPACITY'});await stage();return {blocks:[],tree:[]}}})
 r.rows[0].messages[0].content='证'.repeat(20000);r.rows.splice(1,2)
 const payload={messages:[{role:'user',content:'exact prefix'}],tools:[{name:'large_tool',description:'schema'}],max_tokens:1024}
 try{
  captureRuntime(r,payload);await until(()=>forks===1&&!r.api.getState())
  captureRuntime(r,payload);await tick();assert.equal(forks,1)
  captureRuntime(r,{...payload,tools:[]});await until(()=>r.api.getState()?.ready)
  assert.equal(forks,2)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi stops retrying an unsupported provider until its settings change',async t=>{
 let forks=0;const notices=[]
 const r=runtime({readPolicy:mainForkPolicy,responder:async()=>null,fork:async()=>{forks++;throw Object.assign(Error('unsupported provider request'),{code:'SUPERLCM_PI_UNSUPPORTED_REQUEST'})}})
 r.ctx.ui.notify=text=>notices.push(text)
 try{
  t.mock.timers.enable({apis:['setTimeout','Date']});captureRuntime(r)
  await until(()=>forks===1&&!r.api.getState())
  t.mock.timers.tick(120000);await turn(r);await tick()
  assert.equal(forks,1);assert.ok(notices.some(text=>text.includes('unsupported provider request')))
 }finally{r.handlers.get('session_shutdown')();t.mock.timers.reset()}
})

test('Pi bypasses a malformed ready response and prepares a fresh branch',async()=>{
 let forks=0,prepared
 const r=runtime({readPolicy:mainForkPolicy,
  responder:async(opts,snap)=>opts.command==='pi-ready'?Promise.reject(new SyntaxError('corrupt stored JSON')):opts.command==='pi-stage'?{revision:'fixed'}:(prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}),
  fork:async(_ctx,_snap,_capture,{stage})=>{forks++;await stage();return {blocks:[],tree:[]}}})
 try{
  r.rows[0].messages[0].content='compressible history '.repeat(10000)
  captureRuntime(r);await until(()=>r.api.getState()?.ready)
  assert.equal(forks,1);assert.deepEqual(r.commands,['pi-ready','pi-stage','pi-prepare'])
  assert.equal(r.api.getState().ready,prepared)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi 500K window prepares at 350K and only replaces at 400K with a 128K output reservation',async()=>{
 const r=runtime({tokens:340000,compactEffect:(ctx)=>{ctx.tokens=1000}})
 try{
  r.ctx.model.contextWindow=500000;r.ctx.model.maxTokens=128000
  await turn(r);assert.deepEqual(r.commands,[])
  r.ctx.tokens=350000;await turn(r);await r.complete()
  r.ctx.tokens=399999;assert.equal(await turn(r),undefined)
  const payload={messages:[{role:'user',content:'small'}],max_tokens:128000}
  const wire=await r.handlers.get('before_provider_request')({payload},r.ctx)
  assert.equal(wire.max_tokens,90000);assert.equal(payload.max_tokens,128000)
  assert.equal(r.ctx.model.maxTokens,128000);assert.equal(r.abortCalls,0)
  r.ctx.tokens=400000;assert.equal((await turn(r)).entries[0].type,'compaction')
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi custom replacement above 90% is not pulled back by the default pressure guard',async()=>{
 const r=runtime({tokens:445000,readPolicy:()=>({enabled:true,ratio:.99})})
 r.ctx.model.contextWindow=500000;r.ctx.model.maxTokens=128000
 try{
  await turn(r);await r.complete()
  r.ctx.tokens=450000
  assert.equal(await turn(r),undefined)
  r.ctx.tokens=495000
  assert.equal((await turn(r)).entries[0].type,'compaction')
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi runtime keeps a progressing background branch past the idle limit',async t=>{
 const gates=[];let calls=0,prepared
 const r=runtime({readPolicy:mainForkPolicy,
  responder:async(opts,snap)=>opts.command==='pi-stage'?{revision:'fixed'}:opts.command==='pi-prepare'?(prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}):prepared||null,
  fork:async(_ctx,_snap,_capture,{stage,progress})=>{
   calls++;await stage()
   for(let i=0;i<3;i++){await new Promise(resolve=>gates.push(resolve));progress()}
   return {blocks:[],tree:[]}
  }})
 try{
  r.rows[0].messages[0].content='compressible history '.repeat(10000)
  t.mock.timers.enable({apis:['setTimeout','Date']});captureRuntime(r)
  await until(()=>gates.length===1)
  for(let i=0;i<3;i++){
   t.mock.timers.tick(540000);gates.shift()()
   if(i<2)await until(()=>gates.length===1)
  }
  await until(()=>r.api.getState()?.ready)
  assert.equal(calls,1);assert.equal(r.api.getState().attempt,1)
  assert.equal(r.commands.filter(c=>c==='pi-prepare').length,1)
 }finally{r.handlers.get('session_shutdown')();for(const release of gates)release();t.mock.timers.reset()}
})

for(const streamingBehavior of ['steer','followUp'])test('Pi leaves '+streamingBehavior+' input in the native queue during replacement pressure',async()=>{
 const r=runtime();await turn(r);await r.complete();r.ctx.tokens=95000
 try{
  const result=await r.handlers.get('input')({text:'Do not lose this queued instruction',streamingBehavior},r.ctx)
  assert.notEqual(result?.action,'handled');assert.equal(r.deferredInputs.length,0);assert.equal(r.compactCalls,0)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi native overflow waits for the existing draft using the recovery signal',async()=>{
 const r=runtime();await turn(r)
 const old=new AbortController();old.abort();r.ctx.signal=old.signal
 const recovery=new AbortController();let finished=false
 const work=r.handlers.get('session_before_compact')({reason:'overflow',preparation:{tokensBefore:99000},signal:recovery.signal},r.ctx).then(result=>{finished=true;return result})
 await tick();assert.equal(finished,false)
 await r.complete();const result=await work
 assert.equal(result.compaction.summary,summary);assert.equal(result.compaction.tokensBefore,99000)
 assert.equal(r.commands.filter(c=>c==='pi-prepare').length,1)
 r.handlers.get('session_shutdown')()
})

test('Pi persists an already-applied request summary at an aborted turn boundary',async()=>{
 let prepared
 const r=runtime({tokens:70000,readPolicy:mainForkPolicy,
  responder:async(opts,snap)=>opts.command==='pi-stage'?{revision:'fixed'}:opts.command==='pi-prepare'?(prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}):prepared||null,
  fork:async(_ctx,_snap,_capture,{stage})=>{await stage();return {blocks:[],tree:[]}}})
 const controller=new AbortController();r.ctx.signal=controller.signal
 r.ctx.model.maxTokens=2048
 r.ctx.modelRegistry={streamSimple(_m,_c,opts){return {result:async()=>{try{opts.onPayload({messages:[{role:'user',content:'small'}],max_tokens:2048})}catch{};return {stopReason:'aborted'}}}}}
 try{
  captureRuntime(r);await until(()=>r.api.getState()?.ready);r.ctx.tokens=95000
  const replaced=await r.handlers.get('context_with_system')({messages:r.rows.flatMap(e=>e.messages)},r.ctx)
  assert.ok(replaced?.messages)
  controller.abort(Error('user cancelled the foreground'))
  const result=await turn(r)
  assert.equal(result.entries[0].type,'compaction');assert.equal(result.entries[0].summary,summary)
  assert.equal(r.rows.at(-1).sourceEntry.id,'a2','original tail stays untouched')
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi archive retry reuses a completed fork instead of purchasing it again',async t=>{
 let calls=0,saves=0,prepared
 const r=runtime({readPolicy:mainForkPolicy,
  responder:async(opts,snap)=>{
   if(opts.command==='pi-ready')return prepared||null
   if(opts.command==='pi-stage')return {revision:'fixed'}
   if(opts.command==='pi-prepare'){if(++saves===1)throw Error('database is locked');return prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}}
  },fork:async(_ctx,_snap,_capture,{stage})=>{await stage();calls++;return {blocks:[],tree:[]}}})
 try{
  t.mock.timers.enable({apis:['setTimeout','Date']});captureRuntime(r)
  await until(()=>r.api.getState()?.retryAt)
  t.mock.timers.tick(r.api.getState().retryAt-Date.now())
  await until(()=>r.api.getState()?.ready)
  assert.equal(saves,2);assert.equal(calls,1,'saving the already completed model output must not invoke the model again')
 }finally{r.handlers.get('session_shutdown')();t.mock.timers.reset()}
})

test('Pi stops when the archive rejects a completed tree semantically',async t=>{
 let calls=0,saves=0
 const r=runtime({readPolicy:mainForkPolicy,
  responder:async opts=>{if(opts.command==='pi-stage')return {revision:'fixed'};if(opts.command==='pi-prepare'){saves++;throw Error('summary language mismatch')}return null},
  fork:async(_ctx,_snap,_capture,{stage})=>{await stage();calls++;return {blocks:[],tree:[]}}})
 try{
  t.mock.timers.enable({apis:['setTimeout','Date']});captureRuntime(r)
  await until(()=>!r.api.getState()||r.api.getState()?.retryAt)
  assert.equal(r.api.getState(),null)
  t.mock.timers.tick(10000000);await turn(r)
  assert.equal(calls,1);assert.equal(saves,1)
 }finally{r.handlers.get('session_shutdown')();t.mock.timers.reset()}
})

for(const code of ['SUPERLCM_PI_REPLAY_REFUSED','SUPERLCM_PI_INVALID_SUMMARY'])test('Pi '+code+' ends the attempt instead of scheduling it forever',async t=>{
 let calls=0
 const r=runtime({readPolicy:mainForkPolicy,responder:async()=>null,fork:async()=>{calls++;throw Object.assign(Error('explicit terminal failure'),{code})}})
 try{
  t.mock.timers.enable({apis:['setTimeout','Date']});captureRuntime(r)
  await until(()=>!r.api.getState()||r.api.getState()?.retryAt)
  assert.equal(r.api.getState(),null,'an explicit non-replayable refusal is terminal')
  t.mock.timers.tick(10000000);await turn(r);captureRuntime(r);await tick()
  assert.equal(calls,1);assert.equal(r.api.getState(),null)
 }finally{r.handlers.get('session_shutdown')();t.mock.timers.reset()}
})

test('Pi safe target crossing does not wait for unfinished preparation at the request hook',async()=>{
 let release,prepared,started=false
 const waiting=new Promise(resolve=>release=resolve)
 const r=runtime({tokens:70000,readPolicy:mainForkPolicy,
  responder:async(opts,snap)=>opts.command==='pi-stage'?{revision:'fixed'}:opts.command==='pi-prepare'?(prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}):prepared||null,
  fork:async(_ctx,_snap,_capture,{stage})=>{started=true;await stage();await waiting;return {blocks:[],tree:[]}}})
 r.ctx.model.maxTokens=2048
 r.ctx.modelRegistry={streamSimple(_m,_c,opts){return {result:async()=>{try{opts.onPayload({messages:[{role:'user',content:'small'}],max_tokens:2048})}catch{};return {stopReason:'aborted'}}}}}
 let work
 try{
  captureRuntime(r);await until(()=>started);r.ctx.tokens=81000
  work=r.handlers.get('context_with_system')({messages:r.rows.flatMap(e=>e.messages)},r.ctx)
  const result=await Promise.race([work.then(()=> 'continued'),new Promise(resolve=>setTimeout(()=>resolve('blocked'),30))])
  assert.equal(result,'continued');assert.equal(r.abortCalls,0)
 }finally{release();r.handlers.get('session_shutdown')();await work}
})

test('Pi retries independently past fifty minutes and keeps pressure waiting until the eighth attempt succeeds',async t=>{
 let release,settled=false,prepared;const gate=new Promise(resolve=>release=resolve),captures=[],notices=[]
 const r=runtime({readPolicy:mainForkPolicy,guardTimeoutMs:20,
  responder:async(opts,snap)=>opts.command==='pi-stage'?{revision:'fixed'}:opts.command==='pi-prepare'?(prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}):prepared||null,
  fork:async(ctx,snap,capture,{signal,stage})=>{
   const n=captures.length;captures.push(capture);await stage()
   if(n<5)await gate
   if(n===5)throw Error('quota')
   if(n===6)throw SyntaxError('malformed summary')
   return {blocks:[],tree:[]}
  }})
 let waiting
 try{
  r.ctx.ui.notify=text=>notices.push(text)
  r.ctx.model.maxTokens=50000
  r.rows[0].messages[0].content='compressible history '.repeat(10000)
  t.mock.timers.enable({apis:['setTimeout','Date']})
  captureRuntime(r);await until(()=>captures.length===1)
  r.ctx.tokens=80000;waiting=turn(r).then(result=>{settled=true;return result})
  captureRuntime(r,{messages:[{role:'user',content:'NEWER CAPTURE'}],max_tokens:50000})
  for(let n=1;n<=7;n++){
   if(n<=5)t.mock.timers.tick(600001)
   await until(()=>r.api.getState()?.retryAt)
   assert.equal(settled,false)
   const current=r.api.getState();assert.equal(current.attempt,n)
   assert.equal(current.lastFailure.attempt,n)
   assert.ok(current.lastFailure.message)
   t.mock.timers.tick(current.retryAt-Date.now())
   await until(()=>captures.length===n+1)
   if(n<5)assert.equal(r.api.getState().lastFailure.attempt,n,'starting a retry keeps the last failure')
  }
  const result=await waiting
  assert.equal(result.entries[0].type,'compaction')
  assert.equal(r.commands.filter(c=>c==='pi-prepare').length,1)
  assert.ok(captures.every(c=>c===captures[0]),'retry uses one frozen capture')
  assert.equal(notices.filter(text=>text.includes('正在后台准备')).length,0,'preparation is silent, including retries')
  assert.equal(notices.filter(text=>text.startsWith('后台摘要失败：')).length,7,'each genuine failed attempt is reported once')
  release();await tick()
  assert.equal(r.commands.filter(c=>c==='pi-prepare').length,1,'late attempts never publish')
 }finally{r.handlers.get('session_shutdown')();release();t.mock.timers.reset();await waiting}
})

for(const cancel of ['user','session','fork','tree','model','endpoint','settings','source'])test('Pi retry backoff cancels on '+cancel,async t=>{
 let calls=0
 const p=mainForkPolicy()
 const r=runtime({readPolicy:()=>p,responder:async()=>null,fork:async()=>{calls++;throw Error('transport')}})
 const controller=new AbortController();r.ctx.signal=controller.signal
 try{
  t.mock.timers.enable({apis:['setTimeout','Date']});captureRuntime(r)
  await until(()=>r.api.getState()?.retryAt)
  assert.equal(calls,1)
  if(cancel==='user')controller.abort(Error('user stopped'))
  else if(cancel==='session')r.handlers.get('session_before_switch')()
  else if(cancel==='fork')r.handlers.get('session_before_fork')()
  else if(cancel==='tree')r.handlers.get('session_tree')()
  else if(cancel==='model'){r.ctx.model.id='new-model';r.handlers.get('model_select')({},r.ctx)}
  else if(cancel==='endpoint'){r.ctx.model.baseUrl='http://127.0.0.1:1';r.handlers.get('model_select')({},r.ctx)}
  else if(cancel==='settings')p.ratio=.5
  else r.rows[0].messages[0].content='changed source'
  await tick();t.mock.timers.tick(10000000);await tick()
  assert.equal(calls,1);assert.equal(r.api.getState(),null)
 }finally{r.handlers.get('session_shutdown')();t.mock.timers.reset()}
})

test('Pi a model switch releases the old capacity waiter without cancelling the new draft',async()=>{
 const r=runtime();let settled=false
 try{
  await turn(r);r.ctx.tokens=95000
  const old=turn(r).then(()=>{settled=true})
  await tick()
  r.ctx.model.id='new-model';r.ctx.tokens=70000
  r.handlers.get('model_select')({},r.ctx)
  const next=r.api.getState()
  await until(()=>settled)
  assert.equal(r.api.getState(),next)
  await r.complete();await old
  assert.ok(r.api.getState()?.ready)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi capacity pause preserves background retries but a later user abort stops them',async t=>{
 let calls=0
 const r=runtime({readPolicy:mainForkPolicy,responder:async()=>null,fork:async()=>{calls++;throw Error('transport')}})
 const first=new AbortController();r.ctx.signal=first.signal
 r.ctx.abort=()=>first.abort(Error('capacity pause'))
 try{
  t.mock.timers.enable({apis:['setTimeout','Date']});captureRuntime(r)
  await until(()=>r.api.getState()?.retryAt)
  r.handlers.get('before_provider_request')({payload:{max_tokens:1000,tools:[{description:'中'.repeat(100000)}]}},r.ctx)
  r.handlers.get('agent_settled')({aborted:true},r.ctx)
  assert.ok(r.api.getState())
  const next=r.api.getState().retryAt;t.mock.timers.tick(next-Date.now())
  await until(()=>calls===2)
  const second=new AbortController();r.ctx.signal=second.signal
  r.handlers.get('model_select')({},r.ctx)
  second.abort(Error('user stop'))
  await tick();t.mock.timers.tick(10000000);await tick()
  assert.equal(calls,2);assert.equal(r.api.getState(),null)
 }finally{r.handlers.get('session_shutdown')();t.mock.timers.reset()}
})

test('Pi invalid capture waits for a fresh request instead of retrying a stale prefix',async()=>{
 let calls=0
 const r=runtime({readPolicy:mainForkPolicy,responder:async()=>null,fork:async()=>{calls++;throw Object.assign(Error('prefix changed'),{code:'SUPERLCM_PI_CAPTURE_INVALID'})}})
 try{
  captureRuntime(r);await until(()=>r.api.getState()===null)
  await turn(r);assert.equal(calls,1)
  captureRuntime(r);await until(()=>calls===2)
 }finally{r.handlers.get('session_shutdown')()}
})

test('background starts before 80% and never blocks the main tool loop or new input', async () => {
  const r = runtime()
  await turn(r)
  assert.deepEqual(r.commands, ['pi-prepare']); assert.equal(r.api.getState().ready, null)
  r.ctx.tokens = 80000; r.ctx.idle = true
  await r.handlers.get('input')({}, r.ctx)
  assert.equal(r.compactCalls, 0); assert.equal(r.commands.length, 1)
  r.ctx.idle = false; await r.complete()
})
test('80% installs an already prepared prefix with zero replacement model requests and preserves appended tail', async () => {
  const r = runtime(); await turn(r); await r.complete()
  r.rows.push({ sourceEntry: { id: 'late', type: 'message' }, messages: [{ role: 'user', content: 'LATE USER REQUEST MUST REMAIN VERBATIM' }] })
  r.ctx.tokens = 80000
  const result = await turn(r)
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].type, 'compaction')
  assert.equal(result.entries[0].firstKeptEntryId, r.draft.snapshot.firstKeptEntryId)
  assert.equal(result.entries[0].details.replacementModelCalls, 0)
  assert.deepEqual(r.commands, ['pi-prepare', 'pi-ready'])
  assert.equal(r.compactCalls, 0, 'running tool chain must not be aborted through ctx.compact')
  assert.ok(!r.draft.snapshot.source.includes('LATE USER REQUEST'))
  assert.ok(r.rows.findIndex(e => e.sourceEntry.id === 'late') > r.rows.findIndex(e => e.sourceEntry.id === result.entries[0].firstKeptEntryId))
})
test('missing ready result at 80% cancels native compaction without generating synchronously', async () => {
  const r = runtime({ tokens: 80000 })
  const result = await r.handlers.get('session_before_compact')({ preparation: { tokensBefore: 80000 } }, r.ctx)
  assert.deepEqual(result, { cancel: true }); assert.deepEqual(r.commands, [])
})
test('manual/native compaction reuses a ready background result without asking Luna again', async () => {
  const r = runtime(); await turn(r); await r.complete(); r.ctx.tokens = 80000
  const result = await r.handlers.get('session_before_compact')({ preparation: { tokensBefore: 80000 } }, r.ctx)
  assert.equal(result.compaction.tokensBefore, 80000)
  assert.equal(result.compaction.firstKeptEntryId, r.draft.snapshot.firstKeptEntryId)
  assert.deepEqual(r.commands, ['pi-prepare', 'pi-ready'])
})
test('edited prefix or model change discards ready summaries before replacement', async () => {
  for (const change of [r => { r.rows[0].messages[0].content = 'Changed authorization' }, r => { r.ctx.model.id = 'different' }]) {
    const r = runtime(); await turn(r); await r.complete(); change(r); r.ctx.tokens = 80000
    const result = await turn(r)
    assert.equal(result, undefined)
    assert.equal(r.commands.filter(x => x === 'pi-ready').length, 0)
    r.handlers.get('session_shutdown')()
  }
})
test('background failures retry after cooldown without blocking the current run', async () => {
  const r = runtime(), originalNow = Date.now; let now = 0; Date.now = () => now
  try {
    await turn(r); r.rejectPrepare(Error('temporary Luna failure'))
    await new Promise(resolve=>setImmediate(resolve))
    await turn(r); assert.equal(r.commands.length, 1)
    now = 61000; await turn(r); assert.equal(r.commands.length, 2)
  } finally { Date.now = originalNow; r.handlers.get('session_shutdown')() }
})
test('session shutdown cancels unfinished background generation', async () => {
  const r = runtime(); await turn(r)
  r.handlers.get('session_shutdown')()
  assert.equal(r.draft.signal.aborted, true); assert.equal(r.api.getState(), null)
})
test('capacity guard waits for the existing slow worker before allowing another model turn', async () => {
  const r = runtime(); await turn(r); r.ctx.tokens = 90000
  let finished = false
  const guarded = turn(r).then(value => { finished = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false); assert.deepEqual(r.commands, ['pi-prepare'])
  await r.complete()
  const result = await guarded
  assert.equal(result.entries[0].type, 'compaction'); assert.equal(r.abortCalls, 0)
})
test('failed summary at capacity aborts the tool loop and never falls through to a main request', async () => {
  const r = runtime(); await turn(r); r.ctx.tokens = 95000
  const guarded = turn(r); r.rejectPrepare(Error('Luna unavailable'))
  assert.equal(await guarded, undefined); assert.equal(r.abortCalls, 1)
  assert.deepEqual(r.commands, ['pi-prepare']); assert.equal(r.rows.length, 4)
})
test('an unshrinkable giant tool result is refused after one bounded restage', async () => {
  let writes = 0
  const r = runtime({ responder: async (opts, snapshot) => {
    if (opts.command === 'pi-prepare') { writes++; r.draft.snapshot = snapshot }
    return { compaction: { summary, firstKeptEntryId: r.draft.snapshot.firstKeptEntryId } }
  } })
  await turn(r); await r.api.getState()?.promise
  r.rows.push({ sourceEntry: { id: 'huge', type: 'message' }, messages: [{ role: 'toolResult', toolCallId: 'new', content: [{ type: 'text', text: '巨'.repeat(120000) }] }] })
  r.ctx.tokens = 99000
  assert.equal(await turn(r), undefined); assert.equal(r.abortCalls, 1)
  assert.equal(writes, 2, 'only one fresh draft may be attempted at the guard')
  assert.equal(r.rows.at(-1).messages[0].content[0].text.length, 120000)
})
test('genuinely oversized fixed context still triggers protection before dispatch', async () => {
  for (const configure of [ctx => { ctx.getSystemPrompt = () => '固'.repeat(100000) }]) {
    const r = runtime({ tokens: 60000, responder: async () => { throw Error('unavailable') } }); configure(r.ctx)
    await turn(r); assert.equal(r.abortCalls, 1); assert.deepEqual(r.commands, ['pi-prepare'])
  }
})
test('Pi persisted system/tools are counted once as fixed overhead, outside dialogue and retained tail',async()=>{
 const r=runtime({tokens:60000})
 const system='Fixed system state. '.repeat(11000)
 r.ctx.getSystemPrompt=()=>system
 r.rows.unshift({sourceEntry:{id:'sys',type:'system'},messages:[{role:'system',content:system}]})
 assert.equal(await turn(r),undefined)
 assert.deepEqual(r.commands,[],'duplicating system state must not prepare or pause below 70%')
 assert.equal(r.abortCalls,0)
 r.ctx.tokens=70000;await turn(r);await r.complete()
 assert.equal(r.draft.snapshot.sourceMessages,undefined,'legacy API preparation does not gain a model route')
 assert.ok(!r.draft.snapshot.source.includes('Fixed system state.'),'system state must not enter a replaceable history range')
 r.ctx.tokens=80000
 const result=await turn(r)
 assert.equal(result.entries[0].type,'compaction');assert.equal(r.abortCalls,0)
})
test('Pi measured safe requests are not paused by large archive previews before the real threshold',async()=>{
 const r=runtime({tokens:60000,readPolicy:mainForkPolicy})
 r.rows[0].messages[0].content='Archive JSON preview overhead. '.repeat(18000)
 r.rows[1].messages[0].usage={input:59000,output:1000}
 await turn(r)
 assert.equal(r.abortCalls,0);assert.deepEqual(r.commands,[])
 captureRuntime(r,{messages:[{role:'user',content:'Actual safe wire input. '.repeat(5000)}],max_tokens:16000})
 assert.equal(r.abortCalls,0);assert.deepEqual(r.commands,[],'measured usage below 70% must not start a false recovery')
 r.ctx.tokens=70000;captureRuntime(r)
 await until(()=>r.commands.includes('pi-ready'))
 assert.ok(r.commands.includes('pi-ready'),'preparation begins at the configured measured threshold')
 r.handlers.get('session_shutdown')()
})
test('a large output reserve cannot move preparation or replacement before their total-window thresholds', async () => {
  const r = runtime({ tokens: 60000 }); r.ctx.model.maxTokens = 50000
  // A previous measured request includes fixed costs. Use a large compressible
  // history so a valid replacement can actually fit the remaining input budget.
  r.rows[0].messages[0].content = 'compressible history '.repeat(10000)
  assert.equal(await turn(r),undefined)
  assert.deepEqual(r.commands,[])
  r.ctx.tokens=70000;await turn(r);await r.complete()
  r.ctx.tokens=79999;assert.equal(await turn(r),undefined)
  r.ctx.tokens=80000;const result=await turn(r)
  assert.equal(result.entries[0].type, 'compaction'); assert.equal(r.abortCalls, 0)
})
test('cold input at capacity is preserved exactly and handled when Luna fails', async () => {
  const r = runtime({ tokens: 95000, idle: true })
  const input = r.handlers.get('input')({ text: 'Keep exact user input 请保留', images: [{ type: 'image', data: 'fixture' }] }, r.ctx)
  r.rejectPrepare(Error('Luna unavailable'))
  assert.deepEqual(await input, { action: 'handled' }); assert.equal(r.compactCalls, 0)
  assert.equal(r.deferredInputs[0].data.text, 'Keep exact user input 请保留')
  assert.equal(r.deferredInputs[0].data.images[0].data, 'fixture')
})
test('malformed runtime policy cannot silently release a blocked input to the provider', async () => {
  const r = runtime({ tokens: 99000, readPolicy: () => { throw Error('malformed policy') } })
  assert.deepEqual(await r.handlers.get('input')({ text: 'must survive' }, r.ctx), { action: 'handled' })
  assert.equal(r.deferredInputs[0].data.text, 'must survive'); assert.deepEqual(r.commands, [])
})
test('new oversized input is counted even before Pi persists the user message', async () => {
  const r = runtime({ tokens: 1000, idle: true })
  const text = '新'.repeat(150000)
  assert.deepEqual(await r.handlers.get('input')({ text }, r.ctx), { action: 'handled' })
  assert.equal(r.deferredInputs[0].data.text, text); assert.deepEqual(r.commands, [])
})
test('a large but admissible input recovers by compacting old history before the normal threshold', async () => {
  const r = runtime({ tokens: 60000, idle: true, compactEffect: (ctx, rows) => { rows.splice(0, rows.length - 1); ctx.tokens = 1000 } })
  r.rows[0].messages[0].content = 'compressible history '.repeat(10000)
  const input = r.handlers.get('input')({ text: '新'.repeat(30000) }, r.ctx)
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(r.commands, ['pi-prepare'])
  await r.complete()
  assert.equal(await input, undefined); assert.equal(r.compactCalls, 1)
  assert.equal(r.deferredInputs.length, 1, 'input is preserved before the cancellable wait, including successful recovery')
  assert.equal(r.deferredInputs[0].data.text, '新'.repeat(30000))
})
test('final request gate includes prompt expansion and tool declarations in the actual messages', async () => {
  const r = runtime({ tokens: 1000 })
  await r.handlers.get('before_provider_request')({payload:{ messages: [{ role: 'system', content: '固'.repeat(150000) }] }}, r.ctx)
  assert.equal(r.abortCalls, 1)
})
test('screenshots are budgeted as visual content rather than base64 text', async () => {
  const r = runtime({ tokens: 1000, idle: true })
  const images = [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(1000000) }]
  assert.equal(await r.handlers.get('input')({ text: 'inspect screenshot', images }, r.ctx), undefined)
  r.handlers.get('context_with_system')({ messages: [{ role: 'user', content: images }] }, r.ctx)
  assert.equal(r.abortCalls, 0); assert.equal(r.deferredInputs.length, 0)
})
test('snapshot preserves the full current human request while compressing a long autonomous turn', () => {
  const r = runtime(); r.rows.splice(2, 1)
  const snapshot = makePiSnapshot(r.ctx, { enabled: true, ratio: .8 }, { compaction: { keepRecentTokens: 512 } })
  assert.ok(snapshot.protectedRequest.includes(r.rows[0].messages[0].content))
  assert.ok(snapshotMatches(snapshot, r.rows, snapshot.signature))
})
test('snapshot never leaves a pending tool invocation on the discarded side', () => {
  const r = runtime(); r.rows.splice(2, 0,
    { sourceEntry: { id: 'call', type: 'message' }, messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }] }] },
    { sourceEntry: { id: 'result', type: 'message' }, messages: [{ role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'result '.repeat(500) }] }] })
  const snapshot = makePiSnapshot(r.ctx, { enabled: true, ratio: .8 }, { compaction: { keepRecentTokens: 2048 } })
  assert.notEqual(snapshot?.firstKeptEntryId, 'result')
})
for(const kind of ['text','image'])test('Pi can prepare past an oversized old '+kind+' instead of retaining the entire conversation',()=>{
 const r=runtime()
 r.rows[0].messages[0].content=kind==='image'?[{type:'image',mimeType:'image/png',data:'original'}]:'old evidence '.repeat(20000)
 for(const e of r.rows.slice(1))e.messages[0].content='Recent small message.'
 const snapshot=makePiSnapshot(r.ctx,{enabled:true,ratio:.8,keep:5000},{})
 assert.ok(snapshot)
 assert.equal(snapshot.firstKeptEntryId,'a1')
 assert.ok(snapshot.sourceTokens>estimateSummaryTokens(snapshot.source)||(kind==='text'&&snapshot.sourceTokens>50000))
})
for(const native of [true,false])test('Pi interrupted tools '+(native?'close at a later native human turn':'remain pending across a custom notification'),async()=>{
 const r=runtime()
 r.rows[1].messages[0].content=[{type:'toolCall',id:'abandoned',name:'bash',arguments:{}}]
 r.rows[2].sourceEntry.type=native?'message':'custom_message'
 const snapshot=makePiSnapshot(r.ctx,{enabled:true,ratio:.8},{compaction:{keepRecentTokens:512}})
 assert.equal(snapshot.firstKeptEntryId,native?'a2':'a1')
 if(native){
  const {piForkPlan}=await import('../src/pi-fork.js')
  const full=makePiSnapshot(r.ctx,{enabled:true,ratio:.8,summaryMode:'main-fork'},{compaction:{keepRecentTokens:512}})
  const plan=await piForkPlan(full,{messages:r.rows.flatMap(e=>e.messages)})
  assert.ok(plan.length);assert.equal(plan.at(-1).lastMessage,2)
 }
})
test('durable prepared lookup is read-only, works after appended raw records and invalidates changed models', async t => {
  const f = fixture(t); let generated = 0
  f.input.draftKey = 'a'.repeat(64)
  await preparePi(f.store, f.input, { env: f.env, summarize: async () => { generated++; return summary } })
  appendFileSync(f.input.session_file, JSON.stringify({ type: 'message', id: 'late', parentId: 'c', message: { role: 'user', content: 'later append' } }) + '\n')
  const ready = readPreparedPi(f.store, f.input, { env: f.env })
  assert.equal(ready.compaction.firstKeptEntryId, 'c'); assert.equal(generated, 1)
  assert.match(f.store.exact('pi-pi-test', 4), /later append/)
  assert.equal(readPreparedPi(f.store, { ...f.input, draftKey: 'b'.repeat(64) }, { env: f.env }), null)
  const {forkHash}=await import('../src/fork-summary.js'),{summarySettingsRevision}=await import('../src/summarize.js')
  const oldRevision=forkHash(['pi-api-preparation-v2',readPiPolicy(f.store.dir),summarySettingsRevision(f.store,'pi-pi-test',f.env)])
  f.store.db.prepare('UPDATE pi_prepared_compactions SET revision=? WHERE session=? AND draft_key=?').run(oldRevision,'pi-pi-test',f.input.draftKey)
  assert.equal(readPreparedPi(f.store,f.input,{env:f.env}),null,'a draft checked under the old language policy cannot be installed')
  f.store.db.prepare('UPDATE pi_prepared_compactions SET revision=? WHERE session=? AND draft_key=?').run(ready.compaction.details.summaryRevision,'pi-pi-test',f.input.draftKey)
  assert.deepEqual(readPreparedPi(f.store,f.input,{env:f.env}),ready)
  savePiPolicy(f.store, { enabled: true, ratio: .9 })
  assert.equal(readPreparedPi(f.store, f.input, { env: f.env }), null)
  savePiPolicy(f.store, { enabled: true, ratio: .8 })
  f.store.setHarnessSetting('pi', 'off')
  assert.equal(readPreparedPi(f.store, f.input, { env: f.env }), null)
})
test('Pi subprocess cancellation rejects without a model or orphaned child', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(piCompactRequest({ node: process.execPath, script: '/missing', home: '/missing' }, {}, controller.signal), /取消/)
})
test('Pi worker preserves UTF-8 characters split between stdout chunks',async t=>{
 const f=fixture(t),script=join(f.dir,'split-output.mjs')
 const prepared={compaction:{summary:'# 历史状态\n中文与表情😀必须逐字保留。'}}
 writeFileSync(script,`const data=Buffer.from(${JSON.stringify(JSON.stringify({prepared}))});const cut=data.indexOf(Buffer.from('中'))+1;process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(data.subarray(0,cut));setTimeout(()=>process.stdout.end(data.subarray(cut)),30)});`)
 assert.deepEqual(await piCompactRequest({node:process.execPath,script,home:f.dir,command:'pi-ready'},{},new AbortController().signal),prepared)
})

test('Pi cancellation reaps a worker that ignores SIGTERM',async t=>{
 const f=fixture(t),script=join(f.dir,'stubborn-worker.mjs'),marker=join(f.dir,'pid')
 writeFileSync(script,`import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(marker)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`)
 const controller=new AbortController()
 const work=piCompactRequest({node:process.execPath,script,home:f.dir},{},controller.signal)
 const outcome=assert.rejects(work,/取消/)
 let pid
 for(let i=0;i<200;i++){try{pid=Number(readFileSync(marker,'utf8'));break}catch{};await new Promise(resolve=>setTimeout(resolve,5))}
 assert.ok(pid);controller.abort();await outcome
 let alive=true
 for(let i=0;i<200;i++){try{process.kill(pid,0)}catch{alive=false;break};await new Promise(resolve=>setTimeout(resolve,5))}
 assert.equal(alive,false)
})

test('Pi cold resume may restore a ready draft without a captured provider request',async()=>{
 const r=runtime({tokens:80000,readPolicy:mainForkPolicy,responder:async(opts,snap)=>opts.command==='pi-ready'?{compaction:{summary,firstKeptEntryId:'a2'}}:null})
 r.ctx.model.maxTokens=50000
 try{
  await turn(r)
  assert.equal(r.commands.filter(c=>c==='pi-ready').length,2)
  assert.ok(r.api.getState()?.ready)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi continues the foreground while a receipt-backed oversized estimate prepares in the background',async()=>{
 let started=false,release
 const blocked=new Promise(resolve=>release=resolve)
 const r=runtime({tokens:340000,readPolicy:mainForkPolicy,
  responder:async opts=>opts.command==='pi-stage'?{revision:'fixture'}:null,
  fork:async(_ctx,_snapshot,_capture,{stage})=>{await stage();started=true;return blocked}})
 Object.assign(r.ctx.model,{contextWindow:500000,maxTokens:128000,api:'openai-completions'})
 const original={messages:[{role:'user',content:'证'.repeat(320000)}],max_tokens:128000}
 const current={...original,messages:[...original.messages,{role:'assistant',content:'证'.repeat(9000)}]}
 let work
 try{
  assert.ok(captureRuntime(r,original),'the prior request is accepted')
  r.rows.push({sourceEntry:{id:'receipt',type:'message',parentId:'a2'},messages:[{role:'assistant',provider:'test',model:'chat',stopReason:'toolUse',usage:{input:76,output:4988,cacheRead:341248,cacheWrite:0},content:[{type:'text',text:'completed'}]}]},
   {sourceEntry:{id:'result',type:'message',parentId:'receipt'},messages:[{role:'toolResult',toolCallId:'fixture',content:[{type:'text',text:'done'}]}]})
  r.ctx.tokens=355000
  r.ctx.modelRegistry={streamSimple(_m,_c,options){return {result:async()=>{try{options.onPayload(current)}catch{};return {stopReason:'aborted'}}}}}
  work=r.handlers.get('context_with_system')({messages:[{role:'user',content:'证'.repeat(329000),timestamp:1}]},r.ctx)
  const result=await Promise.race([work.then(()=> 'continued'),new Promise(resolve=>setTimeout(()=>resolve('blocked'),250))])
  assert.equal(result,'continued','a matching recent receipt must prevent a false capacity wait')
  const sent=r.handlers.get('before_provider_request')({payload:current},r.ctx)
  assert.ok(sent);assert.equal(r.abortCalls,0)
  await until(()=>started);assert.ok(r.api.getState()?.promise,'the background summary is still running')
 }finally{r.handlers.get('session_shutdown')();release();await work}
})

test('Pi cold resume waits at the final boundary instead of aborting the foreground before recovery',async()=>{
 let calls=0
 const r=runtime({tokens:80000,readPolicy:mainForkPolicy,responder:async()=>null,fork:async()=>{calls++;return new Promise(()=>{})}})
 r.ctx.model.maxTokens=50000
 const controller=new AbortController();r.ctx.signal=controller.signal;r.ctx.abort=()=>controller.abort()
 try{
  assert.equal(await r.handlers.get('input')({text:'CONTINUE AFTER RESTART'},r.ctx),undefined)
  captureRuntime(r,{messages:[{role:'user',content:'中'.repeat(90000)}],max_tokens:50000})
  await until(()=>calls===1)
  assert.equal(controller.signal.aborted,false)
  assert.ok(r.api.getState()?.promise,'the foreground awaits the captured recovery job without sending')
 }finally{r.handlers.get('session_shutdown')()}
})
test('Pi cold recovery lets a final safe wire request continue while preparing in the background',async()=>{
 let calls=0
 const r=runtime({tokens:80000,readPolicy:mainForkPolicy,responder:async()=>null,fork:async()=>{calls++;return new Promise(()=>{})}})
 r.ctx.model.maxTokens=50000
 const controller=new AbortController();r.ctx.signal=controller.signal;r.ctx.abort=()=>controller.abort()
 try{
  assert.equal(await r.handlers.get('input')({text:'CONTINUE AFTER RESTART'},r.ctx),undefined)
  const payload=await captureRuntime(r)
  await until(()=>calls===1)
  assert.equal(controller.signal.aborted,false,'an earlier estimate must not abort a verified safe wire request')
  assert.ok(payload?.messages);assert.ok(r.api.getState())
 }finally{r.handlers.get('session_shutdown')()}
})
test('Pi oversized final wire request starts earlier-prefix recovery and waits without sending',async()=>{
 let calls=0
 const r=runtime({tokens:99000,readPolicy:mainForkPolicy,responder:async()=>null,fork:async()=>{calls++;return new Promise(()=>{})}})
 r.rows[0].messages[0].content='Large compressible historical evidence. '.repeat(10000)
 const controller=new AbortController();r.ctx.signal=controller.signal;r.ctx.abort=()=>controller.abort()
 try{
  captureRuntime(r,{messages:[{role:'user',content:'中'.repeat(120000)}],max_tokens:50000})
  await until(()=>calls===1)
  assert.equal(controller.signal.aborted,false);assert.ok(r.api.getState()?.promise,'the final provider boundary owns the cancellable wait')
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi automatic native compaction cannot install a prepared summary before its configured ratio',async()=>{
 const r=runtime()
 try{
  await turn(r);await r.complete()
  const event={reason:'threshold',preparation:{tokensBefore:70000}}
  assert.deepEqual(await r.handlers.get('session_before_compact')(event,r.ctx),{cancel:true})
  assert.ok((await r.handlers.get('session_before_compact')({...event,reason:'manual'},r.ctx)).compaction)
  r.ctx.tokens=80000
  assert.ok((await r.handlers.get('session_before_compact')(event,r.ctx)).compaction)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi does not loop on an invalid restored result instead of regenerating it',async t=>{
 let calls=0,prepared
 const r=runtime({readPolicy:mainForkPolicy,responder:async(opts,snap)=>{
  if(opts.command==='pi-ready')return prepared||{compaction:{summary:'invalid restored text',firstKeptEntryId:'a2'}}
  if(opts.command==='pi-stage')return {revision:'staged'}
  return prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}
 },fork:async(_ctx,_snap,_capture,{stage})=>{calls++;await stage();return {blocks:[],tree:[]}}})
 try{
  t.mock.timers.enable({apis:['setTimeout','Date']});captureRuntime(r)
  await until(()=>r.api.getState()?.retryAt)
  t.mock.timers.tick(r.api.getState().retryAt-Date.now())
  await until(()=>r.api.getState()?.ready)
  assert.equal(calls,1)
 }finally{r.handlers.get('session_shutdown')();t.mock.timers.reset()}
})
test('Pi takeover is opt-in and malformed policies fail closed', t => {
  const f = fixture(t)
  assert.deepEqual(readPiPolicy(join(f.dir, 'unconfigured')), { enabled: false, ratio: 0.8,keep:40000,summaryEnabled:false,summaryMode:'main-fork' })
  writeFileSync(join(f.store.dir, 'pi-compaction.json'), '{bad')
  assert.throws(() => readPiPolicy(f.store.dir))
})

test('Pi main-fork stores provider usage and blocks without touching the independent API', async t => {
  const { forkHash } = await import('../src/fork-summary.js')
  const { stagePi } = await import('../src/pi-compaction.js')
  const f = fixture(t)
  savePiPolicy(f.store,{enabled:true,ratio:.8,summaryMode:'main-fork'})
  f.store.clearHarnessSetting('pi')
  const staged=stagePi(f.store,f.input,{env:f.env})
  const input={...f.input,draftKey:'f'.repeat(64),forkRevision:staged.revision,forkSummary:{model:'fixture-main',provider:'fixture',sourceDigest:forkHash(f.input.source),prefixHash:'prefix',requestSettingsHash:'settings',usage:{cacheRead:9000},blocks:[{index:0,firstMessage:1,lastMessage:2,summary}]}}
  const options={env:f.env,summarize:async()=>{throw Error('must not call Luna')}}
  const result=await preparePi(f.store,input,options)
  assert.equal(result.compaction.details.calls,1)
  assert.equal(result.compaction.details.providerUsage.cacheRead,9000)
  assert.equal(result.compaction.details.sourceBlocks.length,1)
  assert.deepEqual(readPreparedPi(f.store,input,{env:f.env}),result)
  savePiPolicy(f.store,{enabled:true,ratio:.9,summaryMode:'main-fork'})
  assert.equal(readPreparedPi(f.store,input,{env:f.env}),null)
  await assert.rejects(preparePi(f.store,input,options),/设置已变化/)
})

test('Pi rejects an Arabic branch for Persian history and installs a corrected draft',async t=>{
  const {forkHash}=await import('../src/fork-summary.js')
  const fa='لطفا این فایل را بخوان و بگو چرا خطا می‌دهد. می‌خواهم که پلاگین را نصب کنی و گزارش بدهی'
  const ar='من فضلك اقرأ هذا الملف وأخبرني لماذا يظهر الخطأ. أريد أن تثبت الإضافة وتكتب لي تقريرا'
  const f=fixture(t);f.entries[1].message.content=fa.repeat(200)
  const original=f.entries.map(JSON.stringify).join('\n')+'\n';writeFileSync(f.input.session_file,original)
  f.input.source=serializePiMessages(f.entries.slice(1,3).map(e=>e.message))
  savePiPolicy(f.store,{enabled:true,ratio:.8,summaryMode:'main-fork'});f.store.clearHarnessSetting('pi')
  const staged=stagePi(f.store,f.input,{env:f.env})
  const input={...f.input,draftKey:'9'.repeat(64),forkRevision:staged.revision,forkSummary:{model:'fixture-main',provider:'fixture',sourceDigest:forkHash(f.input.source),prefixHash:'fixture',requestSettingsHash:'fixture',usage:{},blocks:[{index:0,firstMessage:1,lastMessage:2,summary:'# ملخص\n'+ar}]}}
  await assert.rejects(preparePi(f.store,input,{env:f.env}),/language mismatch/)
  assert.equal(readPreparedPi(f.store,input,{env:f.env}),null)
  assert.equal(readFileSync(f.input.session_file,'utf8'),original)
  input.forkSummary.blocks[0].summary='# وضعیت\n'+fa
  const prepared=await preparePi(f.store,input,{env:f.env})
  assert.ok(prepared.compaction.summary.includes(fa))
  assert.deepEqual(readPreparedPi(f.store,input,{env:f.env}),prepared)
  assert.equal(readFileSync(f.input.session_file,'utf8'),original)
})

for(const fault of [null,'root','tree','missing'])test('Pi saved tree '+(fault?'rejects '+fault:'retains an over-goal tree and reuses it without regeneration'),async t=>{
 const {forkHash,forkTreePlan}=await import('../src/fork-summary.js')
 const f=fixture(t)
 f.entries[1].message.content='Original request: preserve the source and pending inspection. '.repeat(2000)
 f.input.source=serializePiMessages(f.entries.slice(1,3).map(e=>e.message))
 writeFileSync(f.input.session_file,f.entries.map(JSON.stringify).join('\n')+'\n')
 savePiPolicy(f.store,{enabled:true,ratio:.8,summaryMode:'main-fork'})
 const leaves=[{index:0,firstMessage:1,lastMessage:1,entryIds:['a'],summary},
  {index:1,firstMessage:2,lastMessage:2,entryIds:['b'],summary}]
 const tree=forkTreePlan(leaves).map(n=>({...n,summary:n.level?'# Current state\nInspection remains pending. Preserve all original evidence.':n.summary}))
 if(fault==='root')tree.at(-1).summary='# Current state\n'+'pending inspection '.repeat(5000)
 const total=estimateSummaryTokens(tree.map(n=>n.summary).join('\n'))
 const goal=Math.floor(total/1.07),limit=fault==='tree'?total-1:Math.max(1024,total+1)
 if(fault==='missing')tree.pop()
 const staged=stagePi(f.store,f.input,{env:f.env})
 if(!fault)f.store.apiCredential=()=>{throw Error('the native branch must not read an unrelated API credential')}
 const input={...f.input,draftKey:'b'.repeat(64),forkRevision:staged.revision,forkSummary:{
  model:'fixture-main',provider:'fixture',sourceDigest:forkHash(f.input.source),prefixHash:'prefix',requestSettingsHash:'settings',usage:{cacheRead:9000},
  blocks:leaves,tree,treeOptions:{fanout:4,targetTokens:limit}}}
 const options={env:f.env,summarize:async()=>{throw Error('must not regenerate a completed tree')}}
 if(fault){
  await assert.rejects(preparePi(f.store,input,options),fault==='missing'?/层级缺失/:fault==='root'?/摘要仍超出预算/:/总输出预算/)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM pi_prepared_compactions').get().n,0)
  assert.equal(f.store.nodeRows('pi-pi-test',0).length,0)
 }else{
  assert.ok(total>goal)
  const prepared=await preparePi(f.store,input,options)
  assert.deepEqual(prepared.compaction.details.summaryTree.map(n=>n.summary),tree.map(n=>n.summary))
  assert.equal(prepared.compaction.details.providerUsage.cacheRead,9000)
  assert.equal(prepared.compaction.details.calls,1)
  assert.ok(prepared.compaction.summary.includes(tree.at(-1).summary))
  assert.equal(f.store.nodeRows('pi-pi-test',0).length,2)
  assert.equal(f.store.nodeRows('pi-pi-test',1).length,1)
  assert.deepEqual(await preparePi(f.store,input,options),prepared)
  assert.deepEqual(readPreparedPi(f.store,input,{env:f.env}),prepared)
  const currentRevision=prepared.compaction.details.summaryRevision
  for(const oldRevision of [forkHash(['pi-main-fork-tree-v2',readPiPolicy(f.store.dir)]),forkHash(['pi-main-fork-tree-v3',readPiPolicy(f.store.dir)])]){
   f.store.db.prepare('UPDATE pi_prepared_compactions SET revision=? WHERE session=? AND draft_key=?').run(oldRevision,'pi-pi-test',input.draftKey)
   assert.equal(readPreparedPi(f.store,input,{env:f.env}),null,'a fork prepared under the old tree or language policy cannot be installed')
  }
  f.store.db.prepare('UPDATE pi_prepared_compactions SET revision=? WHERE session=? AND draft_key=?').run(currentRevision,'pi-pi-test',input.draftKey)
  const obsolete={...prepared.compaction,summary:'# Obsolete prepared result\n'+'pending '.repeat(20000)}
  f.store.db.prepare('UPDATE pi_prepared_compactions SET compaction=? WHERE session=? AND draft_key=?').run(JSON.stringify(obsolete),'pi-pi-test',input.draftKey)
  assert.equal(readPreparedPi(f.store,input,{env:f.env}),null)
  const repaired=await preparePi(f.store,input,options)
  assert.equal(repaired.compaction.summary,prepared.compaction.summary,'a fresh valid fork can replace an unusable saved draft')
 }
})

test('Pi pressure wait has one deadline even if the backend never resolves', async () => {
  const r = runtime({ guardTimeoutMs: 20 }); await turn(r); r.ctx.tokens = 95000
  const guarded = turn(r)
  const observed = await Promise.race([guarded.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('hung'), 100))])
  await r.complete(); await guarded
  assert.equal(observed, 'settled')
  assert.equal(r.abortCalls, 1)
  assert.equal(r.draft.signal.aborted, true)
  assert.equal(r.api.getState(), null)
})

test('Pi shutdown during a pressure wait cannot purchase a replacement worker', async () => {
  const r = runtime(); await turn(r); r.ctx.tokens = 95000
  const guarded = turn(r)
  r.handlers.get('session_shutdown')()
  r.rejectPrepare(Error('worker cancelled by shutdown'))
  await guarded
  assert.equal(r.commands.filter(c => c === 'pi-prepare').length, 1)
  assert.equal(r.api.getState(), null)
})

test('Pi checks the final native tools payload before dispatching a provider request', () => {
  const r = runtime({ readPolicy: () => ({ enabled: true, summaryEnabled: true, summaryMode: 'main-fork', ratio: .8 }) })
  r.handlers.get('context_with_system')({ messages: [{ role: 'system', content: 'Small system prompt.' }] }, r.ctx)
  r.handlers.get('before_provider_request')({ payload: { messages: [{ role: 'user', content: 'small' }], tools: [{ name: 'large_schema', description: '巨'.repeat(120000) }] } }, r.ctx)
  assert.equal(r.abortCalls, 1)
  assert.equal(r.api.getState(), null)
})

test('Pi final payload reserves the actual requested output limit in API mode too', async () => {
  const r = runtime({ tokens: 1000, readPolicy: () => ({ enabled: true, summaryMode: 'api', ratio: .8 }) })
  const payload={ messages: [{ role: 'user', content: '中'.repeat(15000) }], max_tokens: 90000 }
  const result=await r.handlers.get('before_provider_request')({payload},r.ctx)
  assert.equal(result.max_tokens,18000);assert.equal(payload.max_tokens,90000)
  assert.equal(r.abortCalls, 0)
})
test('Pi does not treat the replacement target as the physical request limit',async()=>{
 const r=runtime({tokens:355646,readPolicy:mainForkPolicy})
 r.ctx.model.contextWindow=500000;r.ctx.model.maxTokens=128000
 r.rows[1].messages[0].usage={input:353120,output:676}
 try{
  const payload={input:[{role:'user',content:'x'.repeat(1604800)}],max_output_tokens:128000}
  const wire=await captureRuntime(r,payload)
  assert.equal(r.abortCalls,0,'a roughly 401K request can still fit the 500K window')
  assert.ok(wire.max_output_tokens<90000,'reduce the output reserve by the actual remaining capacity')
  assert.ok(wire.max_output_tokens>80000)
  assert.deepEqual(wire.input,payload.input);assert.equal(payload.max_output_tokens,128000)
 }finally{r.handlers.get('session_shutdown')()}
})
test('Pi boundary waiting rejects irreducible oversized tools before starting a background model',async()=>{
 const r=runtime({tokens:90000,readPolicy:mainForkPolicy})
 r.ctx.modelRegistry={streamSimple(_model,_context,options){return {result:async()=>{try{options.onPayload({messages:[],tools:[{name:'huge',description:'巨'.repeat(120000)}]})}catch{return {stopReason:'aborted'}}}}}}
 try{
  await r.handlers.get('context_with_system')({messages:r.rows.flatMap(e=>e.messages)},r.ctx)
  assert.equal(r.abortCalls,1);assert.equal(r.api.getState(),null);assert.deepEqual(r.commands,[])
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi waits before dispatch when final wire pressure arrives below the measured preparation line',async()=>{
 let prepared,release,started=false,finished=false
 const gate=new Promise(resolve=>release=resolve)
 const r=runtime({tokens:347674,readPolicy:mainForkPolicy,
  responder:async(opts,snap)=>opts.command==='pi-stage'?{revision:'fixed'}:opts.command==='pi-prepare'?(prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}):prepared||null,
  fork:async(_ctx,_snap,capture,{stage})=>{started=true;assert.equal(capture.payload.max_output_tokens,128000);await stage();await gate;return {blocks:[],tree:[]}}})
 r.ctx.model.contextWindow=500000;r.ctx.model.maxTokens=128000
 r.rows[0].messages[0].content='巨'.repeat(600000)
 r.ctx.modelRegistry={streamSimple(_m,_c,opts){return {result:async()=>{try{opts.onPayload({input:JSON.stringify(_c.messages).includes('Current state')?_c.messages:[{role:'user',content:'x'.repeat(1957600)}],max_output_tokens:128000})}catch{return {stopReason:'aborted'}}}}}}
 let work
 try{
  work=r.handlers.get('context_with_system')({messages:r.rows.flatMap(e=>e.messages)},r.ctx).then(v=>{finished=true;return v})
  await until(()=>started);assert.equal(finished,false);assert.equal(r.abortCalls,0)
  release();const result=await work
  assert.ok(result.input);assert.ok(JSON.stringify(result.input).includes(JSON.stringify(summary).slice(1,-1)))
  assert.equal(r.abortCalls,0)
 }finally{release();r.handlers.get('session_shutdown')();await work}
})

test('Pi API mode can rebuild a pressured request from its verified source boundary',async()=>{
 const r=runtime({tokens:99000}),notices=[]
 r.rows[0].messages[0].content='证'.repeat(100000)
 r.ctx.ui.notify=message=>notices.push(message)
 r.ctx.modelRegistry={streamSimple(_m,context,options){return {result:async()=>{try{options.onPayload({messages:context.messages,max_tokens:1000})}catch{return {stopReason:'aborted'}}}}}}
 let work
 try{
  work=r.handlers.get('context_with_system')({messages:r.rows.flatMap(e=>e.messages)},r.ctx)
  await until(()=>r.commands.includes('pi-prepare'))
  await r.complete()
  const result=await work
  assert.ok(result,JSON.stringify(notices));assert.ok(JSON.stringify(result.messages).includes('Current state'));assert.equal(r.abortCalls,0)
  const entry=await r.handlers.get('turn_end')({entries:[],context:{contextEntries:r.rows}},r.ctx)
  assert.equal(entry.entries.at(-1).type,'compaction')
 }finally{r.handlers.get('session_shutdown')();await work}
})

test('Pi does not falsely force compaction for a receipt-backed encrypted reasoning prefix',async()=>{
 const item={type:'reasoning',id:'rs_large',encrypted_content:'A'.repeat(2000000),summary:[]}
 const r=runtime({tokens:153549,readPolicy:mainForkPolicy,fork:async()=>{throw Object.assign(Error('must not summarize'),{code:'SUPERLCM_PI_INVALID_SUMMARY'})}})
 Object.assign(r.ctx.model,{api:'openai-completions',contextWindow:500000,maxTokens:128000})
 Object.assign(r.rows[1].messages[0],{provider:'test',model:'chat',api:'openai-responses',stopReason:'stop',
  usage:{input:10000,output:4000,reasoning:3500,cacheRead:277147,cacheWrite:0,totalTokens:291147},content:[{type:'thinking',thinking:'',thinkingSignature:JSON.stringify(item)}]})
 r.rows.push({sourceEntry:{id:'edit-failed',type:'context_edit',parentId:'failed-turn',targetId:'failed-turn',replacement:null},messages:[]})
 try{
  r.handlers.get('model_select')({},r.ctx) // Same-model re-selection on resume must not reset state or trigger false pressure.
  const wire=await captureRuntime(r,{input:[item,{role:'user',content:'Continue.'}],max_output_tokens:128000})
  assert.ok(wire,'a safe, receipt-backed 291K request should reach its provider without triggering compaction')
  assert.equal(wire.input[0].encrypted_content,item.encrypted_content)
  assert.equal(r.abortCalls,0);assert.equal(r.api.getState(),null)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi reports the actual response when request-time replacement was used before its checkpoint',async()=>{
 const r=runtime({tokens:99000}),notices=[]
 r.rows[0].messages[0].content='证'.repeat(100000)
 r.ctx.ui.notify=text=>notices.push(text)
 r.ctx.modelRegistry={streamSimple(_m,context,options){return {result:async()=>{try{options.onPayload({messages:context.messages,max_tokens:1000})}catch{return {stopReason:'aborted'}}}}}}
 let work
 try{
  work=r.handlers.get('context_with_system')({messages:r.rows.flatMap(e=>e.messages)},r.ctx)
  await until(()=>r.commands.includes('pi-prepare'));await r.complete();assert.ok(await work)
  r.ctx.tokens=42000
  const message={role:'assistant',provider:'test',model:'chat',stopReason:'toolUse',usage:{input:39000,output:3000,cacheRead:0,cacheWrite:0}}
  const draft=(await r.handlers.get('turn_end')({message,entries:[],context:{contextEntries:r.rows}},r.ctx)).entries.at(-1)
  assert.equal(draft.details.superlcmTokensBefore,99000)
  r.rows.splice(0,3,{sourceEntry:{...draft,id:'saved',tokensBefore:42000},messages:[{role:'compactionSummary',summary:draft.summary}]})
  r.handlers.get('agent_settled')({},r.ctx)
  assert.ok(notices.includes('上下文已压缩（99K-42K）'))
 }finally{r.handlers.get('session_shutdown')();await work}
})

test('Pi background capture retains its original output budget when the foreground cap collapses',async()=>{
 let captured
 const r=runtime({tokens:347674,readPolicy:mainForkPolicy,fork:async(_ctx,_snap,c,{stage})=>{captured=c;await stage();return {blocks:[],tree:[]}}})
 r.ctx.model.contextWindow=500000;r.ctx.model.maxTokens=128000
 try{
  captureRuntime(r,{input:[{role:'user',content:'x'.repeat(1957600)}],max_output_tokens:128000})
  await until(()=>captured)
  assert.equal(captured.payload.max_output_tokens,128000)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi native image payloads count visual tokens instead of encoded image bytes', () => {
  for (const image of [{ type: 'image_url', image_url: { url: 'data:image/png;base64,'+'a'.repeat(1000000) } }, { type: 'input_image', image_url: 'data:image/png;base64,'+'a'.repeat(1000000) }, { inlineData: { mimeType: 'image/png', data: 'a'.repeat(1000000) } }]) {
    const r = runtime({ tokens: 1000 })
    r.handlers.get('before_provider_request')({ payload: { messages: [{ role: 'user', content: [image] }] } }, r.ctx)
    assert.equal(r.abortCalls, 0)
  }
})

test('Pi bounds a compaction callback that never arrives', async () => {
  const r = runtime({ guardTimeoutMs: 20 }); await turn(r); await r.complete()
  r.ctx.tokens = 80000; r.ctx.idle = true
  const result = await Promise.race([r.handlers.get('input')({ text: 'Retain this input while replacing.' }, r.ctx).then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('hung'), 100))])
  assert.equal(result, 'settled'); assert.equal(r.compactCalls, 1)
  assert.equal(r.deferredInputs[0].data.text, 'Retain this input while replacing.')
  r.handlers.get('session_shutdown')()
})

test('Pi late lookup from an old session cannot discard a new ready draft', async () => {
  let release, delay = false
  const r = runtime({ responder: async (opts, snapshot) => {
    if (opts.command === 'pi-prepare') { r.draft.snapshot = snapshot; return { compaction: { summary, firstKeptEntryId: snapshot.firstKeptEntryId } } }
    if (delay) return new Promise(resolve => { release = resolve })
    return { compaction: { summary, firstKeptEntryId: r.draft.snapshot.firstKeptEntryId } }
  } })
  await turn(r); await r.api.getState().promise
  delay = true; const lookup = r.api.ready(r.ctx)
  r.handlers.get('session_before_switch')(); delay = false
  await turn(r); await r.api.getState().promise
  const newer = r.api.getState()
  release({ compaction: { summary, firstKeptEntryId: r.draft.snapshot.firstKeptEntryId } })
  assert.equal(await lookup, null); assert.equal(r.api.getState(), newer)
  r.handlers.get('session_shutdown')()
})

test('Pi late replacement callback cannot clear a new session draft', async () => {
  const r = runtime({ guardTimeoutMs: 1000 }); await turn(r); await r.complete()
  let callbacks
  r.ctx.compact = options => { callbacks = options }
  r.ctx.tokens = 80000; r.ctx.idle = true
  const input = r.handlers.get('input')({ text: 'Input awaiting compaction' }, r.ctx)
  await new Promise(resolve => setImmediate(resolve)); assert.ok(callbacks)
  r.handlers.get('session_before_switch')(); r.ctx.tokens = 70000; r.ctx.idle = false
  await turn(r); await r.api.getState().promise
  const newer = r.api.getState()
  callbacks.onComplete(); await input
  assert.equal(r.api.getState(), newer)
  assert.equal(r.deferredInputs[0].data.text, 'Input awaiting compaction')
  r.handlers.get('session_shutdown')()
})

test('Pi final payload rejects invalid output reservations and covers native Google settings', async () => {
  for (const fields of [{ max_tokens: NaN }, { max_output_tokens: -1 }, { maxTokens: '1000' }]) {
    const r = runtime()
    r.handlers.get('before_provider_request')({ payload: { messages: [{ role: 'user', content: '中'.repeat(3000) }], ...fields } }, r.ctx)
    assert.equal(r.abortCalls, 1)
  }
  const r=runtime(),result=await r.handlers.get('before_provider_request')({payload:{messages:[],generationConfig:{maxOutputTokens:99000}}},r.ctx)
  assert.equal(result.generationConfig.maxOutputTokens,18000);assert.equal(r.abortCalls,0)
})

test('Pi consecutive summary failures back off and a model change clears the old cooldown', async () => {
  const originalNow = Date.now; let now = 0
  Date.now = () => now
  const r = runtime({ responder: async () => { throw Error('synthetic transient summary failure') } })
  const attempt = async () => { await turn(r); await new Promise(resolve => setImmediate(resolve)) }
  try {
    await attempt(); assert.equal(r.commands.length, 1)
    now = 61000; await attempt(); assert.equal(r.commands.length, 2)
    now = 122000; await attempt(); assert.equal(r.commands.length, 2, 'second failure waits two minutes')
    now = 182000; await attempt(); assert.equal(r.commands.length, 3)
    now = 243000; await attempt(); assert.equal(r.commands.length, 3, 'third failure waits four minutes')
    r.ctx.model.id = 'new-model'; await attempt(); assert.equal(r.commands.length, 4)
  } finally { r.handlers.get('session_shutdown')(); Date.now = originalNow }
})

test('Pi treats an empty backend preparation response as a failure that can retry', async () => {
  const originalNow = Date.now; let now = 0
  Date.now = () => now
  const r = runtime({ responder: async () => null })
  try {
    await turn(r); await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.api.getState(), null, 'an empty response must not strand a permanently pending draft')
    now = 61000; await turn(r); await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.commands.length, 2)
  } finally {r.handlers.get('session_shutdown')(); Date.now = originalNow}
})

test('Pi late compaction callbacks cannot discard a draft for a newly selected model', async () => {
  const r = runtime({ guardTimeoutMs: 1000 }); await turn(r); await r.complete()
  let callbacks
  r.ctx.compact = options => { callbacks = options }
  r.ctx.tokens = 80000; r.ctx.idle = true
  const input = r.handlers.get('input')({ text: 'Input during a model change' }, r.ctx)
  await new Promise(resolve => setImmediate(resolve)); assert.ok(callbacks)
  r.ctx.model.id = 'new-model'; r.ctx.tokens = 70000; r.ctx.idle = false
  r.handlers.get('model_select')({}, r.ctx); await r.api.getState().promise
  const newer = r.api.getState()
  callbacks.onComplete(); assert.deepEqual(await input, { action: 'handled' })
  assert.equal(r.api.getState(), newer)
  r.handlers.get('session_shutdown')()
})

test('Pi archives a native summary source with takeover off and background summaries on', t => {
  const f = fixture(t)
  f.store.setHarnessSetting('pi', 'main-fork')
  savePiPolicy(f.store, { enabled: false, ratio: .8 })
  assert.equal(readPiPolicy(f.store.dir).summaryEnabled, true)
  assert.equal(stagePi(f.store, f.input, { env: f.env }).archived, true)
})

test('Pi background failure tolerates a policy that became unreadable during generation', async () => {
  let broken = false
  const r = runtime({ readPolicy: () => { if (broken) throw Error('invalid policy'); return { enabled: true, ratio: .8 } } })
  await turn(r)
  const work = r.api.getState().promise
  broken = true; r.rejectPrepare(Error('synthetic request failure'))
  await assert.doesNotReject(work)
  assert.equal(r.api.getState(), null)
  r.handlers.get('session_shutdown')()
})

test('Pi retention overrides native settings and caps at half of the current dialogue',()=>{
 const rows=Array.from({length:30},(_,i)=>({sourceEntry:{id:'e'+i,type:'message'},messages:[{role:i%2?'assistant':'user',content:[{type:'text',text:'exact original '.repeat(700)}]}]}))
 const ctx={model:{contextWindow:100000},sessionManager:{buildSessionProjection:()=>({entries:rows}),getSessionId:()=> 'retention',getSessionFile:()=>'/fixture',getLeafId:()=> 'e29'},getContextUsage:()=>({tokens:80000})}
 const snapshot=keep=>makePiSnapshot(ctx,{enabled:true,ratio:.8,keep},{compaction:{keepRecentTokens:9999999}})
 const small=snapshot(5000),large=snapshot(40000),capped=snapshot(200000)
 assert.ok(Number(small.firstKeptEntryId.slice(1))>Number(large.firstKeptEntryId.slice(1)))
 assert.equal(capped.firstKeptEntryId,large.firstKeptEntryId)
 assert.notEqual(capped.draftKey,large.draftKey)
 assert.equal(snapshotMatches(large,rows,small.signature),false)
})
test('changing Pi retention invalidates an already prepared API replacement without another model call',async t=>{
 const f=fixture(t);f.input.draftKey='e'.repeat(64)
 let calls=0;await preparePi(f.store,f.input,{env:f.env,summarize:async()=>{calls++;return summary}})
 assert.ok(readPreparedPi(f.store,f.input,{env:f.env}))
 savePiPolicy(f.store,{enabled:true,ratio:.8,keep:80000})
 assert.equal(readPreparedPi(f.store,f.input,{env:f.env}),null);assert.equal(calls,1)
})

test('independent API cannot replace an unseen archived image',async t=>{
 const f=fixture(t);f.entries[1].message.content=[{type:'image',data:'synthetic-image',mimeType:'image/png'}]
 writeFileSync(f.input.session_file,f.entries.map(JSON.stringify).join('\n')+'\n')
 f.input.source=serializePiMessages(f.entries.slice(1,3).map(e=>e.message));let calls=0
 await assert.rejects(compactPi(f.store,f.input,{env:f.env,summarize:async()=>{calls++;return summary}}),/非文本内容/)
 assert.equal(calls,0);assert.ok(f.store.exact('pi-pi-test',1).includes('synthetic-image'))
})
test('an unsuitable standalone API result does not trap the same source in its cache',async t=>{
 const f=fixture(t);f.entries[1].message.content='Historical inspection evidence. '.repeat(100);writeFileSync(f.input.session_file,f.entries.map(JSON.stringify).join('\n')+'\n');const input={...f.input,source:serializePiMessages(f.entries.slice(1,3).map(e=>e.message)),draftKey:'d'.repeat(64)};let calls=0
 const options={env:f.env,summarize:async()=>{calls++;return calls===1?'# State\n'+ 'Inspection remains pending. '.repeat(180):summary}}
 await assert.rejects(preparePi(f.store,input,options),/没有缩短/)
 const result=await preparePi(f.store,input,options);assert.ok(result.compaction);assert.equal(calls,2)
 assert.deepEqual(await readPreparedPi(f.store,input,{env:f.env}),result)
})

test('Pi does not trigger a premature background fork right after compaction or accept a stale 60K draft at 403K',async t=>{
 const f=fixture(t)
 const compactionLeaf={type:'compaction',id:'comp-leaf',parentId:'c',firstKeptEntryId:'b',summary}
 writeFileSync(f.input.session_file,[...f.entries,compactionLeaf].map(JSON.stringify).join('\n')+'\n')
 const prematureInput={...f.input,leafId:'comp-leaf',firstKeptEntryId:'c',draftKey:'b'.repeat(64)}
 await preparePi(f.store,prematureInput,{env:f.env,summarize:async()=>summary})
 assert.equal(readPreparedPi(f.store,prematureInput,{env:f.env}),null,'draft prepared at a compaction leaf must be discarded')
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM pi_prepared_compactions').get().n,0)

 let forks=0,prepared=null
 const r=runtime({tokens:null,readPolicy:mainForkPolicy,
  responder:async(opts,snap)=>opts.command==='pi-stage'?{revision:'fixture'}:opts.command==='pi-prepare'?(prepared={draftKey:snap.draftKey,compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}):prepared,
  fork:async(_ctx,_snap,_capture,{stage})=>{forks++;await stage();return {blocks:[],tree:[]}}})
 r.ctx.model.contextWindow=500000;r.ctx.model.maxTokens=128000
 const prePaid={role:'assistant',provider:'test',model:'chat',stopReason:'toolUse',
  usage:{input:1000,output:500,cacheRead:384715,cacheWrite:0,totalTokens:386215},content:[{type:'text',text:'kept pre-compaction reply '+'evidence '.repeat(2500)}]}
 r.rows.splice(0,r.rows.length,
  {sourceEntry:{id:'c1',type:'compaction',parentId:'t1',firstKeptEntryId:'u1',summary},messages:[{role:'compactionSummary',summary}]},
  {sourceEntry:{id:'u1',type:'message',parentId:'old'},messages:[{role:'user',content:'Kept user turn. '+'detail '.repeat(4000)}]},
  {sourceEntry:{id:'a1',type:'message',parentId:'u1'},messages:[prePaid]},
  {sourceEntry:{id:'t1',type:'message',parentId:'a1'},messages:[{role:'toolResult',toolCallId:'call1',content:[{type:'text',text:'Kept tool result. '+'output '.repeat(4000)}]}]},
 )
 try{
  r.handlers.get('agent_settled')({},r.ctx)
  await tick()
  assert.equal(r.api.getState(),null,'post-compaction kept tail (~100K) must not inherit the 386K pre-compaction receipt and fork at 125K')
  assert.equal(forks,0)

  // Now simulate an early draft covering only u1..a1 (~60K) while 300K of new dialogue accumulates in the tail.
  r.rows.push(
   {sourceEntry:{id:'u2',type:'message',parentId:'c1'},messages:[{role:'user',content:'New post-compaction work. '+'step '.repeat(4000)}]},
   {sourceEntry:{id:'a2',type:'message',parentId:'u2'},messages:[{role:'assistant',provider:'test',model:'chat',stopReason:'stop',usage:{input:350000,output:1000,cacheRead:0,cacheWrite:0,totalTokens:351000},content:[{type:'text',text:'Post-compaction reply.'}]}]},
  )
  r.ctx.tokens=360000
  captureRuntime(r);await until(()=>r.api.getState()?.ready)
  assert.equal(forks,1)
  const earlyCut=r.api.getState().snapshot.firstKeptEntryId
  for(let i=0;i<10;i++){
   r.rows.push({sourceEntry:{id:'late-u-'+i,type:'message',parentId:i===0?'a2':'late-a-'+(i-1)},messages:[{role:'user',content:'Massive later turn '+i+' '+'数据 '.repeat(12000)}]})
   r.rows.push({sourceEntry:{id:'late-a-'+i,type:'message',parentId:'late-u-'+i},messages:[{role:'assistant',content:[{type:'text',text:'Massive later output '+i+' '+'结果 '.repeat(12000)}]}]})
  }
  r.ctx.tokens=403000
  assert.equal(await r.api.ready(r.ctx),null,'stale early draft leaving >300K uncompacted tail must be rejected at 403K')
  await turn(r);await until(()=>r.api.getState()?.ready)
  assert.equal(forks,2,'a fresh snapshot covering the newly accumulated turns must be prepared')
  assert.notEqual(r.api.getState().snapshot.firstKeptEntryId,earlyCut)
  const replaced=await turn(r)
  assert.equal(replaced.entries[0].type,'compaction')
  assert.equal(replaced.entries[0].firstKeptEntryId,r.api.getState().snapshot.firstKeptEntryId)
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi main-fork dynamic retention offsets natural 70%-80% growth and shrinks prefix on oversized root',async()=>{
 const rows=Array.from({length:20},(_,i)=>({sourceEntry:{id:'m'+i,type:'message'},messages:[{role:i%2?'assistant':'user',content:i%2?[{type:'text',text:'step output '.repeat(1200)}]:'user task '.repeat(1200)}]}))
 const ctx={model:{contextWindow:500000},sessionManager:{buildSessionProjection:()=>({entries:rows}),getSessionId:()=> 'dyn',getSessionFile:()=>'/dyn',getLeafId:()=> 'm19'},getContextUsage:()=>({tokens:350000})}
 const snapAt70=makePiSnapshot(ctx,{enabled:true,ratio:.8,keep:40000,summaryMode:'main-fork'},{})
 const snapAt80=makePiSnapshot({...ctx,getContextUsage:()=>({tokens:400000})},{enabled:true,ratio:.8,keep:40000,summaryMode:'main-fork'},{})
 assert.ok(Number(snapAt70.firstKeptEntryId.slice(1))>Number(snapAt80.firstKeptEntryId.slice(1)),'at 70% preparation, natural 50K growth buffer cuts closer to the end to avoid double-retaining')

 const cuts=[],prompts=[];let prepared
 const r=runtime({tokens:75000,readPolicy:mainForkPolicy,
  responder:async(opts,snap)=>{
   if(opts.command==='pi-stage')return {revision:'fixture'}
   if(opts.command==='pi-prepare'){
    if(cuts.length===1)throw Error('Pi 摘要仍超出预算，保留原上下文')
    return prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}
   }
   return prepared||null
  },
  fork:async(_ctx,snap,_capture,{stage,previousFailure})=>{
   await stage();cuts.push(snap.firstKeptEntryId);prompts.push(previousFailure)
   return {blocks:[],tree:[]}
  }})
 r.rows.splice(0,r.rows.length,...Array.from({length:12},(_,i)=>({sourceEntry:{id:'s-'+i,type:'message'},messages:[{role:i%2?'assistant':'user',content:i%2?[{type:'text',text:'Inspection evidence. '.repeat(250)}]:'Original request. '.repeat(250)}]})))
 try{
  captureRuntime(r);await until(()=>r.api.getState()?.ready)
  assert.equal(cuts.length,2,'oversized root shrinks prefix and immediately retries without timed backoff')
  assert.notEqual(cuts[0],cuts[1])
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi calibrates session_compact post-compaction notice from pre-compaction receipts instead of overestimating Chinese tail',async()=>{
 const r=runtime({tokens:350000}),notices=[]
 r.ctx.model.contextWindow=500000
 r.ctx.getSystemPrompt=()=>'中文系统规则与工具定义'.repeat(3000)
 r.ctx.ui.notify=text=>notices.push(text)
 try{
  await turn(r);await r.complete();r.ctx.tokens=400768
  const draft=(await turn(r)).entries[0]
  const checkpoint={...draft,id:'installed-checkpoint',tokensBefore:400399,details:{...draft.details,superlcmTokensBefore:400768}}
  const keptChinese='保留的近期中文代码与命令输出'.repeat(6500)
  r.rows.splice(0,r.rows.length,
   {sourceEntry:checkpoint,messages:[{role:'compactionSummary',summary:draft.summary}]},
   {sourceEntry:{id:draft.firstKeptEntryId,type:'message'},messages:[{role:'assistant',provider:'test',model:'chat',stopReason:'stop',content:[{type:'text',text:keptChinese}]}]})
  r.ctx.sessionManager.getBranch=()=>[
   {id:'sys-0',type:'message',message:{role:'system',content:'中文系统规则与工具定义'.repeat(3000)}},
   {id:'u-0',type:'message',message:{role:'user',content:'初始请求'}},
   {id:'a-0',type:'message',message:{role:'assistant',provider:'test',model:'chat',stopReason:'stop',usage:{input:29830,output:60,cacheRead:0,cacheWrite:0}}},
   {id:'prev-comp',type:'compaction',firstKeptEntryId:'a-0',summary:'old'},
   {id:'post-prev',type:'message',message:{role:'assistant',provider:'test',model:'chat',stopReason:'stop',usage:{input:50000,output:400,cacheRead:29824,cacheWrite:0}}},
   {id:draft.firstKeptEntryId,type:'message',message:{role:'assistant',provider:'test',model:'chat',stopReason:'toolUse',usage:{input:2823,output:385,cacheRead:339712,cacheWrite:0}}},
   {id:'tail-end',type:'message',message:{role:'assistant',provider:'test',model:'chat',stopReason:'toolUse',usage:{input:5059,output:473,cacheRead:392448,cacheWrite:0}}},
   checkpoint,
  ]
  r.handlers.get('session_compact')({},r.ctx)
  assert.deepEqual(notices,['上下文已压缩（401K-88K）'],'uses receipt differential (~88K) rather than inflated character estimate (~180K)')
 }finally{r.handlers.get('session_shutdown')()}
})

test('Pi retries JSON SyntaxError tagged with SUPERLCM_PI_INVALID_SUMMARY using invalid_json correction instead of locking forever',async t=>{
 const failures=[];let prepared
 const r=runtime({readPolicy:mainForkPolicy,
  responder:async(opts,snap)=>opts.command==='pi-stage'?{revision:'fixed'}:opts.command==='pi-prepare'?(prepared={compaction:{summary,firstKeptEntryId:snap.firstKeptEntryId}}):prepared||null,
  fork:async(_ctx,_snap,_capture,{stage,previousFailure})=>{
   await stage();failures.push(previousFailure)
   if(failures.length===1)throw Object.assign(SyntaxError("Expected ',' or ']' after array element in JSON at position 962"),{code:'SUPERLCM_PI_INVALID_SUMMARY'})
   return {blocks:[],tree:[]}
  }})
 try{
  t.mock.timers.enable({apis:['setTimeout','Date']});captureRuntime(r)
  await until(()=>r.api.getState()?.retryAt)
  assert.ok(Number.isFinite(r.api.getState().retryAt),'tagged SyntaxError schedules retry rather than retryAfter=Infinity')
  t.mock.timers.tick(60000)
  await until(()=>r.api.getState()?.ready)
  assert.deepEqual(failures,[null,'invalid_json'])
 }finally{r.handlers.get('session_shutdown')();t.mock.timers.reset()}
})

test('parseForkTree deterministically repairs unescaped quotes, embedded JSON snippets, and missing commas without model retry',()=>{
 const broken=String.raw`{"blocks":[{"index":0,"summary":"# 排查记录
检查了 "ACP" 补丁与回执 {"status": "PROFILE_COMPLETE"} 以及路径 C:\Users\demo"}{"index":1,"summary":"# 总体进展
补丁已修复并继续执行。"},{"index":2,"summary":"# 当前续接
保留 "ACP" 与 "PROFILE_COMPLETE" 原意。",}]}`
 const tree=parseForkTree(broken,[{firstMessage:0,lastMessage:1},{firstMessage:2,lastMessage:3}],undefined,{fanout:2})
 assert.equal(tree.length,3)
 assert.match(tree[0].summary,/"ACP".*"PROFILE_COMPLETE".*C:\\Users\\demo/)
 assert.match(tree[2].summary,/"ACP" 与 "PROFILE_COMPLETE"/)
})

test('Pi calibrates post-compaction notice via measured ratio after mid-session model switch',async()=>{
 const r=runtime({tokens:280000}),notices=[]
 r.ctx.model={contextWindow:400000,provider:'opencodex',id:'google-vertex/gemini-4-hydrogen'}
 r.ctx.getSystemPrompt=()=>'中文系统规则与工具定义'.repeat(2500)
 r.ctx.ui.notify=text=>notices.push(text)
 const oldPrefix='历史中文分析与命令结果'.repeat(18000)
 const keptTail='近期中文排查代码与输出'.repeat(4500)
 r.rows.splice(0,r.rows.length,
  {sourceEntry:{id:'old-1',type:'message'},messages:[{role:'user',content:oldPrefix}]},
  {sourceEntry:{id:'old-2',type:'message'},messages:[{role:'assistant',provider:'opencodex',model:'gpt-6.1-terra',stopReason:'stop',content:[{type:'text',text:oldPrefix}]}]},
  {sourceEntry:{id:'cut-old',type:'message'},messages:[{role:'assistant',provider:'opencodex',model:'gpt-6.1-terra',stopReason:'stop',content:[{type:'text',text:keptTail}]}]},
  {sourceEntry:{id:'gem-last',type:'message'},messages:[{role:'assistant',provider:'opencodex',model:'google-vertex/gemini-4-hydrogen',stopReason:'toolUse',usage:{input:36283,output:1118,cacheRead:284760,cacheWrite:0},content:[{type:'text',text:'最新一轮'}]}]})
 try{
  await turn(r);await r.complete();r.ctx.tokens=330435
  const draft=(await turn(r)).entries[0]
  const checkpoint={...draft,id:'installed-gem',tokensBefore:330126,details:{...draft.details,superlcmTokensBefore:330435}}
  const cutAt=r.rows.findIndex(e=>e.sourceEntry.id===draft.firstKeptEntryId)
  r.rows.splice(0,cutAt,{sourceEntry:checkpoint,messages:[{role:'compactionSummary',summary:draft.summary}]})
  r.ctx.sessionManager.getBranch=()=>[
   {id:'old-1',type:'message',message:{role:'user',content:oldPrefix}},
   {id:draft.firstKeptEntryId,type:'message',message:{role:'assistant',provider:'opencodex',model:'gpt-6.1-terra',stopReason:'stop',usage:{input:4808,output:269,cacheRead:259456,cacheWrite:0}}},
   {id:'gem-last',type:'message',message:{role:'assistant',provider:'opencodex',model:'google-vertex/gemini-4-hydrogen',stopReason:'toolUse',usage:{input:36283,output:1118,cacheRead:284760,cacheWrite:0}}},
   checkpoint,
  ]
  const uncalibrated=Math.round((estimateSummaryTokens(r.ctx.getSystemPrompt())+estimateSummaryTokens(keptTail))/1000)
  r.handlers.get('session_compact')({},r.ctx)
  assert.equal(notices.length,1)
  const reported=Number(notices[0].match(/330K-(\d+)K/)?.[1])
  assert.ok(reported>0&&reported<uncalibrated-10,`expected ratio-calibrated notice (${reported}K) well below raw character estimate (${uncalibrated}K)`)
 }finally{r.handlers.get('session_shutdown')()}
})
