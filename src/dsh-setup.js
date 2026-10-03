// One home-level DSH integration, shared by existing and future launch modes.
import { existsSync,mkdirSync,readFileSync,renameSync,writeFileSync } from 'node:fs'
import { createHash,randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshHome,dshEntries,inspectDshTree,isDshEngine,isDshArchive } from './dsh-connection.js'
import { dshConfiguration,readDshCatalog,publicCatalog } from './dsh-catalog.js'
import { packageInfo,installDshPackage,removeManagedBlock } from './dsh-install.js'
import { controlsPath,rawControls,controlDocument } from './dsh-controls.js'
import { readControls } from '../dsh/controls-config.js'
import { runCommand as run,commandOptions } from './runtime.js'
const read=file=>existsSync(file)?readFileSync(file,'utf8'):null
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const globalBegin='# BEGIN SuperLcm global DSH integration',globalEnd='# END SuperLcm global DSH integration'
const legacyBegin='# BEGIN SuperLcm managed DSH integration',legacyEnd='# END SuperLcm managed DSH integration'
const tuningKeys=['tailCount','minRetainTokens','pressureFoldTokens','foldBatchTokens','softActiveTokens','hardActiveTokens','summaryPrefixTargetTokens','condensedMinFanout','summaryTimeoutMs','summaryRetryCooldownMs','headroomTokens','maxTokens','compactionRetries','maxOverflowRetries']
const active=new Set()
export async function dshSetupPreview(store,{env=process.env,runCommand=run,provider_ref,provider,model}={}) {
  const configuration=await dshConfiguration({env,runCommand}),{host,profiles}=configuration
  if(!profiles.length)throw Error('请先安装并启动一次 dsh harness，再全局接入 SuperLcm')
  const catalog=await readDshCatalog(configuration),file=join(dshHome(env),'cordis.patch.yml'),raw=read(file)
  const engines=profiles.flatMap(p=>dshEntries(p.tree).filter(isDshEngine))
  const installed=engines.find(e=>e.id==='superlcm-global-compaction')?.config
  const controlled=installed?.controlFile?readControls(installed.controlFile):null
  const current=installed?{...installed,...controlled?.config}:undefined
  provider_ref=provider_ref??current?.summaryAdapter?.ref
  if(!provider_ref&&provider){const matches=catalog.providers.filter(p=>p.id===provider);if(matches.length===1)provider_ref=matches[0].ref}
  const choice=catalog.providers.find(p=>p.ref===provider_ref)
  model=model??(current&&current.summaryAdapter?.ref===provider_ref?current.summarizationModel:undefined)
  const routeReady=!!choice?.models.some(m=>m.id===model)
  const foreign=profiles.flatMap(p=>dshEntries(p.tree)).find(e=>
    !isDshEngine(e)&&(/(?:^|\/)compaction(?:-engine)?$/.test(e.name||'')||['superlcm-global-compaction','SuperLcm-compaction','superlcm-native-compaction','compaction-basic'].includes(e.id))||
    ['superlcm-archive','superlcm-global-archive'].includes(e.id)&&!isDshArchive(e)||
    e.id==='mcp-superlcm-archive'&&!['superlcm','superlcm-archive'].includes(e.config?.serverName))
  const disabledIds=new Set(['compaction-basic','SuperLcm-compaction','superlcm-native-compaction','superlcm-archive','mcp-superlcm-archive'])
  for(const profile of profiles)for(const entry of dshEntries(profile.tree))if((isDshEngine(entry)||isDshArchive(entry))&&!entry.id.startsWith('superlcm-global-'))disabledIds.add(entry.id)
  const runtimeTuning={}
  for(const profile of profiles){const old=dshEntries(profile.tree).find(e=>isDshEngine(e)&&e.name!=='@deepseek-ai/dsh-compaction-basic');if(old)runtimeTuning[profile.name]=Object.fromEntries(tuningKeys.filter(k=>typeof old.config?.[k]==='number').map(k=>[k,old.config[k]]))}
  if(current?.runtimeTuning)Object.assign(runtimeTuning,current.runtimeTuning)
  const controlsRaw=rawControls(store)
  const revision=hash({raw,controlsRaw,profiles:profiles.map(p=>[p.name,p.manifest,p.patch]),version:packageInfo.version,index:store.dir,provider_ref:provider_ref||null,model:model||null})
  const operations=await import(pathToFileURL(host.require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
  return {harness:'dsh',scope:'global',revision,provider_ref:choice?.ref||null,provider:choice?.id||null,model:model||null,
    can_apply:routeReady&&!foreign,blocker:foreign?'检测到其他压缩引擎，需先在 dsh harness 中确认唯一引擎':!routeReady?'请从 dsh harness 已配置的模型中选择压缩供应商和模型':null,
    existing:!!current,files:{settings:file},index_home:store.dir,hook_events_added:[],mcp_action:'global-compaction-plugin',requires_review:false,version:packageInfo.version,
    catalog:publicCatalog(catalog),notes:['全局接入一次，所有启动方式共用。','模型来自 dsh harness 当前配置，无需先安装旧压缩插件。','生成压缩摘要会使用所选模型的调用额度。'],
    _next:{configuration,choice,operations,file,raw,controlsRaw,disabledIds:[...disabledIds],runtimeTuning}}
}
export async function applyDshSetup(store,revision,options={}) {
  const home=dshHome(options.env)
  if(active.has(home))throw Error('dsh harness 全局接入正在运行')
  active.add(home)
  try {
    const plan=await dshSetupPreview(store,options)
    if(plan.revision!==revision)throw Error('配置已变化，请重新预览')
    if(!plan.can_apply)throw Error(plan.blocker)
    const saved=plan._next,{host,profiles}=saved.configuration
    const backup=join(store.dir,'config-backups','dsh-global-'+randomUUID());mkdirSync(backup,{recursive:true,mode:0o700})
    if(saved.raw!==null)writeFileSync(join(backup,'global.before'),saved.raw,{mode:0o600})
    for(const profile of profiles){writeFileSync(join(backup,profile.name+'-manifest.before'),profile.manifest,{mode:0o600});if(profile.patch!==null)writeFileSync(join(backup,profile.name+'-patch.before'),profile.patch,{mode:0o600})}
    const stage=installDshPackage(store,host),mutations=[]
    const document=controlDocument(store,plan),controlFile=controlsPath(store)
    if(saved.controlsRaw!==null)writeFileSync(join(backup,'controls.before'),saved.controlsRaw,{mode:0o600})
    const engine={id:'superlcm-global-compaction',name:join(stage,'dsh/engine.js'),config:{...document.config,archiveHome:store.dir,controlFile}}
    const archive={id:'superlcm-global-archive',name:join(stage,'dsh/archive.js'),config:{archiveHome:store.dir}}
    const base=removeManagedBlock(saved.raw||'',globalBegin,globalEnd).trimEnd()
    const patches=[...saved.disabledIds.map(id=>({id,disabled:true})),{insert:[engine,archive]}]
    const next=base+'\n\n'+globalBegin+'\n'+host.yaml.dump(patches,{schema:host.schema,noRefs:true,lineWidth:-1})+globalEnd+'\n'
    const record=(file,before,after)=>mutations.push({file,before,after})
    if(read(saved.file)!==saved.raw)throw Error('全局配置已变化，请重新预览')
    if(rawControls(store)!==saved.controlsRaw)throw Error('压缩设置已变化，请重新预览')
    for(const profile of profiles)if(read(join(profile.dir,'package.json'))!==profile.manifest||read(join(profile.dir,'cordis.patch.yml'))!==profile.patch)throw Error('配置已变化，请重新预览')
    try {
      // Retire only the old SuperLcm activation. Provider/model settings and
      // unrelated bundles remain untouched; old dependencies remain installed.
      for(const profile of profiles){
        const manifest=JSON.parse(profile.manifest),beforeBundles=manifest.dsh.profile.bundles
        manifest.dsh.profile.bundles=beforeBundles.filter(name=>name!=='superlcm-mcp'&&name!=='SuperLcm')
        if(manifest.dsh.profile.bundles.length!==beforeBundles.length){const after=JSON.stringify(manifest,null,2)+'\n';record(join(profile.dir,'package.json'),profile.manifest,after);await saved.operations.saveManifest(profile.dir,manifest)}
        if(profile.patch?.includes(legacyBegin)){const after=removeManagedBlock(profile.patch,legacyBegin,legacyEnd);record(join(profile.dir,'cordis.patch.yml'),profile.patch,after);writeFileSync(join(profile.dir,'cordis.patch.yml'),after,{mode:0o600})}
      }
      const controlAfter=JSON.stringify(document,null,2)+'\n';record(controlFile,saved.controlsRaw,controlAfter);const controlTemp=controlFile+'.'+randomUUID();writeFileSync(controlTemp,controlAfter,{flag:'wx',mode:0o600});renameSync(controlTemp,controlFile)
      record(saved.file,saved.raw,next);const temp=saved.file+'.superlcm-'+randomUUID();writeFileSync(temp,next,{flag:'wx',mode:0o600});renameSync(temp,saved.file)
      for(const profile of profiles){const result=await (options.runCommand||run)(host.bin,[...host.argsPrefix,'--profile',profile.name,'--dump-config'],{...commandOptions(options.env||process.env),timeout:5000});const status=inspectDshTree(host.parse(result.stdout));if(!status.configured||status.enabled!==document.config.auto||!status.route_ready)throw Error('Global integration did not validate')}
      const result={harness:'dsh',scope:'global',version:packageInfo.version,saved:true,configuration_verified:true,restart_required:true,state:'awaiting_client_reload',backup,package:stage,serviceRestarted:false}
      writeFileSync(join(backup,'receipt.json'),JSON.stringify(result,null,2),{mode:0o600});return result
    } catch {
      let conflict=false
      for(const change of [...mutations].reverse()){
        const current=read(change.file);if(current!==change.after&&current!==change.before){conflict=true;continue}
        if(change.before===null){if(existsSync(change.file))renameSync(change.file,join(backup,'failed-'+(change.file===controlFile?'controls':'global-patch')))}
        else writeFileSync(change.file,change.before,{mode:0o600})
      }
      throw Error((conflict?'接入失败且存在并发修改，未覆盖这些更改':'全局接入失败，已恢复原配置')+'；备份位于 '+backup)
    }
  } finally {active.delete(home)}
}
