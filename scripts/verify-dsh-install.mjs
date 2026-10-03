// Fresh DSH, global activation, existing model catalogs, no model/network calls.
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {ClaudeStore} from '../src/store.js'
import {dshSetupPreview,applyDshSetup} from '../src/dsh-setup.js'
import {dshHost,dshEntries,isDshEngine} from '../src/dsh-connection.js'
import {runCommand} from '../src/runtime.js'
import {packageRoot} from '../src/dsh-install.js'
import {dshCompressionSettings,saveDshCompression,publicCompressionSettings} from '../src/dsh-controls.js'
import {readControls} from '../dsh/controls-config.js'
const dir=mkdtempSync(join(tmpdir(),'superlcm-global-verify-')),env={...process.env,DSH_HOME:join(dir,'dsh')}
function makeProfile(name,models=[]){const folder=join(env.DSH_HOME,'profiles',name);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'package.json'),JSON.stringify({name:'dsh-profile-'+name,private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base']}},dependencies:{}}));const modelConfig=models.length?'- id: llm-pi-ai\n  config:\n    providers:\n      sample-ai:\n        displayName: Sample AI\n        api: openai-responses\n        baseURL: http://127.0.0.1:9/v1\n        headers:\n          Authorization: Bearer fixture-secret\n        models:\n'+models.map(id=>'          - id: '+id+'\n            name: '+id+'\n            contextWindow: 128000\n').join(''):'';writeFileSync(join(folder,'cordis.patch.yml'),'# Keep original\n- id: agent-default-model\n  config:\n    provider: main-model-provider\n    model: unchanged-main-model\n'+modelConfig);return folder}
const web=makeProfile('web',['cheap-summary','long-context']),acp=makeProfile('acp',['alternate-model'])
const originalWeb=readFileSync(join(web,'cordis.patch.yml'),'utf8'),originalAcp=readFileSync(join(acp,'cordis.patch.yml'),'utf8')
const store=new ClaudeStore(join(dir,'custom-archive'))
try{
 let p=await dshSetupPreview(store,{env});assert.equal(p.scope,'global');assert.equal(p.can_apply,false)
 const {_next,...publicValue}=p;assert.ok(!JSON.stringify(publicValue).includes("fixture-secret"))
 const provider=p.catalog.providers.find(p=>p.id==='sample-ai');assert.deepEqual(new Set(provider.models.map(m=>m.id)),new Set(['cheap-summary','long-context','alternate-model']))
 const options={env,provider_ref:provider.ref,model:'cheap-summary'};p=await dshSetupPreview(store,options)
 const installed=await applyDshSetup(store,p.revision,options)
 assert.equal(readFileSync(join(web,'cordis.patch.yml'),'utf8'),originalWeb);assert.equal(readFileSync(join(acp,'cordis.patch.yml'),'utf8'),originalAcp)
 const globalFile=join(env.DSH_HOME,'cordis.patch.yml'),before=readFileSync(globalFile,'utf8')
 p=await dshSetupPreview(store,options);let calls=0
 await assert.rejects(applyDshSetup(store,p.revision,{...options,runCommand:async(...args)=>++calls<=2?runCommand(...args):{stdout:'[]'}}),/已恢复原配置/)
 assert.equal(readFileSync(globalFile,'utf8'),before)
 p=await dshSetupPreview(store,options);await applyDshSetup(store,p.revision,options)
 assert.equal(readFileSync(globalFile,'utf8').split('# BEGIN SuperLcm global DSH integration').length,2)
 const future=makeProfile('future-launch');const host=dshHost(env),load=async name=>import(pathToFileURL(host.require.resolve(name)).href)
 const dump=host.parse((await runCommand(host.bin,[...host.argsPrefix,'--profile','future-launch','--dump-config'],{env})).stdout)
 const entries=dshEntries(dump),config=entries.find(e=>e.id==='superlcm-global-compaction').config
 assert.equal(entries.filter(isDshEngine).length,1);assert.ok(!existsSync(join(future,'node_modules/superlcm-mcp')))
 const {Context}=await load('@deepseek-ai/cordis'),{SessionStore}=await load('@deepseek-ai/dsh-session')
 const {default:Projections}=await load('@deepseek-ai/dsh-session-projection'),{default:Meter}=await load('@deepseek-ai/dsh-token-meter')
 const {default:Engine}=await import(pathToFileURL(join(installed.package,'dsh/engine.js')).href)
 const ctx=new Context()
 try{new SessionStore(ctx);new Projections(ctx);const main={async *stream(){throw Error('No model call allowed')},imageRequestPricing(){},fileRequestText(){}};ctx.reflect.provide('llm',main);new Meter(ctx);const fiber=ctx.plugin(Engine,{...config,auto:false});await fiber.await();await ctx.compaction.summaryModelReady;assert.equal(ctx.compaction.superLcmStore.path,join(store.dir,'lcm.sqlite'));assert.equal(ctx.llm,main);assert.ok((await ctx.compaction.summaryContext.llm.listModels('sample-ai')).some(m=>m.id==='cheap-summary'));}finally{await ctx.fiber.dispose()}
 const daily=await dshCompressionSettings(store,{env});assert.equal(daily.controls_installed,true);assert.ok(!JSON.stringify(publicCompressionSettings(daily)).includes('fixture-secret'))
 const change={revision:daily.revision,enabled:false,provider_ref:provider.ref,model:'alternate-model',softActiveTokens:200000,hardActiveTokens:280000,minRetainTokens:60000,tailCount:8}
 const updated=await saveDshCompression(store,change,{env});assert.equal(updated.enabled,false);assert.equal(updated.model,'alternate-model');assert.equal(updated.minRetainTokens,60000)
 await assert.rejects(saveDshCompression(store,change,{env}),/设置已变化/)
 await assert.rejects(saveDshCompression(store,{...change,revision:updated.revision,minRetainTokens:300000},{env}),/原文保留量/)
 const restored=await saveDshCompression(store,{...change,revision:updated.revision,enabled:true,model:'cheap-summary'},{env});assert.equal(restored.enabled,true)
 const stale=await dshSetupPreview(store,options);writeFileSync(globalFile,readFileSync(globalFile,'utf8')+'\n# Concurrent edit\n');await assert.rejects(applyDshSetup(store,stale.revision,options),/配置已变化/)
 const legacyEnv={...env,DSH_HOME:join(dir,'legacy-dsh')},legacyDir=join(legacyEnv.DSH_HOME,'profiles/web')
 mkdirSync(join(legacyDir,'node_modules'),{recursive:true});symlinkSync(packageRoot,join(legacyDir,'node_modules/superlcm-mcp'),process.platform==='win32'?'junction':'dir')
 writeFileSync(join(legacyDir,'package.json'),JSON.stringify({name:'legacy-web',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','superlcm-mcp']}},dependencies:{'superlcm-mcp':'link:'+packageRoot}}))
 const legacyPatch=originalWeb+'\n- id: compaction-basic\n  disabled: true\n- insert:\n    - id: SuperLcm-compaction\n      name: superlcm-mcp/dsh-engine\n      config:\n        auto: true\n        tailCount: 123\n        summarizationProvider: sample-ai\n        summarizationModel: cheap-summary\n'
 writeFileSync(join(legacyDir,'cordis.patch.yml'),legacyPatch)
 const legacyStore=new ClaudeStore(join(dir,'legacy-archive'))
 try{let preview=await dshSetupPreview(legacyStore,{env:legacyEnv});const selected=preview.catalog.providers.find(p=>p.id==='sample-ai');const opts={env:legacyEnv,provider_ref:selected.ref,model:'cheap-summary'};preview=await dshSetupPreview(legacyStore,opts);await applyDshSetup(legacyStore,preview.revision,opts);assert.equal(readFileSync(join(legacyDir,'cordis.patch.yml'),'utf8'),legacyPatch);assert.ok(!JSON.parse(readFileSync(join(legacyDir,'package.json'),'utf8')).dsh.profile.bundles.includes('superlcm-mcp'));const tree=host.parse((await runCommand(host.bin,[...host.argsPrefix,'--profile','web','--dump-config'],{env:legacyEnv})).stdout);const effective=dshEntries(tree).filter(isDshEngine);assert.equal(effective.length,1);assert.equal(readControls(effective[0].config.controlFile).config.tailCount,123)}finally{legacyStore.close()}
 console.log(JSON.stringify({status:'PASS',freshInstallWithoutLegacy:true,legacyMigratedWithoutDuplicates:true,allConfiguredModels:true,globalForExistingAndFuture:true,mainModelsUnchanged:true,rollback:true,stalePreviewRejected:true,installedNativeEngineLoads:true,customArchiveShared:true,dailyControls:true,modelCalls:0,dir}))
}finally{store.close()}
