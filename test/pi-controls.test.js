import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { piExtension } from '../src/pi.js'
import { runInNewContext } from 'node:vm'
import { ClaudeStore } from '../src/store.js'
import { piCompressionSettings, savePiCompression } from '../src/pi-controls.js'
import { piPolicyPath } from '../src/pi-compaction-policy.js'
import { startWeb } from '../src/web.js'
import { page } from '../src/web-page.js'

function fixture(t) {
  const store = new ClaudeStore(mkdtempSync(join(tmpdir(), 'superlcm-pi-controls-')))
  t.after(() => store.close())
  const model = store.saveApiModel({ provider: 'openai', url: 'http://127.0.0.1:9/v1', model: 'fixture-luna', effort: 'high' })
  return { store, model }
}
test('Pi reports a failed SuperLcm tool call as a tool failure', async t => {
  const { store } = fixture(t), handlers = new Map(), registered = new Map()
  const path = join(store.dir, 'extension.mjs'), cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
  writeFileSync(path, piExtension({ node: process.execPath, script: cli, home: store.dir }))
  const extension = (await import(pathToFileURL(path))).default
  extension({ on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]) }, registerTool(tool) { registered.set(tool.name, tool) }, registerCommand() {} })
  const ctx = { sessionManager: { getSessionId: () => null, getSessionFile: () => null }, ui: { notify(message) { throw Error(message) } } }
  try {
    await handlers.get('session_start').at(-1)({}, ctx)
    const tool = registered.get('lcm_read'); assert.ok(tool)
    const result = await tool.execute('missing', { conversation: 'missing-conversation', from: 0 }, new AbortController().signal).then(value => ({ value }), error => ({ error }))
    assert.ok(result.error || result.value?.isError === true, 'a failed lookup must not be reported as success')
    const find = await registered.get('lcm_find').execute('success', {}, new AbortController().signal)
    assert.notEqual(find.isError, true); assert.match(find.content[0].text, /conversations/)
  } finally { await handlers.get('session_shutdown').at(-1)({}, ctx) }
})

test('Pi console persists the same policy and summary route consumed by the extension', t => {
  const { store, model } = fixture(t), before = piCompressionSettings(store)
  const saved = savePiCompression(store, { revision: before.revision, enabled: true, ratio: .8, summaryMode:'api', api_ref: model.id })
  assert.equal(saved.enabled, true); assert.equal(saved.api_ref, model.id)
  assert.ok(Math.abs(saved.prepare_ratio - .7) < 1e-10)
  assert.equal(saved.summary.model, 'fixture-luna'); assert.equal(saved.summary.effort, 'high')
  assert.deepEqual(JSON.parse(readFileSync(piPolicyPath(store.dir))), { enabled: true, ratio: .8,keep:40000,summaryMode:'api' })
  assert.equal(store.harnessSetting('pi').api_ref, model.id)
  assert.throws(() => savePiCompression(store, { revision: before.revision, enabled: false, ratio: .8, summaryMode:'api', api_ref: model.id }), /已变化/)
  const changed = store.saveApiModel({ id: model.id, provider: 'openai', url: model.url, model: 'other-model' })
  assert.ok(changed); assert.throws(() => savePiCompression(store, { ...saved, enabled: false }), /已变化/)
})
test('turning takeover off preserves its independently configured summary route',t=>{
  const {store,model}=fixture(t)
  const initial=savePiCompression(store,{...piCompressionSettings(store),enabled:true,summaryMode:'api',api_ref:model.id})
  const off=savePiCompression(store,{...initial,enabled:false})
  assert.equal(off.enabled,false);assert.equal(off.summaryEnabled,true);assert.equal(off.api_ref,model.id)
  assert.equal(store.harnessSetting('pi').mode,'api')
})
test('a newer writer before lock acquisition makes the older page stale', t => {
  const { store, model } = fixture(t), other = new ClaudeStore(store.dir)
  t.after(() => other.close())
  const initial = savePiCompression(store, { ...piCompressionSettings(store), enabled: true, summaryMode:'api', api_ref: model.id })
  const original = store.db.exec.bind(store.db); let intercept = true
  store.db.exec = command => {
    if (command === 'BEGIN IMMEDIATE' && intercept) { intercept = false; savePiCompression(other, { ...initial, ratio: .9 }) }
    return original(command)
  }
  try { assert.throws(() => savePiCompression(store, { ...initial, ratio: .7 }), /已变化/) }
  finally { store.db.exec = original }
  assert.equal(piCompressionSettings(store).ratio, .9)
})
test('invalid routes and ratios cannot partly save a Pi takeover policy', t => {
  const { store, model } = fixture(t), before = piCompressionSettings(store)
  for (const fields of [{ ratio: 1 }, { api_ref: null }, { api_ref: 'missing' }, { enabled: 'true' }]) {
    assert.throws(() => savePiCompression(store, { ...before, summaryMode:'api', api_ref: model.id, enabled: true, ...fields }))
    assert.deepEqual(piCompressionSettings(store), before); assert.equal(store.harnessSetting('pi'), null)
  }
  const off = savePiCompression(store, { ...before, enabled: false, api_ref: null })
  assert.equal(off.enabled, false); assert.equal(off.summary, null)
})
test('database commit failure restores both prior Pi policy bytes and model route', t => {
  const { store, model } = fixture(t)
  const initial = savePiCompression(store, { ...piCompressionSettings(store), enabled: true, summaryMode:'api', api_ref: model.id })
  const raw = readFileSync(piPolicyPath(store.dir), 'utf8'), original = store.db.exec.bind(store.db)
  store.db.exec = command => { if (command === 'COMMIT') throw Error('synthetic commit failure'); return original(command) }
  try { assert.throws(() => savePiCompression(store, { ...initial, enabled: false, ratio: .9 }), /commit failure/) }
  finally { store.db.exec = original }
  assert.equal(readFileSync(piPolicyPath(store.dir), 'utf8'), raw)
  assert.deepEqual(piCompressionSettings(store), initial)
})
test('rollback receipt failure still restores the policy file after an actual rollback', t => {
  const { store, model } = fixture(t)
  const initial = savePiCompression(store, { ...piCompressionSettings(store), enabled: true, summaryMode:'api', api_ref: model.id })
  const second = store.saveApiModel({ provider: 'openai', url: model.url, model: 'other' })
  const raw = readFileSync(piPolicyPath(store.dir), 'utf8'), original = store.db.exec.bind(store.db)
  store.db.exec = command => { if (command === 'COMMIT') { original('ROLLBACK'); throw Error('synthetic ended transaction') }; return original(command) }
  try { assert.throws(() => savePiCompression(store, { ...piCompressionSettings(store), api_ref: second.id, ratio: .9 }), /ended transaction/) }
  finally { store.db.exec = original }
  assert.equal(readFileSync(piPolicyPath(store.dir), 'utf8'), raw); assert.equal(store.harnessSetting('pi').api_ref, initial.api_ref)
})
test('a lost successful COMMIT receipt retains consistent saved model and policy', t => {
  const { store, model } = fixture(t)
  const initial = piCompressionSettings(store), original = store.db.exec.bind(store.db)
  store.db.exec = command => { const result = original(command); if (command === 'COMMIT') throw Error('synthetic lost receipt'); return result }
  let saved
  try { saved = savePiCompression(store, { ...initial, enabled: true, summaryMode:'api', api_ref: model.id, ratio: .9 }) }
  finally { store.db.exec = original }
  assert.equal(saved.ratio, .9); assert.equal(saved.api_ref, model.id)
  assert.equal(piCompressionSettings(store).revision, saved.revision)
})
test('actual HTTP Pi settings endpoint round-trips policy and rejects stale and foreign writes', async t => {
  const { store, model } = fixture(t)
  const web = await startWeb({ store: new ClaudeStore(store.dir), discovery: async () => [], nameRefreshMs: 0 })
  t.after(() => web.close())
  const base = new URL(web.url).origin
  const before = await fetch(base + '/api/pi-compression').then(response => response.json())
  const body = { ...before, enabled: true, ratio: .85, summaryMode:'api', api_ref: model.id }
  const post = (origin = base) => fetch(base + '/api/pi-compression', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
  assert.equal((await post('http://foreign.invalid')).status, 403)
  const response = await post(); assert.equal(response.status, 200)
  const saved = await response.json(); assert.equal(saved.ratio, .85)
  assert.equal((await post()).status, 400)
  assert.deepEqual(await fetch(base + '/api/pi-compression').then(r => r.json()), saved)
})
test('Pi compression deep link and keyboard navigation select the independent Pi panel', () => {
  const html = page('fixture'); assert.match(html, /id="compression-pi"/)
  const buttons = ['claude-code', 'dsh', 'pi'].map(tool => ({ dataset: { compressionTool: tool }, setAttribute(k, v) { this[k] = v }, focus() { this.focused = true } }))
  const panels = buttons.map(button => ({ dataset: { compression: button.dataset.compressionTool } }))
  const context = { state: {}, document: { querySelectorAll: selector => selector === '[data-compression-tool]' ? buttons : panels, querySelector: selector => buttons.find(b => selector.includes(b.dataset.compressionTool)) },
    history: { replaceState(_a, _b, hash) { context.hash = hash } }, piControls: { value: {}, loading: false }, renderPiControls() { context.loaded = true }, act() { throw Error('unexpected request') } }
  runInNewContext(readFileSync(new URL('../src/web-compression.js', import.meta.url), 'utf8') + '\ncompressionSection("pi")', context)
  assert.equal(context.hash, '#compression/pi'); assert.equal(panels[2].hidden, false); assert.equal(panels[0].hidden, true); assert.equal(context.loaded, true)
  buttons[2].onkeydown({ key: 'ArrowRight', preventDefault() {} }); assert.equal(panels[0].hidden, false)
  buttons[0].onkeydown({ key: 'End', preventDefault() {} }); assert.equal(panels[2].hidden, false)
})

test('saving disabled takeover cannot re-enable an independently disabled summary writer',t=>{
 const {store}=fixture(t);store.setHarnessSetting('pi','off')
 const before=piCompressionSettings(store)
 const saved=savePiCompression(store,{revision:before.revision,enabled:false,ratio:.8})
 assert.equal(saved.summaryEnabled,false);assert.equal(store.harnessSetting('pi').mode,'off')
 assert.throws(()=>savePiCompression(store,{revision:saved.revision,enabled:true,ratio:.8}),/开启后台摘要/)
 assert.equal(store.harnessSetting('pi').mode,'off')
})

test('disconnecting Pi disables both policies for an already loaded extension',t=>{
 const {store}=fixture(t);const before=piCompressionSettings(store)
 savePiCompression(store,{revision:before.revision,enabled:true,ratio:.8})
 store.setIntegrationEnabled('pi',false)
 const stopped=piCompressionSettings(store);assert.equal(stopped.enabled,false);assert.equal(stopped.summaryEnabled,false)
})

for(const concurrent of [null,'ratio','keep'])test('saving a Pi native model preserves pending drafts without absorbing concurrent policy edits: '+concurrent,async()=>{
 const {runInNewContext}=await import('node:vm')
 const before={enabled:true,ratio:.8,keep:40000,summaryMode:'main-fork',revision:'before'}
 const fresh={...before,ratio:concurrent==='ratio'?.9:.8,keep:concurrent==='keep'?20000:40000,summaryModel:'native/other',revision:'after'}
 const context={api:async path=>{assert.equal(path,'/api/pi-compression');return fresh},t:text=>text,before}
 runInNewContext(readFileSync(new URL('../src/web-pi-controls.js',import.meta.url),'utf8')+`;renderPiControls=()=>{};piControls.value=before;piControls.draft={...before,ratio:.5,customRatio:true,keep:80000,customKeep:false};globalThis.refresh=refreshPiAfterModelChange;globalThis.controls=piControls`,context)
 await context.refresh()
 assert.equal(context.controls.draft.ratio,.5)
 assert.equal(context.controls.draft.revision,concurrent?'before':'after')
 assert.equal(context.controls.draft.customRatio,true)
 assert.equal(context.controls.draft.keep,80000)
 assert.equal(!!context.controls.error,!!concurrent)
})

test('Pi retains custom recent originals across older clients and rejects malformed retention atomically',t=>{
 const {store}=fixture(t)
 const saved=savePiCompression(store,{...piCompressionSettings(store),enabled:false,keep:35000})
 assert.equal(saved.keep,35000);assert.equal(JSON.parse(readFileSync(piPolicyPath(store.dir))).keep,35000)
 const {keep,...legacy}=saved
 assert.equal(savePiCompression(store,legacy).keep,35000)
 for(const keep of [null,0,4999,200001,NaN,Infinity,5000.5,'40000']) {
  const before=piCompressionSettings(store),raw=readFileSync(piPolicyPath(store.dir),'utf8')
  assert.throws(()=>savePiCompression(store,{...before,keep}),/原文保留/)
  assert.equal(readFileSync(piPolicyPath(store.dir),'utf8'),raw)
  assert.equal(piCompressionSettings(store).revision,before.revision)
 }
})
