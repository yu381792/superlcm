import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore} from '../src/store.js'
import {applyTakeover} from '../src/takeover.js'
import {forkPreparationThreshold} from '../src/main-fork.js'
import {saveForkModel} from '../src/fork-model-controls.js'
import {piCompressionSettings,savePiCompression} from '../src/pi-controls.js'
import {savePiPolicy} from '../src/pi-compaction-policy.js'
import {automaticRatios} from '../dsh/ratio-policy.js'

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'slcm-ratio-models-')),store=new ClaudeStore(join(home,'lcm'))
  const claude=join(home,'claude');mkdirSync(claude)
  const env={...process.env,CLAUDE_CONFIG_DIR:claude}
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true})})
  return {store,env,file:join(claude,'settings.json')}
}
test('Claude 50% replaces the old absolute window override and prepares at 40% of the window Claude Code compacts in',t=>{
  const {store,env,file}=fixture(t)
  const original={autoCompactWindow:190000,env:{USER_SETTING:'preserved'}}
  writeFileSync(file,JSON.stringify(original))
  applyTakeover(store,{enabled:true,window:300000},env)
  const saved=applyTakeover(store,{enabled:true,ratio:.5},env)
  assert.equal(saved.ratio,.5)
  const actual=JSON.parse(readFileSync(file))
  assert.equal(actual.autoCompactWindow,190000)
  assert.equal(actual.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,undefined)
  assert.equal(actual.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,'50')
  const runtime={takeover:()=>store.takeover(),metadata:()=>({harness:'claude-code'})}
  // Claude Code still caps the window at the kept autoCompactWindow (190K), so it compacts at 50% of 170K whatever the model.
  assert.equal(forkPreparationThreshold(runtime,'s',200000,env),68000)
  assert.equal(forkPreparationThreshold(runtime,'s',1000000,env),68000)
  applyTakeover(store,{enabled:false},env)
  assert.deepEqual(JSON.parse(readFileSync(file)),original)
})
test('invalid ratios cannot change settings; Pi and DSH use exactly ten percentage points of lead',t=>{
  const {store,env,file}=fixture(t)
  writeFileSync(file,'{}')
  const before=store.takeover()
  for(const ratio of [.1,1,NaN])assert.throws(()=>applyTakeover(store,{enabled:true,ratio},env),/比例/)
  assert.deepEqual(store.takeover(),before);assert.equal(readFileSync(file,'utf8'),'{}')
  for(const ratio of [.11,.5,.8,.99]){
    const policy=piCompressionSettings(store)
    const saved=savePiCompression(store,{revision:policy.revision,enabled:false,ratio})
    assert.ok(Math.abs(saved.prepare_ratio-(ratio-.1))<1e-12)
    assert.ok(Math.abs(automaticRatios(ratio).prepareRatio-(ratio-.1))<1e-12)
  }
})
test('native model selection comes from the tool catalog and invalidates Pi prepared-policy revisions',async t=>{
  const {store}=fixture(t),before=piCompressionSettings(store)
  const catalog=async harness=>{assert.equal(harness,'pi');return {models:[{id:'fixture/alternate'}]}}
  await saveForkModel(store,{harness:'pi',model:'fixture/alternate',expected:{mode:'main-fork',model:null}},{catalog})
  const selected=piCompressionSettings(store)
  savePiPolicy(store,{enabled:false,ratio:.5,summaryMode:'main-fork'})
  assert.equal(piCompressionSettings(store).summaryModel,'fixture/alternate')
  assert.equal(selected.summaryModel,'fixture/alternate');assert.notEqual(selected.revision,before.revision)
  await assert.rejects(saveForkModel(store,{harness:'pi',model:'invented',expected:{mode:'main-fork',model:'fixture/alternate'}},{catalog}),/模型列表/)
  assert.equal(store.harnessSetting('pi').model,'fixture/alternate')
  await saveForkModel(store,{harness:'pi',model:null,expected:{mode:'main-fork',model:'fixture/alternate'}},{catalog:()=>{throw Error('clearing needs no catalog')}})
  assert.equal(piCompressionSettings(store).summaryModel,undefined)
})
test('a slow native catalog response cannot re-enable an explicitly disabled summary route',async t=>{
  const {store}=fixture(t)
  const catalog=async()=>{store.setHarnessSetting('pi','off');return {models:[{id:'fixture/alternate'}]}}
  await assert.rejects(saveForkModel(store,{harness:'pi',model:'fixture/alternate',expected:{mode:'main-fork',model:null}},{catalog}),/已变化/)
  assert.equal(store.harnessSetting('pi').mode,'off')
})

test('a native summary model cannot be assigned to a global or unsupported harness route',t=>{
 const {store}=fixture(t)
 assert.throws(()=>store.setGlobalSetting('main-fork','some-model'))
 assert.throws(()=>store.setHarnessSetting('codex','main-fork','some-model'))
 assert.equal(store.harnessSetting('codex'),null)
})
