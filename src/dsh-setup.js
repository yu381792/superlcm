// One home-level DSH integration, shared by existing and future launch modes.
import {existsSync,readFileSync} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshHome,dshEntries,isDshEngine,isDshArchive } from './dsh-connection.js'
import { dshConfiguration,readDshCatalog,publicCatalog } from './dsh-catalog.js'
import { packageInfo } from './dsh-install.js'
import { rawControls } from './dsh-controls.js'
import { readControls } from '../dsh/controls-config.js'
import { runCommand as run,commandOptions } from './runtime.js'
const read=file=>existsSync(file)?readFileSync(file,'utf8'):null
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const globalBegin='# BEGIN SuperLcm global DSH integration',globalEnd='# END SuperLcm global DSH integration'
const tuningKeys=['tailCount','minRetainTokens','pressureFoldTokens','foldBatchTokens','softActiveTokens','hardActiveTokens','summaryPrefixTargetTokens','condensedMinFanout','summaryTimeoutMs','summaryRetryCooldownMs','headroomTokens','maxTokens','compactionRetries','maxOverflowRetries']
const active=new Set()
export async function dshSetupPreview(store,{env=process.env,runCommand=run,provider_ref,provider,model}={}) {
  const configuration=await dshConfiguration({env,runCommand}),{host,profiles}=configuration
  if(!profiles.length)throw Error('请先安装并启动一次 dsh harness，再全局接入 SuperLcm')
  const catalog=await readDshCatalog(configuration),file=join(dshHome(env),'cordis.patch.yml'),raw=read(file)
  const engines=profiles.flatMap(p=>dshEntries(p.tree).filter(isDshEngine))
  const installed=engines.find(e=>['superlcm-global','superlcm-global-compaction'].includes(e.id))?.config
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
    can_apply:!foreign,route_ready:routeReady,mode:'summary-only',blocker:foreign?'检测到冲突的 SuperLcm 插件标识，请先在 dsh harness 中核对':null,
    existing:!!current,files:{settings:file},index_home:store.dir,hook_events_added:[],mcp_action:'global-summary-plugin',requires_review:false,version:packageInfo.version,
    catalog:publicCatalog(catalog),notes:['全局接入一次，归档原文、后台摘要和查询共用。','压缩由 dsh harness 自身负责，不替换上下文。','后台摘要在接入卡片选择，沿用已保存的自定义 API。'],
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
    return await (await import('./dsh-summary-setup.js')).applyDshArchivePlan(store,plan,options)
  } finally {active.delete(home)}
}
