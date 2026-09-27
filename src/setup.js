import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { configFiles, readJson, mcpRegistration, matchingMcp, script } from './harness.js'
import { findCli, runCommand as run, commandOptions } from './runtime.js'
import { readHermesConfig, writeHermesConfig, hermesPython, HERMES_EVENTS } from './hermes-config.js'
import { piExtension } from './pi.js'
const hash=text=>createHash('sha256').update(text).digest('hex')
const read=file=>existsSync(file)?readFileSync(file,'utf8'):null
const quoted=text=>process.platform==='win32'?'"'+text.replaceAll('"','\"')+'"':"'"+text.replaceAll("'","'\\''")+"'"
const active=new Set()
export const hookCommandFor=(store,word)=>[process.execPath,script,word,'--home',store.dir].map(quoted).join(' ')
// Hermes: MCP server + per-turn shell hooks, written through Hermes' own config code.
async function hermesPreview(store,env){
  const files={mcp:configFiles('hermes',env).mcp,hooks:configFiles('hermes',env).mcp},bin=findCli('hermes',env),py=hermesPython(env)
  const cfg=py?await readHermesConfig(env):{mcp:null,hooks:{}}
  const reg={found:!!cfg.mcp,enabled:cfg.mcp?.enabled!==false,config:cfg.mcp},matches=matchingMcp(reg,store),conflict=reg.found&&!matches
  const command=hookCommandFor(store,'hermes-hook'),added=HERMES_EVENTS.filter(event=>!(cfg.hooks?.[event]||[]).some(h=>h?.command===command))
  const mcp={command:process.execPath,args:[script,'mcp'],env:{SUPERLCM_HOME:store.dir,SUPERLCM_CLIENT:'hermes'}}
  const revision=hash(JSON.stringify({harness:'hermes',raw:read(files.mcp),index:store.dir,script}))
  return {harness:'hermes',revision,can_apply:!!bin&&!!py&&!conflict,blocker:!bin?'未找到 CLI，请先安装对应宿主':!py?'找不到 Hermes 自带的 Python，无法安全修改它的配置':conflict?'同名 superlcm 指向不同命令或索引；不覆盖已有配置，请先核对路径':null,files,index_home:store.dir,hook_events_added:added,hook_command:command,mcp_action:matches?'preserve':'register',requires_review:true,notes:['通过 Hermes 自己的配置代码写入，保留其他设置。','完成后启动一次 Hermes，确认允许 SuperLcm 的钩子。'],_next:{mcp:matches?null:mcp,hooks:Object.fromEntries(added.map(event=>[event,{command,timeout:15}]))}}
}
// Pi: one auto-discovered extension file (tools + per-turn capture); no MCP support in Pi itself.
function piPreview(store,env){
  const file=join(configFiles('pi',env).hooks,'superlcm.ts'),files={mcp:file,hooks:file},bin=findCli('pi',env)
  const content=piExtension({node:process.execPath,script,home:store.dir}),current=read(file)
  const ours=current===null||current.startsWith('// SuperLcm for Pi'),same=current===content
  return {harness:'pi',revision:hash(JSON.stringify({harness:'pi',current,content})),can_apply:!!bin&&ours,blocker:!bin?'未找到 CLI，请先安装对应宿主':!ours?'同名扩展文件不是 SuperLcm 生成的；不覆盖，请先核对 '+file:null,files,index_home:store.dir,hook_events_added:same?[]:['session_start','turn_end','session_compact','session_shutdown'],hook_command:null,mcp_action:same?'preserve':'register',requires_review:false,notes:['只新增一个扩展文件，不改 Pi 的设置。','新开的 Pi 对话会自动加载。'],_next:{content}}
}
export async function setupPreview(store,harness,{env=process.env,runCommand=run}={}) {
  if(harness==='hermes')return hermesPreview(store,env)
  if(harness==='pi')return piPreview(store,env)
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
    for(const file of new Set([p.files.mcp,p.files.hooks]))if(existsSync(file)){const name=harness+'-'+hash(file).slice(0,10)+'-'+Date.now()+'-'+randomBytes(3).toString('hex')+'.bak';const path=join(backupDir,name);writeFileSync(path,readFileSync(file),{flag:'wx',mode:0o600});backups.push({file,backup:path})}
    if(harness==='hermes'||harness==='pi'){
      if(harness==='hermes'&&(p._next.mcp||p.hook_events_added.length))await writeHermesConfig(options.env||process.env,p._next)
      if(harness==='pi'&&p.mcp_action==='register'){mkdirSync(dirname(p.files.mcp),{recursive:true});const temp=p.files.mcp+'.superlcm-'+randomBytes(6).toString('hex');writeFileSync(temp,p._next.content,{flag:'wx',mode:0o644});renameSync(temp,p.files.mcp)}
      const after=await setupPreview(store,harness,options),verified=after.mcp_action==='preserve'&&!after.hook_events_added.length
      return {saved:true,configuration_verified:verified,state:verified?'awaiting_client_reload':'configuration_unverified',harness,backups,hook_events_added:p.hook_events_added,mcp_action:p.mcp_action,requires_review:p.requires_review,trust_granted:false}
    }
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
