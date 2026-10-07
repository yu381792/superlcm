import { existsSync,readFileSync,mkdirSync,writeFileSync,renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash,randomUUID } from 'node:crypto'
import { controlsConfig,readControls,controlFields } from '../dsh/controls-config.js'
import { dshEntries,isDshEngine } from './dsh-connection.js'
import {packageInfo} from './dsh-install.js'
import {dshHome} from './dsh-connection.js'
import {RATIO_DEFAULTS} from '../dsh/ratio-policy.js'
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
  return {format:1,revision:randomUUID(),config:controlsConfig({...inherited,auto:false,budgetMode:'ratio',foldBatchTokens:inherited.budgetMode==='ratio'?inherited.foldBatchTokens:(store.tuning().target_tokens||20000),...plan._next.choice?{summarizationProvider:plan.provider,summarizationModel:plan.model,summaryAdapter:modelSpec(plan)}:{}})}
}
const digest=value=>createHash('sha256').update(value).digest('hex')
const safeError=error=>new Error(/^(?:压缩(?:设置|开关|参数|比例|接管)|强制压缩|原文保留|最小压缩|请先|请选择|当前接入|配置已变化|保存失败且存在并发修改|检测到冲突)/.test(error.message)?error.message:'DSH 压缩配置读取或保存失败，请检查宿主日志')
export async function dshCompressionSettings(store,options={}) {
  try{return await readSettings(store,options)}catch(error){throw safeError(error)}
}
async function readSettings(store,options) {
  const {dshSetupPreview}=await import('./dsh-setup.js')
  const plan=await dshSetupPreview(store,options),raw=rawControls(store)
  const saved=readControls(controlsPath(store)),base=inheritedControls(store,plan._next.configuration)
  const fields=Object.fromEntries(Object.entries(controlFields).map(([key,[,,fallback]])=>[key,base[key]??fallback]))
  const installed=plan._next.configuration.profiles.every(p=>dshEntries(p.tree).some(e=>['superlcm-global','superlcm-global-compaction'].includes(e.id)&&e.config?.controlFile===controlsPath(store)))
  const archiveOnly=plan._next.configuration.profiles.every(p=>dshEntries(p.tree).some(e=>e.id==='superlcm-global'&&e.config?.archiveOnly===true))
  let installedVersion=null
  try {installedVersion=JSON.parse(readFileSync(join(dshHome(options.env),'node_modules/superlcm/package.json'),'utf8')).version}catch{}
  const runtimes=compressionSnapshot(store).runtimes,live=runtimes.filter(r=>r.live&&r.kind==='engine')
  const acknowledged=!!saved&&live.length>0&&live.every(r=>r.settings_revision===saved.revision&&r.enabled===base.auto&&r.route_ready&&r.version===installedVersion&&r.version===packageInfo.version&&runtimes.some(a=>a.live&&a.kind==='archive'&&a.pid===r.pid&&a.profile===r.profile&&a.version===r.version))
  const revision=digest(JSON.stringify([raw,plan.revision]))
  return {expected_version:packageInfo.version,installed_version:installedVersion,configured:plan.existing||archiveOnly,archive_only:archiveOnly,controls_installed:installed,revision,settings_revision:saved?.revision||null,
    enabled:archiveOnly?false:base.auto??false,budgetMode:base.budgetMode||'ratio',prepareRatio:base.prepareRatio??0.7,switchRatio:base.switchRatio??0.8,emergencyRatio:base.emergencyRatio??0.9,provider_ref:base.summaryAdapter?.ref||plan.provider_ref,provider:base.summarizationProvider||plan.provider,model:base.summarizationModel||plan.model,...fields,
    status:!installed?'needs-update':acknowledged?'applied':live.length?'pending':'awaiting-runtime',catalog:plan.catalog,
    _plan:plan,_raw:raw}
}
export function publicCompressionSettings({_plan,_raw,...value}){return value}
const saving=new Set()
export async function saveDshCompression(store,input,options={}) {
  if(saving.has(store.dir))throw Error('压缩设置正在保存，请稍后重试')
  saving.add(store.dir)
  try{return await saveSettings(store,input,options)}catch(error){throw safeError(error)}finally{saving.delete(store.dir)}
}
async function saveSettings(store,input,options) {
  const current=await dshCompressionSettings(store,options)
  if(input.revision!==current.revision)throw Error('压缩设置已变化，请重新读取后保存')
  if(!current.controls_installed)throw Error('请先更新 dsh harness 接入，之后可在这里直接设置压缩')
  if(typeof input.enabled!=='boolean')throw Error('压缩开关无效')
  if(input.enabled&&current.installed_version!==packageInfo.version)throw Error('请先更新 dsh harness 接入，再开启压缩接管')
  const provider=current._plan._next.configuration
  const {dshSetupPreview}=await import('./dsh-setup.js')
  const plan=await dshSetupPreview(store,{...options,provider_ref:input.provider_ref,model:input.model})
  if(input.enabled&&(!plan.can_apply||!plan.route_ready))throw Error(plan.blocker||'请先选择压缩模型')
  const snapshot=p=>JSON.stringify([p._next.raw,p._next.configuration.profiles.map(x=>[x.name,x.manifest,x.patch])])
  if(snapshot(plan)!==snapshot(current._plan))throw Error('配置已变化，请重新读取后保存')
  const before=inheritedControls(store,provider)
  const config=controlsConfig({...before,...Object.fromEntries([...Object.keys(controlFields),...Object.keys(RATIO_DEFAULTS)].filter(k=>input[k]!==undefined).map(k=>[k,input[k]])),auto:input.enabled,budgetMode:input.budgetMode??before.budgetMode??'ratio',...plan._next.choice?{summarizationProvider:plan.provider,summarizationModel:plan.model,summaryAdapter:modelSpec(plan)}:{}})
  if(rawControls(store)!==current._raw)throw Error('压缩设置已变化，请重新读取后保存')
  const backup=join(store.dir,'config-backups','dsh-controls-'+randomUUID());mkdirSync(backup,{recursive:true,mode:0o700})
  if(current._raw!==null)writeFileSync(join(backup,'settings.before.json'),current._raw,{mode:0o600})
  let setup
  if(input.enabled&&current.archive_only) {
    const {prepareDshTakeover}=await import('./dsh-takeover-setup.js')
    setup=await prepareDshTakeover(store,plan,options)
  }
  const document={format:1,revision:randomUUID(),config},file=controlsPath(store),temp=file+'.'+randomUUID()
  const written=JSON.stringify(document,null,2)+'\n'
  let transaction=false,wrote=false
  try {
    store.db.exec('BEGIN IMMEDIATE');transaction=true
    if(rawControls(store)!==current._raw)throw Error('压缩设置已变化，请重新读取后保存')
    writeFileSync(temp,written,{flag:'wx',mode:0o600});renameSync(temp,file);wrote=true;store.db.exec('COMMIT')
  }catch(error){
    if(transaction)store.db.exec('ROLLBACK')
    let conflict=false
    if(wrote){
      if(rawControls(store)!==written)conflict=true
      else if(current._raw===null)renameSync(file,join(backup,'settings.failed.json'))
      else {const restore=file+'.'+randomUUID();writeFileSync(restore,current._raw,{flag:'wx',mode:0o600});renameSync(restore,file)}
    }
    conflict=setup?.rollback()||conflict
    if(conflict)throw Error('保存失败且存在并发修改，请检查接入配置')
    throw error
  }
  return {...publicCompressionSettings(await dshCompressionSettings(store,options)),saved:true,backup,restart_required:!!setup,takeover_backup:setup?.backup||null}
}
