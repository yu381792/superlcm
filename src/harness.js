import { connectionEvidence } from './connections.js'
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCli, paths, runCommand as run, commandOptions, preferredNode } from './runtime.js'
import { refreshPluginEntry } from './plugin-entry.js'
import { compressionCapabilities } from './compression-status.js'
import { inspectDsh, dshHome } from './dsh-connection.js'
// The file other tools are connected to: this cli.js, or the stable entry when running from the Claude plugin.
export const script = refreshPluginEntry() || fileURLToPath(new URL('./cli.js',import.meta.url))
export const definitions=[{id:'codex',label:'Codex',bin:'codex',supported:true},{id:'claude-code',label:'Claude Code / Desktop Code',bin:'claude',supported:true},{id:'hermes',label:'Hermes',bin:'hermes',supported:true,local:true},{id:'pi',label:'Pi',bin:'pi',supported:true,local:true},{id:'dsh',label:'DSH',bin:'dsh',supported:true,nativeCompression:true},{id:'opencode',label:'OpenCode',bin:'opencode',supported:false},{id:'gemini',label:'Gemini CLI',bin:'gemini',supported:false}]
export function configFiles(harness,env=process.env) {
  const p=paths(env)
  if(harness==='codex')return {mcp:join(p.codex,'config.toml'),hooks:join(p.codex,'hooks.json'),transcripts:join(p.codex,'sessions')}
  if(harness==='claude-code')return {mcp:env.CLAUDE_CONFIG_DIR?join(p.claude,'.claude.json'):join(p.home,'.claude.json'),hooks:join(p.claude,'settings.json'),transcripts:join(p.claude,'projects')}
  if(harness==='hermes'){const home=env.HERMES_HOME||join(p.home,'.hermes');return {mcp:join(home,'config.yaml'),hooks:join(home,'config.yaml'),transcripts:join(home,'state.db')}}
  if(harness==='pi'){const home=env.PI_CODING_AGENT_DIR||join(p.home,'.pi','agent');return {mcp:join(home,'settings.json'),hooks:join(home,'extensions'),transcripts:join(home,'sessions')}}
  if(harness==='dsh')return {profiles:join(dshHome(env),'profiles'),transcripts:join(dshHome(env),'sessions')}
  throw Error('Unsupported local harness adapter')
}
export function readJson(file) {if(!existsSync(file))return {};const value=JSON.parse(readFileSync(file,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected configuration object: '+file);return value}
export async function mcpRegistration(harness,{env=process.env,runCommand=run}={}) {
  const files=configFiles(harness,env)
  if(harness==='codex') {
    try {const {stdout}=await runCommand(findCli('codex',env)||'codex',['mcp','get','superlcm','--json'],commandOptions(env));const x=JSON.parse(stdout);return {config:x.transport,enabled:x.enabled!==false,found:true}}
    catch {return {found:false,enabled:false,error:existsSync(files.mcp)?'CLI 未能读取 superlcm 配置（不存在或读取失败）':null}}
  }
  try {const config=readJson(files.mcp).mcpServers?.superlcm;return {found:!!config,enabled:true,config}}
  catch {return {found:false,enabled:false,error:'Claude 用户配置无法解析'}}
}
// SuperLcm's own registration (this script, this index), whichever node launches it.
export function ownMcp(reg,store) {
  const c=reg?.config
  if(!reg?.found||!c||!['stdio',undefined].includes(c.type))return false
  if(!Array.isArray(c.args)||c.args.length!==2||resolve(c.args[0])!==script||c.args[1]!=='mcp')return false
  const configuredHome=c.env?.SUPERLCM_HOME||c.env?.SUPERLCM_CLAUDE_HOME
  const defaultHome=resolve(process.env.SUPERLCM_HOME||process.env.SUPERLCM_CLAUDE_HOME||join(paths().home,'.superlcm-claude'))
  return resolve(configuredHome||defaultHome)===store.dir
}
// Up to date: our registration, enabled, launched by the node setup would write now.
export function matchingMcp(reg,store,env=process.env) {
  if(!ownMcp(reg,store)||!reg.enabled)return false
  // Never execute an unknown configured binary in a connection test.
  try{return realpathSync(reg.config.command)===realpathSync(preferredNode(env).path)}catch{return false}
}
export function hookInspection(harness,env=process.env) {
  const file=configFiles(harness,env).hooks;const events=['SessionStart','UserPromptSubmit','Stop','PostCompact','SessionEnd'];let config
  try{config=readJson(file)}catch{return {file,status:'invalid',events:[],trust:'unknown',note:'hook 配置无法解析'}}
  const command=harness==='codex'?'codex-hook':'hook'
  const enabled=config.disableAllHooks!==true
  const matched=events.filter(event=>(config.hooks?.[event]||[]).some(group=>(group.hooks||[]).some(h=>h.type==='command'&&typeof h.command==='string'&&h.command.includes(script)&&new RegExp('\\b'+command+'\\b').test(h.command))))
  return {file,status:!enabled?'disabled':matched.length===events.length?'configured':matched.length?'partial':'missing',events:matched,trust:harness==='codex'?'review-in-codex':'host-controlled',note:harness==='codex'?'请在 Codex /hooks 查看当前定义是否已信任；本页不写入信任状态。':'宿主权限仍由 Claude Code 控制。'}
}
// Newest transcript the tool has written (Codex: the latest sessions/YYYY/MM/DD folder; Claude: projects/*/*.jsonl).
export function newestTranscript(harness,env=process.env) {
  const root=configFiles(harness,env).transcripts,list=dir=>{try{return readdirSync(dir)}catch{return []}},mtime=file=>{try{return statSync(file).mtimeMs}catch{return 0}}
  let files=[]
  if(harness==='codex'){let dir=root;for(let i=0;i<3;i++){const next=list(dir).filter(n=>/^\d+$/.test(n)).sort().at(-1);if(!next)return null;dir=join(dir,next)}files=list(dir).filter(n=>n.endsWith('.jsonl')).map(n=>join(dir,n))}
  else if(harness==='claude-code')files=list(root).slice(0,500).flatMap(d=>list(join(root,d)).filter(n=>n.endsWith('.jsonl')).map(n=>join(root,d,n))).slice(0,5000)
  else return null
  return files.reduce((max,file)=>Math.max(max,mtime(file)),0)||null
}
// Hooks connected but not firing (for example Codex waiting for the changed hooks to be approved): the tool has
// finished writing a conversation (quiet for 2 minutes) after the last time any SuperLcm hook ran.
export function captureStale(newest,hookSeen,now=Date.now()) {
  if(!newest||newest>now-120000)return false
  const seen=hookSeen?Date.parse(hookSeen.replace(' ','T')+'Z'):0
  return newest>seen+60000
}
export async function harnessConnections(store,{env=process.env,runCommand=run}={}) {
  const seen=store.clients();const rows=await Promise.all(definitions.map(async def=>{
    const bin=findCli(def.bin,env),files=def.supported||def.local?configFiles(def.id,env):null
    const detected=!!bin||!!files&&Object.values(files).some(file=>existsSync(file))
    if(!detected&&!def.supported)return null
    let version=null
    if(bin)try{version=(await runCommand(bin,['--version'],{...commandOptions(env),timeout:3000})).stdout.trim().split('\n')[0].slice(0,100)}catch{}
    if(def.id==='dsh') {
      const dsh = await inspectDsh(store,{env,runCommand})
      return {harness:'dsh',label:def.label,supported:true,local_conversations:false,detected:dsh.detected,bin,version,
        configured:dsh.configured,configuration_matches:dsh.configuration_matches,hook:{status:dsh.configured?'configured':'missing'},
        connection_evidence:connectionEvidence(store,'dsh'),index_home:store.dir,compression:compressionCapabilities.dsh,dsh}
    }
    const native=['codex','claude-code'].includes(def.id)
    let reg={found:false},hook={status:'unsupported',events:[]},plan=null
    if(native){reg=await mcpRegistration(def.id,{env,runCommand});hook=hookInspection(def.id,env)}
    else if(def.supported&&bin){try{const {setupPreview}=await import('./setup.js');plan=await setupPreview(store,def.id,{env,runCommand});reg={found:plan.existing||plan.mcp_action==='preserve'||(plan.can_apply===false&&!!plan.blocker&&/同名/.test(plan.blocker))};hook={status:plan.hook_events_added.length?'missing':'configured',events:[]}}catch(error){reg={found:false,error:error.message}}}
    // Claude Code: SuperLcm as a plugin is the connection; the older MCP + hooks only count without it.
    let claude=null
    if(def.id==='claude-code'&&bin){const cp=await import('./claude-plugin.js');const plugin=await cp.claudePlugin({env,runCommand});claude={plugin,legacy:await cp.claudeLegacy(store,{env,runCommand}),terminal_version:version?.match(/\d+\.\d+\.\d+/)?.[0]||null,desktop_version:cp.desktopClaudeVersion(env),modules_min:cp.MODULE_MIN}}
    const hookSeen=seen.find(c=>c.kind==='hook'&&c.client===def.id)?.seen_at||null
    const mcpSeen=seen.find(c=>c.kind==='mcp-self-reported'&&(def.id==='claude-code'?/claude/i:/codex/i).test(c.client)&&!c.client.includes('self-test'))?.seen_at||null
    const viaPlugin=!!claude?.plugin?.enabled
    const capture_stale=native&&(!!reg.found||viaPlugin)&&captureStale(newestTranscript(def.id,env),hookSeen)
    return {compression:compressionCapabilities[def.id]||{supported:false,owner:null,mode:'unsupported'},capture_stale,node_borrowed:preferredNode(env).borrowed,harness:def.id,label:def.label,supported:def.supported,local_conversations:!!(def.supported||def.local),detected,bin,version,configured:!!reg.found||viaPlugin,configuration_matches:viaPlugin?!claude.plugin.outdated:native?matchingMcp(reg,store,env)&&(await import('./setup.js')).nativeHooksCurrent(store,def.id,env):!!plan&&plan.mcp_action==='preserve'&&!plan.hook_events_added.length,config_error:reg.error||null,hook,files,hook_seen:hookSeen,mcp_self_reported:native?mcpSeen:null,connection_evidence:connectionEvidence(store,def.id),connection:'unverified',index_home:store.dir,...(claude?{claude}:{})}
  }))
  for(const x of store.harnessSettings())if(!rows.some(r=>r?.harness===x.harness))rows.push({harness:x.harness,label:x.harness,supported:false,detected:false,configured:false,hook:{status:'unsupported'},connection:'unverified'})
  return rows.filter(Boolean)
}
