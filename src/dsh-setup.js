// Portable offline installation. DSH owns manifest writes; its installed peers
// are linked into a private, versioned copy of this package, not downloaded.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dshEntries, dshHome, dshHost, inspectDshTree } from './dsh-connection.js'
import { runCommand as run, commandOptions, validModel } from './runtime.js'
export const packageRoot = fileURLToPath(new URL('../',import.meta.url))
const pkg = JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
const read = file => existsSync(file) ? readFileSync(file,'utf8') : null
const active = new Set(), engineNames = new Set(['superlcm-mcp/dsh-engine','SuperLcm','@deepseek-ai/dsh-compaction-basic'])
const begin = '# BEGIN SuperLcm managed DSH integration', end = '# END SuperLcm managed DSH integration'
function packageDirectory(require, name) {
  let path=dirname(require.resolve(name))
  while (dirname(path)!==path) {
    if (existsSync(join(path,'package.json')) && JSON.parse(readFileSync(join(path,'package.json'),'utf8')).name === name) return path
    path=dirname(path)
  }
  throw Error('DSH 缺少运行时依赖：'+name)
}
function withoutManaged(text) {
  const start=text.indexOf(begin), finish=text.indexOf(end)
  if (start<0 && finish<0) return text
  if (start<0 || finish<start || text.indexOf(begin,start+begin.length)>=0) throw Error('DSH 的 SuperLcm 配置段不完整，请先核对')
  return text.slice(0,start)+text.slice(finish+end.length).replace(/^\r?\n/,'')
}
export async function dshSetupPreview(store,{env=process.env,runCommand=run,profile='web',provider,model,host:dshRuntime}={}) {
  if (!/^[\w-][\w.-]{0,80}$/.test(profile)||profile==='node_modules') throw Error('Invalid DSH profile')
  const host=dshRuntime || dshHost(env), dir=join(dshHome(env),'profiles',profile)
  const files={mcp:join(dir,'package.json'),hooks:join(dir,'cordis.patch.yml'),lock:join(dir,'pnpm-lock.yaml')}
  const raw=read(files.mcp), patch=read(files.hooks)||'', lock=read(files.lock), homePatch=read(join(dshHome(env),'cordis.patch.yml'))
  if (!raw) throw Error('请先启动一次所选 DSH 界面，再接入 SuperLcm')
  const manifest=JSON.parse(raw)
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error('无法识别 DSH 插件列表')
  const output=await runCommand(host.bin,[...(host.argsPrefix||[]),'--profile',profile,'--dump-config'],{...commandOptions(env),timeout:5000})
  const tree=host.parse(output.stdout), entries=dshEntries(tree), engines=entries.filter(e=>engineNames.has(e.name))
  const old=engines.find(e=>e.name!=='@deepseek-ai/dsh-compaction-basic')||engines[0]
  const route=old?.config || {}, defaults=entries.find(e=>e.id==='agent-default-model')?.config || {}
  provider=provider??route.summarizationProvider??defaults.provider??''
  model=model??route.summarizationModel??defaults.model??''
  const routeValid=typeof provider==='string'&&validModel(provider)&&typeof model==='string'&&validModel(model)
  const sameFallback=provider===route.fallbackSummarizationProvider&&model===route.fallbackSummarizationModel
  const foreign=entries.find(e=>!engineNames.has(e.name)&&(/(?:^|\/)compaction(?:-engine)?$/.test(e.name||'')||e.id==='superlcm-native-compaction'))
  const native=entries.find(e=>e.id==='superlcm-native-compaction'&&e.name==='superlcm-mcp/dsh-engine')
  const otherArchive=entries.find(e=>e.id==='superlcm-archive'&&e.name!=='superlcm-mcp/dsh')
  const peers={}
  for (const peer of Object.keys(pkg.peerDependencies)) peers[peer]=packageDirectory(host.require,peer)
  const operations=await import(pathToFileURL(host.require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
  if (typeof operations.saveManifest!=='function') throw Error('当前 DSH 未提供安全配置写入接口，请更新 DSH')
  const engineConfig={...(old?.config||{}),auto:true,archiveHome:store.dir,summarizationProvider:provider,summarizationModel:model}
  // Preserve the original YAML and !!js expressions. Only our own managed block
  // is replaced; known older compaction entries are disabled, never deleted.
  const previousManaged=patch.includes(begin)?host.parse(patch.slice(patch.indexOf(begin)+begin.length,patch.indexOf(end))):[]
  const disabledIds=new Set(['compaction-basic',...engines.filter(e=>e.id!=='superlcm-native-compaction').map(e=>e.id),
    ...(previousManaged||[]).filter(e=>e.disabled===true).map(e=>e.id)])
  const disabled=[...disabledIds].map(id=>({id,disabled:true}))
  const bridge=entries.filter(e=>e.id==='mcp-superlcm-archive')
  disabled.push(...bridge.map(e=>({id:e.id,disabled:true})))
  const engine={id:'superlcm-native-compaction',name:'superlcm-mcp/dsh-engine',config:engineConfig}
  const basePatch=withoutManaged(patch)
  const externalNative=native && !patch.includes(begin)
  const patches=[...disabled,externalNative?engine:{insert:[engine]}, {id:'superlcm-archive',name:'superlcm-mcp/dsh',config:{archiveHome:store.dir}}]
  const next=basePatch.trimEnd()+'\n\n'+begin+'\n'+host.yaml.dump(patches,{lineWidth:-1,noRefs:true,schema:host.schema})+end+'\n'
  const revision=hash(JSON.stringify({raw,patch,lock,homePatch,version:pkg.version,profile,provider,model,index:store.dir}))
  return {harness:'dsh',profile,provider:typeof provider==='string'?provider:'',model:typeof model==='string'?model:'',revision,can_apply:routeValid&&!foreign&&!otherArchive&&!sameFallback,
    blocker:foreign?'检测到其他压缩引擎，请先在 DSH 中选择唯一引擎':otherArchive?'同名归档条目属于其他插件，不能覆盖':sameFallback?'压缩模型不能与备用模型相同':!routeValid?'请选择用于压缩的 DSH 模型及提供方':null,
    existing:inspectDshTree(tree).configured,files,index_home:store.dir,hook_events_added:[],mcp_action:'native-plugin',requires_review:false,
    version:pkg.version,notes:['安装当前 SuperLcm 的本地副本，不联网下载。','仅修改所选界面，原配置和插件入口先备份。','启用 DSH 原生自动压缩，沿用所选模型，会使用该模型的调用额度。','安装后重新加载 DSH；本工具不会自动重启它。'],
    _next:{manifest,patch:next,raw,originalPatch:read(files.hooks),lock,peers,host,operations,dir}}
}
export async function applyDshSetup(store,revision,options={}) {
  const key=dshHome(options.env)+'/'+(options.profile||'web')
  if(active.has(key)) throw Error('该 DSH 界面的接入正在运行')
  active.add(key)
  try {
    const plan=await dshSetupPreview(store,options)
    if(plan.revision!==revision) throw Error('配置已变化，请重新预览')
    if(!plan.can_apply) throw Error(plan.blocker)
    const saved=plan._next, backup=join(store.dir,'config-backups','dsh-'+plan.profile+'-'+randomUUID())
    mkdirSync(backup,{recursive:true,mode:0o700})
    for(const [name,file] of Object.entries(plan.files)) if(existsSync(file)) writeFileSync(join(backup,name+'.before'),readFileSync(file),{flag:'wx',mode:0o600})
    const stage=join(store.dir,'dsh-packages',pkg.version+'-'+randomUUID())
    mkdirSync(stage,{recursive:true,mode:0o700})
    for(const file of ['package.json',...pkg.files]) if(existsSync(join(packageRoot,file))) cpSync(join(packageRoot,file),join(stage,file),{recursive:true})
    for(const [peer,path] of Object.entries(saved.peers)) {
      const target=join(stage,'node_modules',peer);mkdirSync(dirname(target),{recursive:true});symlinkSync(path,target,process.platform==='win32'?'junction':'dir')
    }
    const entry=join(saved.dir,'node_modules','superlcm-mcp'), previous=join(backup,'previous-plugin-entry')
    let hadEntry=false
    try { lstatSync(entry);hadEntry=true } catch {}
    if(hadEntry) {
      const current=JSON.parse(readFileSync(join(entry,'package.json'),'utf8'))
      if(current.name!=='superlcm-mcp') throw Error('插件路径属于其他包，不能覆盖')
    }
    if(read(plan.files.mcp)!==saved.raw||read(plan.files.hooks)!==saved.originalPatch||read(plan.files.lock)!==saved.lock) throw Error('配置已变化，请重新预览')
    const manifest=structuredClone(saved.manifest)
    manifest.dependencies??={};manifest.dependencies['superlcm-mcp']='link:'+stage
    const bundles=manifest.dsh.profile.bundles.filter(name=>name!=='superlcm-mcp'&&name!=='SuperLcm')
    const base=bundles.indexOf('@deepseek-ai/dsh-base');bundles.splice(base>=0?base+1:0,0,'superlcm-mcp')
    manifest.dsh.profile.bundles=bundles
    const nextLock=saved.lock?saved.host.yaml.load(saved.lock):null
    if(nextLock) {
      if(!nextLock.importers?.['.']) throw Error('无法识别 DSH 锁文件')
      nextLock.importers['.'].dependencies??={}
      nextLock.importers['.'].dependencies['superlcm-mcp']={specifier:'link:'+stage,version:'link:'+stage}
    }
    mkdirSync(dirname(entry),{recursive:true})
    let moved=false,linked=false
    try {
      if(hadEntry) {renameSync(entry,previous);moved=true}
      symlinkSync(stage,entry,process.platform==='win32'?'junction':'dir');linked=true
      await saved.operations.saveManifest(saved.dir,manifest)
      const temp=plan.files.hooks+'.superlcm-'+randomUUID();writeFileSync(temp,saved.patch,{flag:'wx',mode:0o600});renameSync(temp,plan.files.hooks)
      if(nextLock) writeFileSync(plan.files.lock,saved.host.yaml.dump(nextLock,{lineWidth:-1,noRefs:true}),{mode:0o600})
      const dump=await (options.runCommand||run)(saved.host.bin,[...(saved.host.argsPrefix||[]),'--profile',plan.profile,'--dump-config'],{...commandOptions(options.env||process.env),timeout:5000})
      const verified=inspectDshTree(saved.host.parse(dump.stdout))
      if(!verified.configured||!verified.enabled||!verified.route_ready) throw Error('安装后的 DSH 压缩配置未通过验证')
      const receipt={harness:'dsh',profile:plan.profile,version:pkg.version,saved:true,configuration_verified:true,
        restart_required:true,state:'awaiting_client_reload',backup,package:stage,serviceRestarted:false}
      writeFileSync(join(backup,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});return receipt
    } catch(error) {
      // Keep the failed package and every backup for recovery. No user file is deleted.
      if(linked) renameSync(entry,join(backup,'failed-plugin-entry'))
      if(moved) renameSync(previous,entry)
      const expectedManifest=JSON.stringify(manifest,null,2)+'\n'
      const expectedLock=nextLock?saved.host.yaml.dump(nextLock,{lineWidth:-1,noRefs:true}):null
      const changedByOthers=read(plan.files.mcp)!==saved.raw&&read(plan.files.mcp)!==expectedManifest ||
        read(plan.files.hooks)!==saved.originalPatch&&read(plan.files.hooks)!==saved.patch ||
        read(plan.files.lock)!==saved.lock&&read(plan.files.lock)!==expectedLock
      if(changedByOthers) throw Error('DSH 接入失败且配置被其他程序修改，未覆盖并发更改；备份位于 '+backup)
      writeFileSync(plan.files.mcp,saved.raw,{mode:0o600})
      if(saved.originalPatch!==null) writeFileSync(plan.files.hooks,saved.originalPatch,{mode:0o600})
      else if(existsSync(plan.files.hooks)) renameSync(plan.files.hooks,join(backup,'failed-patch'))
      if(saved.lock!==null) writeFileSync(plan.files.lock,saved.lock,{mode:0o600})
      throw Error('DSH 接入失败，已恢复原配置；备份位于 '+backup)
    }
  } finally { active.delete(key) }
}
