import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { configFiles, readJson, mcpRegistration, matchingMcp, script } from './harness.js'
import { findCli, runCommand as run, commandOptions } from './runtime.js'
const hash=text=>createHash('sha256').update(text).digest('hex')
const read=file=>existsSync(file)?readFileSync(file,'utf8'):null
const quoted=text=>process.platform==='win32'?'"'+text.replaceAll('"','\"')+'"':"'"+text.replaceAll("'","'\\''")+"'"
const active=new Set()
export async function setupPreview(store,harness,{env=process.env,runCommand=run}={}) {
  if(!['codex','claude-code'].includes(harness))throw Error('此 harness 暂未实现自动接入；不会写入猜测的配置')
  const files=configFiles(harness,env),bin=findCli(harness==='codex'?'codex':'claude',env)
  const raw=read(files.hooks),current=readJson(files.hooks)
  if(current.disableAllHooks===true)throw Error('宿主已禁用全部 hook；请先在宿主设置中确认启用')
  if(current.hooks!==undefined&&(typeof current.hooks!=='object'||Array.isArray(current.hooks)))throw Error('Unrecognized hook configuration; refusing to overwrite')
  const next=structuredClone(current);next.hooks??={}
  const hookCommand=[process.execPath,script,harness==='codex'?'codex-hook':'hook','--home',store.dir].map(quoted).join(' ')
  const added=[]
  for(const event of ['SessionStart','UserPromptSubmit','Stop','PostCompact','SessionEnd']) {
    const groups=next.hooks[event]||[];if(!Array.isArray(groups))throw Error('Unrecognized '+event+' hook list')
    const commandWord=harness==='codex'?'codex-hook':'hook'
    if(groups.some(g=>(g.hooks||[]).some(h=>h.type==='command'&&h.command?.includes(script)&&h.command.includes(commandWord))))continue
    const handler={type:'command',command:hookCommand,timeout:event==='SessionEnd'?3:15}
    next.hooks[event]=[...groups,{...(event==='SessionStart'?{matcher:'startup|resume|compact'}:{}),hooks:[handler]}];added.push(event)
  }
  const reg=await mcpRegistration(harness,{env,runCommand}),matches=matchingMcp(reg,store)
  const conflict=reg.found&&!matches
  const unsupportedLauncher=process.platform==='win32'&&bin&&/\.(cmd|bat)$/i.test(bin)
  const mcpArgs=harness==='codex'?['mcp','add','superlcm','--env','SUPERLCM_HOME='+store.dir,'--',process.execPath,script,'mcp']:['mcp','add-json','--scope','user','superlcm',JSON.stringify({type:'stdio',command:process.execPath,args:[script,'mcp'],env:{SUPERLCM_HOME:store.dir}})]
  const revision=hash(JSON.stringify({harness,files,raw,mcp:read(files.mcp),index:store.dir,script,bin}))
  return {harness,revision,can_apply:!!bin&&!conflict&&!unsupportedLauncher,blocker:unsupportedLauncher?'Windows 批处理 CLI 启动器尚未验证；请指定原生可执行文件':!bin?'未找到 CLI，请先安装对应宿主':conflict?'同名 superlcm 指向不同命令或索引；不覆盖已有配置，请先核对路径':null,files,index_home:store.dir,hook_events_added:added,hook_command:hookCommand,mcp_action:matches?'preserve':'register',mcp_command:bin?[bin,...mcpArgs]:null,requires_review:harness==='codex',notes:['仅修改本用户的 SuperLcm 接入；保留其他 MCP 和 hook。','保存前备份配置；不修改模型、登录或信任内部状态。',harness==='codex'?'完成后在 Codex /hooks 进行原生审核；之后重连 MCP。':'完成后在 Claude Code 重新载入 MCP/hook。'],_next:next}
}
export const publicPreview=x=>{const {_next,...publicValue}=x;return publicValue}
export async function applySetup(store,harness,revision,options={}) {
  if(active.has(harness))throw Error('同一 harness 的安装正在运行')
  active.add(harness)
  try {
    const p=await setupPreview(store,harness,options)
    if(p.revision!==revision)throw Error('配置已变化；请重新预览，不能覆盖并发更改')
    if(!p.can_apply)throw Error(p.blocker)
    const backups=[]
    const backupDir=join(store.dir,'config-backups');mkdirSync(backupDir,{recursive:true,mode:0o700})
    for(const file of [p.files.mcp,p.files.hooks])if(existsSync(file)){const name=harness+'-'+hash(file).slice(0,10)+'-'+Date.now()+'-'+randomBytes(3).toString('hex')+'.bak';const path=join(backupDir,name);writeFileSync(path,readFileSync(file),{flag:'wx',mode:0o600});backups.push({file,backup:path})}
    if(p.mcp_action==='register') {
      const [bin,...args]=p.mcp_command
      try{await (options.runCommand||run)(bin,args,commandOptions(options.env||process.env))}catch{throw Error('官方 CLI 注册 MCP 失败；未写 hook。备份位于 '+backupDir)}
    }
    // Recheck the independently edited hooks file immediately before its atomic write.
    const before=readJson(p.files.hooks)
    const p2=await setupPreview(store,harness,options)
    if(JSON.stringify(before)!==JSON.stringify(readJson(p.files.hooks))||p2.hook_command!==p.hook_command||JSON.stringify(p2._next)!==JSON.stringify(p._next))throw Error('hook 配置发生变化；停止，保留已有更改和备份')
    if(p.hook_events_added.length){mkdirSync(dirname(p.files.hooks),{recursive:true,mode:0o700});const temp=p.files.hooks+'.superlcm-'+randomBytes(6).toString('hex');writeFileSync(temp,JSON.stringify(p._next,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,p.files.hooks)}
    const verified=matchingMcp(await mcpRegistration(harness,options),store)
    return {saved:true,configuration_verified:verified,state:verified?'awaiting_client_reload':'configuration_unverified',harness,backups,hook_events_added:p.hook_events_added,mcp_action:p.mcp_action,requires_review:p.requires_review,trust_granted:false,note:p.requires_review?'已写配置；仍需 Codex /hooks 原生审核。':'已写配置；在 Claude Code 重连后生效。'}
  }finally{active.delete(harness)}
}
