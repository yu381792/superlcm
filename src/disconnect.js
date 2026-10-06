import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {configFiles,readJson,mcpRegistration,ownMcp,script,definitions} from './harness.js'
import {findCli,runCommand,commandOptions} from './runtime.js'
import {claudePlugin} from './claude-plugin.js'
import {readHermesConfig,removeHermesIntegration} from './hermes-config.js'
import {applyTakeover} from './takeover.js'
import {dshSetupPreview} from './dsh-setup.js'
import {applyDshArchivePlan} from './dsh-summary-setup.js'

const read=file=>existsSync(file)?readFileSync(file,'utf8'):null
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const active=new Set()
export function ownHook(command,harness,store) {
  const word=harness==='codex'?'codex-hook':harness==='hermes'?'hermes-hook':'hook'
  return typeof command==='string'&&new RegExp('\\b'+word+'\\b').test(command)&&
    [script,join(store.dir,'superlcm.js')].some(path=>command.includes(path))
}
function withoutHooks(settings,harness,store) {
  const next=structuredClone(settings)
  for(const [event,groups] of Object.entries(next.hooks||{})) {
    if(!Array.isArray(groups)||groups.some(g=>!Array.isArray(g.hooks)))throw Error('无法识别钩子配置，未覆盖')
    const kept=groups.map(g=>({...g,hooks:g.hooks.filter(h=>!ownHook(h.command,harness,store))})).filter(g=>g.hooks.length)
    if(kept.length)next.hooks[event]=kept;else delete next.hooks[event]
  }
  if(next.hooks&&!Object.keys(next.hooks).length)delete next.hooks
  return next
}
export async function disconnectPreview(store,harness,{env=process.env,runCommand:run=runCommand}={}) {
  if(!definitions.some(h=>h.id===harness&&h.supported))throw Error('此工具不支持取消接入')
  if(harness==='dsh') {
    const plan=await dshSetupPreview(store,{env,runCommand:run})
    return {...plan,can_apply:plan.can_apply,action:'disconnect',notes:['取消 SuperLcm 归档、后台摘要和查询入口。','保留全部档案和摘要，恢复 DSH 自身压缩。'],_next:plan._next}
  }
  const files=configFiles(harness,env),piFile=join(files.hooks,'superlcm.ts')
  const paths=[...new Set(harness==='pi'?[piFile]:[files.mcp,files.hooks])]
  const raws=Object.fromEntries(paths.map(file=>[file,read(file)]))
  let registration=null,plugin=null,next=null,commands=[],blocker=null
  if(harness==='pi') {
    const raw=raws[piFile]
    if(raw!==null&&!raw.startsWith('// SuperLcm for Pi'))blocker='同名 Pi 扩展不属于 SuperLcm，未覆盖'
  } else if(harness==='hermes') {
    const c=await readHermesConfig(env)
    registration={found:!!c.mcp,config:c.mcp}
    commands=Object.values(c.hooks||{}).flat().map(h=>h.command).filter(c=>ownHook(c,harness,store))
  } else {
    registration=await mcpRegistration(harness,{env,runCommand:run})
    next=withoutHooks(readJson(files.hooks),harness,store)
    if(harness==='claude-code')plugin=await claudePlugin({env,runCommand:run})
  }
  if(registration?.found&&!ownMcp(registration,store))blocker='同名 MCP 不属于当前 SuperLcm 索引，未覆盖'
  const revision=hash([harness,raws,registration,plugin,store.integrationRevision(harness),harness==='claude-code'?store.takeover():null])
  return {harness,action:'disconnect',revision,can_apply:!blocker,blocker,files,index_home:store.dir,requires_reload:true,
    notes:['停止自动归档和后台摘要，保留全部已存对话。','仅撤销 SuperLcm 的配置，旧会话需要重新加载。'],
    _next:{raws,registration,plugin,next,commands,piFile}}
}
export async function applyDisconnect(store,harness,revision,options={}) {
  if(active.has(harness))throw Error('接入管理正在运行')
  active.add(harness)
  try {
    const plan=await disconnectPreview(store,harness,options)
    if(plan.revision!==revision)throw Error('配置已变化，请重新预览')
    if(!plan.can_apply)throw Error(plan.blocker)
    if(harness==='dsh')return await applyDshArchivePlan(store,plan,{...options,disconnect:true})
    const {env=process.env,runCommand:run=runCommand}=options,p=plan._next
    const backup=join(store.dir,'config-backups','disconnect-'+harness+'-'+randomUUID());mkdirSync(backup,{recursive:true,mode:0o700})
    for(const [file,raw] of Object.entries(p.raws))if(raw!==null)writeFileSync(join(backup,hash(file)+'.before'),raw,{mode:0o600})
    // The persistent gate immediately prevents cached hooks and in-flight
    // background writers from recording more, even before a host reload.
    store.setIntegrationEnabled(harness,false)
    if(harness==='claude-code') {
      applyTakeover(store,{enabled:false},env)
      if(p.plugin?.enabled)await run(findCli('claude',env)||'claude',['plugin','disable',p.plugin.id],commandOptions(env))
    }
    if(harness==='pi') {
      if(read(p.piFile)!==p.raws[p.piFile])throw Error('Pi 扩展已变化，未覆盖')
      if(p.raws[p.piFile]!==null)renameSync(p.piFile,join(backup,'superlcm.ts'))
    } else if(harness==='hermes') {
      if(read(plan.files.mcp)!==p.raws[plan.files.mcp])throw Error('Hermes 配置已变化，未覆盖')
      await removeHermesIntegration(env,{removeMcp:ownMcp(p.registration,store),commands:p.commands})
    } else {
      if(ownMcp(p.registration,store)) {
        const current=await mcpRegistration(harness,{env,runCommand:run})
        if(JSON.stringify(current)!==JSON.stringify(p.registration)||read(plan.files.mcp)!==p.raws[plan.files.mcp])throw Error('MCP 配置已变化，未撤销新的登记')
        await run(findCli(harness==='codex'?'codex':'claude',env)||harness,['mcp','remove',...(harness==='codex'?[]:['--scope','user']),'superlcm'],commandOptions(env))
      }
      // Claude native compaction restoration may have changed its settings;
      // re-read and filter only our hooks, preserving those restored values.
      const file=plan.files.hooks,before=read(file),current=before===null?{}:JSON.parse(before),next=withoutHooks(current,harness,store)
      if(JSON.stringify(current)!==JSON.stringify(next)) {
        if(read(file)!==before)throw Error('钩子配置已变化，未覆盖')
        mkdirSync(dirname(file),{recursive:true});const temp=file+'.superlcm-'+randomUUID();writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,file)
      }
    }
    const after=await disconnectPreview(store,harness,options),n=after._next
    const verified=harness==='pi'?read(n.piFile)===null:harness==='hermes'?!n.registration.found&&!n.commands.length:!n.registration.found&&!n.plugin?.enabled&&JSON.stringify(readJson(after.files.hooks))===JSON.stringify(n.next)
    if(!verified)throw Error('取消接入尚未验证通过；自动归档已暂停，备份位于 '+backup)
    return {harness,disconnected:true,configuration_verified:true,archives_preserved:true,reload_required:true,backup}
  } finally {active.delete(harness)}
}
