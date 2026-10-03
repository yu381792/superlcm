// Existing DSH, temporary profiles and actual staged package; no model calls.
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ClaudeStore } from '../src/store.js'
import { dshSetupPreview,applyDshSetup } from '../src/dsh-setup.js'
import { dshHost,dshEntries } from '../src/dsh-connection.js'
import { runCommand } from '../src/runtime.js'
const dir=mkdtempSync(join(tmpdir(),'superlcm-install-verify-')),env={...process.env,DSH_HOME:join(dir,'dsh')}
const folder=join(env.DSH_HOME,'profiles/web');mkdirSync(folder,{recursive:true})
writeFileSync(join(folder,'package.json'),JSON.stringify({name:'dsh-profile-web',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base']}},dependencies:{}}))
writeFileSync(join(folder,'cordis.patch.yml'),'# Keep original\n- id: agent-default-model\n  config:\n    provider: local-fixture\n    model: deterministic\n')
const store=new ClaudeStore(join(dir,'custom-archive'))
try {
  let p=await dshSetupPreview(store,{env});assert.equal(p.can_apply,true)
  const installed=await applyDshSetup(store,p.revision,{env})
  const patch=readFileSync(p.files.hooks,'utf8'),manifest=readFileSync(p.files.mcp,'utf8'),link=realpathSync(join(folder,'node_modules/superlcm-mcp'))
  p=await dshSetupPreview(store,{env});let calls=0
  await assert.rejects(applyDshSetup(store,p.revision,{env,runCommand:async(...args)=>++calls===1?runCommand(...args):{stdout:'[]'}}),/已恢复原配置/)
  assert.equal(readFileSync(p.files.hooks,'utf8'),patch);assert.equal(readFileSync(p.files.mcp,'utf8'),manifest)
  assert.equal(realpathSync(join(folder,'node_modules/superlcm-mcp')),link)
  const stale=await dshSetupPreview(store,{env});writeFileSync(stale.files.hooks,patch+'\n# Concurrent edit\n')
  await assert.rejects(applyDshSetup(store,stale.revision,{env}),/配置已变化/)
  const host=dshHost(env), load=async name=>import(pathToFileURL(host.require.resolve(name)).href)
  const expression=host.parse('modelPolicies: !!js ctx.userOwnedModelPolicies')
  assert.match(host.yaml.dump(expression,{schema:host.schema}),/!!js ctx\.userOwnedModelPolicies/)
  const {Context}=await load('@deepseek-ai/cordis'),{SessionStore}=await load('@deepseek-ai/dsh-session')
  const {default:Projections}=await load('@deepseek-ai/dsh-session-projection'),{default:Meter}=await load('@deepseek-ai/dsh-token-meter')
  const {default:Engine}=await import(pathToFileURL(join(installed.package,'dsh/engine.js')).href)
  const composed=host.parse((await runCommand(host.bin,[...host.argsPrefix,'--profile','web','--dump-config'],{env})).stdout)
  const actualConfig=dshEntries(composed).find(e=>e.name==='superlcm-mcp/dsh-engine').config
  const ctx=new Context()
  try {
    new SessionStore(ctx);new Projections(ctx)
    ctx.reflect.provide('llm',{async *stream(){throw Error('No model call allowed')},imageRequestPricing(){},fileRequestText(){}})
    new Meter(ctx);new Engine(ctx,{...actualConfig,auto:false})
    assert.equal(ctx.compaction.superLcmStore.path,join(store.dir,'lcm.sqlite'))
  } finally {await ctx.fiber.dispose()}
  console.log(JSON.stringify({status:'PASS',firstInstall:true,rollback:true,stalePreviewRejected:true,
    installedEngineLoads:true,customArchiveShared:true,inertExpressionsPreserved:true,modelCalls:0,dir}))
} finally {store.close()}
