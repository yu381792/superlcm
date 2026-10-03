import { existsSync,readFileSync,mkdirSync,writeFileSync,renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash,randomUUID } from 'node:crypto'
import { controlsConfig,readControls,controlFields } from '../dsh/controls-config.js'
import { dshEntries,isDshEngine } from './dsh-connection.js'
import { compressionSnapshot } from './compression-status.js'
export const controlsPath=store=>join(store.dir,'dsh-compression.json')
export const rawControls=store=>existsSync(controlsPath(store))?readFileSync(controlsPath(store),'utf8'):null
export function modelSpec(plan) {
  const choice=plan._next.choice
  return {ref:plan.provider_ref,plugin:choice._plugin,config:choice._plugin.endsWith('dsh-llm-pi-ai')?{providers:{[plan.provider]:choice._config}}:choice._config}
}
export function inheritedControls(store,configuration) {
  const saved=readControls(controlsPath(store));if(saved)return saved.config
  const profiles=configuration.profiles
  const live=compressionSnapshot(store).runtimes.find(r=>r.live&&r.kind==='engine')?.profile
  const profile=profiles.find(p=>p.name===live)||profiles.find(p=>p.name==='web')||profiles[0]
  const engine=profile&&dshEntries(profile.tree).find(e=>isDshEngine(e)&&e.name!=='@deepseek-ai/dsh-compaction-basic')
  const config=engine?.config||{}
  return {...config,...config.runtimeTuning?.[profile?.name]}
}
export function controlDocument(store,plan) {
  const inherited=inheritedControls(store,plan._next.configuration)
  return {format:1,revision:randomUUID(),config:controlsConfig({...inherited,auto:inherited.auto??true,summarizationProvider:plan.provider,summarizationModel:plan.model,summaryAdapter:modelSpec(plan)})}
}
const digest=value=>createHash('sha256').update(value).digest('hex')
export async function dshCompressionSettings(store,options={}) {
  const {dshSetupPreview}=await import('./dsh-setup.js')
  const plan=await dshSetupPreview(store,options),raw=rawControls(store)
  const saved=readControls(controlsPath(store)),base=inheritedControls(store,plan._next.configuration)
  const fields=Object.fromEntries(Object.entries(controlFields).map(([key,[,,fallback]])=>[key,base[key]??fallback]))
  const installed=plan._next.configuration.profiles.every(p=>dshEntries(p.tree).some(e=>['superlcm-global','superlcm-global-compaction'].includes(e.id)&&e.config?.controlFile===controlsPath(store)))
  const live=compressionSnapshot(store).runtimes.filter(r=>r.live&&r.kind==='engine')
  const acknowledged=!!saved&&live.length>0&&live.every(r=>r.settings_revision===saved.revision)
  const revision=digest(JSON.stringify([raw,plan.revision]))
  return {configured:plan.existing,controls_installed:installed,revision,settings_revision:saved?.revision||null,
    enabled:base.auto??true,provider_ref:base.summaryAdapter?.ref||plan.provider_ref,provider:base.summarizationProvider||plan.provider,model:base.summarizationModel||plan.model,...fields,
    status:!installed?'needs-update':acknowledged?'applied':live.length?'pending':'awaiting-runtime',catalog:plan.catalog,
    _plan:plan,_raw:raw}
}
export function publicCompressionSettings({_plan,_raw,...value}){return value}
export async function saveDshCompression(store,input,options={}) {
  const current=await dshCompressionSettings(store,options)
  if(input.revision!==current.revision)throw Error('压缩设置已变化，请重新读取后保存')
  if(!current.controls_installed)throw Error('请先更新 dsh harness 接入，之后可在这里直接设置压缩')
  if(typeof input.enabled!=='boolean')throw Error('压缩开关无效')
  const provider=current._plan._next.configuration
  const {dshSetupPreview}=await import('./dsh-setup.js')
  const plan=await dshSetupPreview(store,{...options,provider_ref:input.provider_ref,model:input.model})
  if(!plan.can_apply)throw Error(plan.blocker)
  const before=inheritedControls(store,provider)
  const config=controlsConfig({...before,...Object.fromEntries(Object.keys(controlFields).filter(k=>input[k]!==undefined).map(k=>[k,input[k]])),auto:input.enabled,summarizationProvider:plan.provider,summarizationModel:plan.model,summaryAdapter:modelSpec(plan)})
  if(rawControls(store)!==current._raw)throw Error('压缩设置已变化，请重新读取后保存')
  const backup=join(store.dir,'config-backups','dsh-controls-'+randomUUID());mkdirSync(backup,{recursive:true,mode:0o700})
  if(current._raw!==null)writeFileSync(join(backup,'settings.before.json'),current._raw,{mode:0o600})
  const document={format:1,revision:randomUUID(),config},file=controlsPath(store),temp=file+'.'+randomUUID()
  store.db.exec('BEGIN IMMEDIATE')
  try {
    if(rawControls(store)!==current._raw)throw Error('压缩设置已变化，请重新读取后保存')
    writeFileSync(temp,JSON.stringify(document,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,file);store.db.exec('COMMIT')
  }catch(error){store.db.exec('ROLLBACK');throw error}
  return {...publicCompressionSettings(await dshCompressionSettings(store,options)),saved:true,backup}
}
