import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore} from '../src/store.js'
import {dshSetupPreview,applyDshSetup} from '../src/dsh-setup.js'
import {dshCompressionSettings,saveDshCompression,controlsPath} from '../src/dsh-controls.js'
import {dshConfiguration} from '../src/dsh-catalog.js'
import {dshEntries,inspectDshTree} from '../src/dsh-connection.js'
import {controlsConfig,readControls} from '../dsh/controls-config.js'
import {consoleLocation,recordConsoleLocation} from '../src/console-location.js'
import {runCommand} from '../src/runtime.js'
import {runInNewContext} from 'node:vm'
import {page} from '../src/web-page.js'
const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8')
async function fixture(t,withModel=true) {
  const dir=mkdtempSync(join(tmpdir(),'slcm-compression-page-')),store=new ClaudeStore(join(dir,'archive')),env={...process.env,DSH_HOME:join(dir,'dsh')}
  t.after(()=>store.close())
  for(const name of ['web','acp']) {
    const folder=join(env.DSH_HOME,'profiles',name);mkdirSync(folder,{recursive:true})
    writeFileSync(join(folder,'package.json'),JSON.stringify({name:'fixture-'+name,private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base']}},dependencies:{}}))
    writeFileSync(join(folder,'cordis.patch.yml'),'# keep native policy\n- id: compaction-basic\n  config:\n    auto: true\n    thresholdRatio: 0.72\n    retainTokens: 24000\n    headroomTokens: 50000\n- id: agent-default-model\n  config:\n    provider: fixture\n    model: original-model\n'+(withModel?'- insert:\n    - id: fixture-adapter\n      name: "@deepseek-ai/dsh-llm-pi-ai"\n      config:\n        providers:\n          fixture:\n            api: openai-responses\n            baseURL: http://127.0.0.1:9/v1\n            apiKey: fixture\n            models:\n              - id: summary-model\n                name: Summary\n                contextWindow: 262144\n':''))
  }
  const plan=await dshSetupPreview(store,{env});await applyDshSetup(store,plan.revision,{env})
  return {store,env}
}
test('DSH optional takeover changes only compaction and reconnect restores original native policy',async t=>{
  const {store,env}=await fixture(t),off=await dshCompressionSettings(store,{env})
  assert.equal(off.archive_only,true);assert.equal(off.enabled,false)
  const provider=off.catalog.providers.find(p=>p.id==='fixture');assert.ok(provider)
  const input={...off,enabled:true,provider_ref:provider.ref,model:'summary-model'}
  const changed=await saveDshCompression(store,input,{env});assert.equal(changed.restart_required,true);assert.equal(changed.enabled,true);assert.notEqual(changed.status,'applied')
  let config=await dshConfiguration({env})
  for(const p of config.profiles) {
    assert.equal(inspectDshTree(p.tree).configured,true)
    assert.equal(dshEntries(p.tree).some(e=>e.name==='@deepseek-ai/dsh-compaction-basic'),false)
    const own=dshEntries(p.tree).find(e=>e.id==='superlcm-global');assert.equal(own.config.nativeConfigs[p.name].thresholdRatio,0.72)
    assert.equal(own.config.nativeConfigs[p.name].retainTokens,24000)
    assert.equal(dshEntries(p.tree).find(e=>e.id==='agent-default-model').config.model,'original-model')
  }
  await assert.rejects(saveDshCompression(store,input,{env}),/已变化/)
  const saved=await saveDshCompression(store,{...changed,enabled:false},{env});assert.equal(saved.enabled,false);assert.equal(readControls(controlsPath(store)).config.auto,false)
  const plan=await dshSetupPreview(store,{env});await applyDshSetup(store,plan.revision,{env})
  config=await dshConfiguration({env})
  for(const p of config.profiles) {
    assert.equal(inspectDshTree(p.tree).archive_only,true)
    const native=dshEntries(p.tree).find(e=>e.name==='@deepseek-ai/dsh-compaction-basic');assert.equal(native.config.thresholdRatio,0.72);assert.equal(native.config.retainTokens,24000)
    assert.ok(!p.patch.includes('optional DSH takeover'));assert.ok(p.patch.includes('# keep native policy'))
  }
})
test('off saves without a summary route; on rejects missing route without touching files',async t=>{
  const {store,env}=await fixture(t,false),initial=await dshCompressionSettings(store,{env})
  const saved=await saveDshCompression(store,{...initial,enabled:false,minRetainTokens:40000},{env})
  assert.equal(readControls(controlsPath(store)).config.minRetainTokens,40000)
  const before=(await dshConfiguration({env})).profiles.map(p=>p.patch),raw=readFileSync(controlsPath(store),'utf8')
  await assert.rejects(saveDshCompression(store,{...saved,enabled:true},{env}),/模型/)
  assert.deepEqual((await dshConfiguration({env})).profiles.map(p=>p.patch),before);assert.equal(readFileSync(controlsPath(store),'utf8'),raw)
  assert.doesNotThrow(()=>controlsConfig({auto:false}));assert.throws(()=>controlsConfig({auto:true}),/模型/)
})
test('console links use the recorded port or explicit public address, never DSH credentials',()=>{
  const store={dir:mkdtempSync(join(tmpdir(),'slcm-console-link-'))}
  assert.equal(consoleLocation(store,{}).port,8791);recordConsoleLocation(store,9123);assert.equal(consoleLocation(store,{}).port,9123)
  assert.equal(consoleLocation(store,{SUPERLCM_CONSOLE_URL:'https://example.com/console'}).url,'https://example.com/console#compression/dsh')
  for(const url of ['file:///tmp/config','https://user:pass@example.com','https://example.com/?token=secret'])assert.throws(()=>consoleLocation(store,{SUPERLCM_CONSOLE_URL:url}))
  assert.doesNotMatch(source('dsh/ui/client.js'),/superlcm\/save|type:'(?:checkbox|number)'|<input|<select/)
  assert.match(source('dsh/ui/client.js'),/target.search=''/)
})
test('dedicated navigation, accessible tabs and DSH deep links select independent panels',()=>{
  const html=page('fixture');assert.ok(html.indexOf('data-view="connect"')<html.indexOf('data-view="compression"'));assert.ok(html.indexOf('data-view="compression"')<html.indexOf('data-view="settings"'))
  assert.ok(!html.includes('data-sec="compact"'))
  const buttons=['claude-code','dsh'].map(tool=>({dataset:{compressionTool:tool},setAttribute(k,v){this[k]=v},focus(){this.focused=true}}))
  const panels=['claude-code','dsh'].map(tool=>({dataset:{compression:tool},hidden:false}))
  const context={state:{},document:{querySelectorAll:selector=>selector==='[data-compression-tool]'?buttons:panels,querySelector:selector=>buttons.find(b=>selector.includes(b.dataset.compressionTool))},history:{replaceState(_a,_b,hash){context.hash=hash}},dshControls:{value:{},loading:false},renderDshControls(){context.loaded=true},act(){throw Error('unexpected API call')},$(){return null}}
  runInNewContext(source('src/web-compression.js')+'\ncompressionSection("dsh")',context)
  assert.equal(context.hash,'#compression/dsh');assert.equal(panels[0].hidden,true);assert.equal(panels[1].hidden,false);assert.equal(buttons[1]['aria-selected'],'true');assert.equal(context.loaded,true)
  buttons[1].onkeydown({key:'Home',preventDefault(){}});assert.equal(panels[0].hidden,false);assert.equal(buttons[0].focused,true)
})

test('failed official CLI validation rolls back the opt-in graph and leaves saved controls unchanged',async t=>{
  const {store,env}=await fixture(t),initial=await dshCompressionSettings(store,{env}),provider=initial.catalog.providers.find(p=>p.id==='fixture')
  const before=await dshConfiguration({env}),globalFile=join(env.DSH_HOME,'cordis.patch.yml'),globalRaw=readFileSync(globalFile,'utf8')
  const run=async(...args)=>{if(readFileSync(globalFile,'utf8').includes('archiveOnly: false'))throw Error('fixture secret: validation failure');return runCommand(...args)}
  await assert.rejects(saveDshCompression(store,{...initial,enabled:true,provider_ref:provider.ref,model:'summary-model'},{env,runCommand:run}),error=>/已恢复原配置/.test(error.message)&&!error.message.includes('fixture secret'))
  assert.equal(readFileSync(globalFile,'utf8'),globalRaw)
  assert.deepEqual((await dshConfiguration({env})).profiles.map(p=>p.patch),before.profiles.map(p=>p.patch))
  assert.equal(readControls(controlsPath(store)),null)
})
test('COMMIT failure restores the control file and native graph; read failures never expose host stderr',async t=>{
  const {store,env}=await fixture(t),initial=await dshCompressionSettings(store,{env}),provider=initial.catalog.providers.find(p=>p.id==='fixture')
  const before=await dshConfiguration({env}),globalFile=join(env.DSH_HOME,'cordis.patch.yml'),globalRaw=readFileSync(globalFile,'utf8')
  const original=store.db.exec.bind(store.db);let fail=true
  store.db.exec=command=>{if(command==='COMMIT'&&fail){fail=false;throw Error('fixture COMMIT secret')}return original(command)}
  try {await assert.rejects(saveDshCompression(store,{...initial,enabled:true,provider_ref:provider.ref,model:'summary-model'},{env}),error=>!error.message.includes('secret'))}finally{store.db.exec=original}
  assert.equal(readControls(controlsPath(store)),null);assert.equal(readFileSync(globalFile,'utf8'),globalRaw)
  assert.deepEqual((await dshConfiguration({env})).profiles.map(p=>p.patch),before.profiles.map(p=>p.patch))
  await assert.rejects(dshCompressionSettings(store,{env,runCommand:async()=>{throw Error('fixture apiKey=secret')}}),error=>!error.message.includes('secret')&&/宿主日志/.test(error.message))
})
test('closing and stale-version owners remain pending until current engine and archive acknowledge',()=>{
  const value={enabled:false,archive_only:false,controls_installed:true,settings_revision:'off',expected_version:'new',installed_version:'new'},node={},badge={}
  const context={dshControls:{value},admin:{compression:{runtimes:[{kind:'engine',live:true,enabled:true,route_ready:true,settings_revision:'on',version:'new',pid:1,profile:'web'}]}},$:()=>node,t:x=>x,renderCompressionOwner(_id,enabled,pending){Object.assign(badge,{enabled,pending})}}
  const code=source('src/web-dsh-controls.js'),status=code.slice(code.indexOf('function dshSettingsStatus()'),code.indexOf('function renderDshControls()'))
  runInNewContext(status+'dshSettingsStatus()',context);assert.equal(badge.pending,true)
  const engine=context.admin.compression.runtimes[0];Object.assign(engine,{enabled:false,settings_revision:'off',version:'old'})
  runInNewContext(status+'dshSettingsStatus()',context);assert.equal(badge.pending,true)
  engine.version='new';context.admin.compression.runtimes.push({kind:'archive',live:true,version:'new',pid:2,profile:'web'})
  runInNewContext(status+'dshSettingsStatus()',context);assert.equal(badge.pending,true)
  context.admin.compression.runtimes[1].pid=1;runInNewContext(status+'dshSettingsStatus()',context);assert.equal(badge.pending,false)
})

test('bundle re-enable only resumes archiving and never opts into compaction',()=>{
  const code=source('dsh/ui/index.js'),start=code.indexOf('  let prior=selected()'),end=code.indexOf('timer.unref()',start)
  let selected=true,document={config:{auto:true},revision:'on'},callback
  const context={selected:()=>selected,setInterval(fn){callback=fn;return {}},store:{dir:'fixture',setIntegrationEnabled(_h,x){context.integration=x},db:{exec(){}}},config:{archiveOnly:false},readControls:()=>JSON.parse(JSON.stringify(document)),controlsPath:()=>'/fixture',randomUUID:()=> 'changed',writeFileSync(_p,raw){document=JSON.parse(raw)},renameSync(){},ctx:{logger:{warn(){throw Error('unexpected failure')}}},join:(...x)=>x.join('/')}
  runInNewContext(code.slice(start,end),context)
  selected=false;callback();assert.equal(document.config.auto,false);assert.equal(context.integration,false)
  selected=true;callback();assert.equal(document.config.auto,false);assert.equal(context.integration,true)
})
