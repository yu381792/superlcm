// Explicit opt-in only. Summary-only connection continues to mount DSH's own
// compactor directly. Preserve its original configuration for later switching.
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {dshEntries,inspectDshTree} from './dsh-connection.js'
import {stripDshIntegration} from './dsh-summary-setup.js'
import {dshPresets,inheritGlobalCompaction} from './dsh-preset-compaction.js'
import {runCommand,commandOptions} from './runtime.js'
const read=file=>existsSync(file)?readFileSync(file,'utf8'):null
const models=tree=>dshEntries(tree).filter(e=>/dsh-llm-|dsh-agent-default-model$/.test(e.name||'')).map(e=>[e.id,e.name,e.config])
const append=(raw,name,rows,host)=>(raw||'').replace(/^\s*\[\]\s*$/gm,'').trimEnd()+'\n\n# BEGIN SuperLcm '+name+'\n'+host.yaml.dump(rows,{schema:host.schema,noRefs:true,lineWidth:-1})+'# END SuperLcm '+name+'\n'
export async function prepareDshTakeover(store,plan,{env=process.env,runCommand:run=runCommand}={}) {
  const {configuration,file,raw}=plan._next,{host,profiles}=configuration
  const nativeConfigs={}
  for(const p of profiles) {
    const entries=dshEntries(p.tree),native=entries.filter(e=>e.name==='@deepseek-ai/dsh-compaction-basic')
    if(native.length!==1||!native[0].id||native[0].config?.auto===false||entries.filter(e=>e.id==='superlcm-global'&&e.config?.archiveOnly===true).length!==1)throw Error('请先完成全局后台摘要接入，再开启压缩接管')
    nativeConfigs[p.name]=native[0].config||{}
  }
  const backup=join(store.dir,'config-backups','dsh-takeover-'+randomUUID());mkdirSync(backup,{recursive:true,mode:0o700})
  const changes=[]
  const write=(path,before,after)=>{
    if(read(path)!==before)throw Error('配置已变化，请重新读取后保存')
    writeFileSync(join(backup,changes.length+'.before'),before??'',{mode:0o600})
    const temp=path+'.superlcm-'+randomUUID();writeFileSync(temp,after,{flag:'wx',mode:0o600});renameSync(temp,path);changes.push({path,before,after})
  }
  const rollback=()=>{
    let conflict=false
    for(const x of [...changes].reverse()) {
      if(read(x.path)!==x.after){conflict=true;continue}
      if(x.before===null)renameSync(x.path,join(backup,'failed-'+randomUUID()))
      else writeFileSync(x.path,x.before,{mode:0o600})
    }
    return conflict
  }
  try {
    for(const p of profiles)if(read(join(p.dir,'package.json'))!==p.manifest||read(join(p.dir,'cordis.patch.yml'))!==p.patch)throw Error('配置已变化，请重新读取后保存')
    if(read(file)!==raw)throw Error('配置已变化，请重新读取后保存')
    // Disable native rows before enabling the owner, so two compactors never
    // run concurrently during the host's config reload.
    for(const p of profiles) {
      const native=dshEntries(p.tree).find(e=>e.name==='@deepseek-ai/dsh-compaction-basic')
      let patch=append(p.patch,'optional DSH takeover',[{id:native.id,disabled:true}],host)
      const presets=dshPresets(p.tree)
      if(presets.length)patch=append(patch,'preset compaction inheritance',presets.map(e=>({id:e.id,config:{...e.config,plugins:inheritGlobalCompaction(e.config.plugins)}})),host)
      write(join(p.dir,'cordis.patch.yml'),p.patch,patch)
    }
    const global=append(stripDshIntegration(raw),'global DSH integration',[{insert:[{id:'superlcm-global',name:'superlcm',config:{archiveOnly:false,archiveHome:store.dir,controlFile:join(store.dir,'dsh-compression.json'),nativeConfigs}}]}],host)
    write(file,raw,global)
    for(const p of profiles) {
      const result=await run(host.bin,[...host.argsPrefix,'--profile',p.name,'--dump-config'],{...commandOptions(env),timeout:5000}),tree=host.parse(result.stdout)
      if(read(join(p.dir,'package.json'))!==p.manifest)throw Error('配置已变化，请重新读取后保存')
      if(!inspectDshTree(tree).configured||JSON.stringify(models(tree))!==JSON.stringify(models(p.tree)))throw Error('压缩接管配置验证失败')
    }
    return {backup,rollback,restart_required:true}
  } catch(error) {
    const conflict=rollback()
    const safe=['配置已变化，请重新读取后保存','压缩接管配置验证失败'].includes(error.message)?error.message:'压缩接管配置写入或验证失败'
    throw Error(safe+'；'+(conflict?'存在并发修改，未覆盖这些更改':'已恢复原配置'))
  }
}
