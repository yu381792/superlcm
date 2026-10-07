import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {dshHome,dshEntries,inspectDshTree,isDshEngine,isDshArchive} from './dsh-connection.js'
import {installDshPackage,removeManagedBlock,packageInfo} from './dsh-install.js'
import {uiManifest,linkUi} from './dsh-ui-install.js'
import {retireLegacyDshRows} from './dsh-retire-legacy.js'
import {controlsPath} from './dsh-controls.js'
import {controlsConfig} from '../dsh/controls-config.js'
import {enableSummaryOnly} from './integration.js'
import {runCommand,commandOptions} from './runtime.js'

const read=file=>existsSync(file)?readFileSync(file,'utf8'):null
const block=name=>['# BEGIN SuperLcm '+name,'# END SuperLcm '+name]
export const ownDsh=e=>(isDshEngine(e)&&e.name!=='@deepseek-ai/dsh-compaction-basic')||isDshArchive(e)
export function stripDshIntegration(raw,profile=false) {
  let text=raw||''
  for(const name of [profile?'managed DSH integration':'global DSH integration',...(profile?['preset compaction inheritance','optional DSH takeover']:[])]) {
    const [begin,end]=block(name)
    // A user-edited profile can retain only our closing comment. Removing that
    // comment preserves every remaining user row; never guess a missing start.
    if(profile&&!text.includes(begin)&&text.includes(end))text=text.replace(end,'')
    else text=removeManagedBlock(text,begin,end)
  }
  return text
}
const modelRows=tree=>dshEntries(tree).filter(e=>/dsh-llm-|dsh-agent-default-model$/.test(e.name||'')).map(e=>[e.id,e.name,e.config])
const append=(raw,name,rows,host)=>raw.replace(/^\s*\[\]\s*$/gm,'').trimEnd()+'\n\n'+block(name)[0]+'\n'+host.yaml.dump(rows,{schema:host.schema,noRefs:true,lineWidth:-1})+block(name)[1]+'\n'

// Connect and disconnect share the same migration: retire only SuperLcm's
// context replacement, and keep a real host-native compactor in each profile.
export async function applyDshArchivePlan(store,plan,{env=process.env,runCommand:run=runCommand,disconnect=false}={}) {
  const saved=plan._next,{host,profiles}=saved.configuration
  const backup=join(store.dir,'config-backups','dsh-'+(disconnect?'disconnect-':'summary-')+randomUUID())
  mkdirSync(backup,{recursive:true,mode:0o700})
  const files=new Map([[saved.file,saved.raw],[controlsPath(store),saved.controlsRaw]])
  for(const p of profiles){files.set(join(p.dir,'package.json'),p.manifest);files.set(join(p.dir,'cordis.patch.yml'),p.patch)}
  for(const [file,raw] of files)if(raw!==null)writeFileSync(join(backup,String([...files.keys()].indexOf(file))+'.before'),raw,{mode:0o600})
  const links=[],changes=[]
  const write=(file,before,after)=>{
    if(file.endsWith('cordis.patch.yml')&&host.parse(after)==null)after=after.trimEnd()+'\n[]\n'
    if(read(file)!==before)throw Error('配置已变化，请重新预览')
    if(before===after)return
    const temp=file+'.superlcm-'+randomUUID();mkdirSync(join(file,'..'),{recursive:true});writeFileSync(temp,after,{flag:'wx',mode:0o600});renameSync(temp,file)
    changes.push({file,before,after})
  }
  const dump=async p=>host.parse((await run(host.bin,[...host.argsPrefix,'--profile',p.name,'--dump-config'],{...commandOptions(env),timeout:5000})).stdout)
  for(const [file,raw] of files)if(read(file)!==raw)throw Error('配置已变化，请重新预览')
  const stage=disconnect?null:installDshPackage(store,host)
  try {
    if(stage)links.push(linkUi({name:'home-global',dir:dshHome(env)},stage,backup))
    for(const p of profiles) {
      let manifest
      if(disconnect) {
        manifest=JSON.parse(p.manifest)
        manifest.dsh.profile.bundles=manifest.dsh.profile.bundles.filter(name=>!['superlcm','superlcm-mcp','SuperLcm'].includes(name))
        for(const section of ['dependencies','devDependencies','optionalDependencies'])for(const name of ['superlcm','superlcm-mcp','SuperLcm'])if(manifest[section])delete manifest[section][name]
      } else {manifest=uiManifest(p,stage);links.push(linkUi(p,stage,backup))}
      // Use the host's manifest writer, then record exactly what it wrote.
      const file=join(p.dir,'package.json')
      if(read(file)!==p.manifest)throw Error('配置已变化，请重新预览')
      const ops=await import(pathToFileURL(host.require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
      await ops.saveManifest(p.dir,manifest);changes.push({file,before:p.manifest,after:read(file)})
      const clean=retireLegacyDshRows(stripDshIntegration(p.patch,true),host)
      if(p.patch!==null||clean)write(join(p.dir,'cordis.patch.yml'),p.patch,clean)
    }
    let global=stripDshIntegration(saved.raw)
    if(!disconnect)global=append(global,'global DSH integration',[{insert:[{id:'superlcm-global',name:'superlcm',config:{archiveOnly:true,archiveHome:store.dir,controlFile:controlsPath(store)}}]}],host)
    write(saved.file,saved.raw,global)
    for(const p of profiles) {
      let tree=await dump(p)
      if(!dshEntries(tree).some(e=>e.name==='@deepseek-ai/dsh-compaction-basic')) {
        const file=join(p.dir,'cordis.patch.yml'),before=read(file)
        write(file,before,append(before||'','native DSH restore',[{insert:[{id:'superlcm-restored-native',name:'@deepseek-ai/dsh-compaction-basic',config:{auto:true}}]}],host))
        tree=await dump(p)
      }
      if(JSON.stringify(modelRows(tree))!==JSON.stringify(modelRows(p.tree)))throw Error('原有聊天模型配置发生变化，已停止接入')
      const entries=dshEntries(tree)
      if(!entries.some(e=>e.name==='@deepseek-ai/dsh-compaction-basic'&&e.config?.auto!==false)||
        (disconnect?entries.some(ownDsh):!inspectDshTree(tree).configured))throw Error('原生压缩或归档接入验证失败')
    }
    if(saved.controlsRaw!==null) {
      const doc=JSON.parse(saved.controlsRaw)
      doc.config=controlsConfig({...doc.config,auto:false,budgetMode:'ratio',foldBatchTokens:doc.config.budgetMode==='ratio'?doc.config.foldBatchTokens:(store.tuning().target_tokens||20000)})
      doc.revision=randomUUID()
      write(controlsPath(store),saved.controlsRaw,JSON.stringify(doc,null,2)+'\n')
    }
    if(disconnect)store.setIntegrationEnabled('dsh',false)
    else enableSummaryOnly(store,'dsh',env)
    const result={harness:'dsh',scope:'global',version:packageInfo.version,mode:'summary-only',saved:true,configuration_verified:true,disconnected:disconnect,native_compaction:true,restart_required:true,backup,package:stage,serviceRestarted:false}
    writeFileSync(join(backup,'receipt.json'),JSON.stringify(result,null,2),{mode:0o600});return result
  } catch(error) {
    let conflict=false
    for(const change of changes.reverse()) {
      if(read(change.file)!==change.after){conflict=true;continue}
      if(change.before===null)renameSync(change.file,join(backup,'failed-'+randomUUID()))
      else writeFileSync(change.file,change.before,{mode:0o600})
    }
    for(const link of links.reverse())try{link.restore()}catch{conflict=true}
    const safe=['配置已变化，请重新预览','原有聊天模型配置发生变化，已停止接入','原生压缩或归档接入验证失败','SuperLcm 托管配置段不完整，请先核对','已有同名 superlcm 包，未覆盖'].includes(error.message)?error.message:'DSH 配置验证或写入失败，请检查宿主日志'
    throw Error(safe+'；'+(conflict?'存在并发修改，未覆盖这些更改':'已恢复原配置')+'；备份位于 '+backup)
  }
}
