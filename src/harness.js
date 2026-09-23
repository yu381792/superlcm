import { connectionEvidence } from './connections.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCli, paths, runCommand as run, commandOptions } from './runtime.js'
export const script = fileURLToPath(new URL('./cli.js',import.meta.url))
export const definitions=[{id:'codex',label:'Codex',bin:'codex',supported:true},{id:'claude-code',label:'Claude Code / Desktop Code',bin:'claude',supported:true},{id:'hermes',label:'Hermes',bin:'hermes',supported:false,local:true},{id:'pi',label:'Pi',bin:'pi',supported:false,local:true},{id:'opencode',label:'OpenCode',bin:'opencode',supported:false},{id:'gemini',label:'Gemini CLI',bin:'gemini',supported:false}]
export function configFiles(harness,env=process.env) {
  const p=paths(env)
  if(harness==='codex')return {mcp:join(p.codex,'config.toml'),hooks:join(p.codex,'hooks.json'),transcripts:join(p.codex,'sessions')}
  if(harness==='claude-code')return {mcp:env.CLAUDE_CONFIG_DIR?join(p.claude,'.claude.json'):join(p.home,'.claude.json'),hooks:join(p.claude,'settings.json'),transcripts:join(p.claude,'projects')}
  if(harness==='hermes'){const home=env.HERMES_HOME||join(p.home,'.hermes');return {mcp:join(home,'config.yaml'),hooks:join(home,'hooks'),transcripts:join(home,'state.db')}}
  if(harness==='pi'){const home=env.PI_CODING_AGENT_DIR||join(p.home,'.pi','agent');return {mcp:join(home,'settings.json'),hooks:join(home,'extensions'),transcripts:join(home,'sessions')}}
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
export function matchingMcp(reg,store) {
  const c=reg?.config
  if(!reg?.found||!reg.enabled||!c||!['stdio',undefined].includes(c.type))return false
  if(!Array.isArray(c.args)||c.args.length!==2||resolve(c.args[0])!==script||c.args[1]!=='mcp')return false
  // Never execute an unknown configured binary in a connection test.
  let sameBinary=false;try{sameBinary=realpathSync(c.command)===realpathSync(process.execPath)||realpathSync(c.command)===realpathSync(findCli('node'))}catch{}
  const configuredHome=c.env?.SUPERLCM_HOME||c.env?.SUPERLCM_CLAUDE_HOME
  const defaultHome=resolve(process.env.SUPERLCM_HOME||process.env.SUPERLCM_CLAUDE_HOME||join(paths().home,'.superlcm-claude'))
  return sameBinary&&resolve(configuredHome||defaultHome)===store.dir
}
export function hookInspection(harness,env=process.env) {
  const file=configFiles(harness,env).hooks;const events=['SessionStart','UserPromptSubmit','Stop','PostCompact','SessionEnd'];let config
  try{config=readJson(file)}catch{return {file,status:'invalid',events:[],trust:'unknown',note:'hook 配置无法解析'}}
  const command=harness==='codex'?'codex-hook':'hook'
  const enabled=config.disableAllHooks!==true
  const matched=events.filter(event=>(config.hooks?.[event]||[]).some(group=>(group.hooks||[]).some(h=>h.type==='command'&&typeof h.command==='string'&&h.command.includes(script)&&new RegExp('\\b'+command+'\\b').test(h.command))))
  return {file,status:!enabled?'disabled':matched.length===events.length?'configured':matched.length?'partial':'missing',events:matched,trust:harness==='codex'?'review-in-codex':'host-controlled',note:harness==='codex'?'请在 Codex /hooks 查看当前定义是否已信任；本页不写入信任状态。':'宿主权限仍由 Claude Code 控制。'}
}
export async function harnessConnections(store,{env=process.env,runCommand=run}={}) {
  const seen=store.clients();const rows=await Promise.all(definitions.map(async def=>{
    const bin=findCli(def.bin,env),files=def.supported||def.local?configFiles(def.id,env):null
    const detected=!!bin||!!files&&Object.values(files).some(file=>existsSync(file))
    if(!detected&&!def.supported)return null
    let version=null
    if(bin)try{version=(await runCommand(bin,['--version'],{...commandOptions(env),timeout:3000})).stdout.trim().split('\n')[0].slice(0,100)}catch{}
    const reg=def.supported?await mcpRegistration(def.id,{env,runCommand}):{found:false}
    const hook=def.supported?hookInspection(def.id,env):{status:'unsupported',events:[]}
    const hookSeen=seen.find(c=>c.kind==='hook'&&c.client===def.id)?.seen_at||null
    const mcpSeen=seen.find(c=>c.kind==='mcp-self-reported'&&(def.id==='claude-code'?/claude/i:/codex/i).test(c.client)&&!c.client.includes('self-test'))?.seen_at||null
    return {harness:def.id,label:def.label,supported:def.supported,local_conversations:!!(def.supported||def.local),detected,bin,version,configured:!!reg.found,configuration_matches:def.supported&&matchingMcp(reg,store),config_error:reg.error||null,hook,files,hook_seen:hookSeen,mcp_self_reported:def.supported?mcpSeen:null,connection_evidence:connectionEvidence(store,def.id),connection:'unverified',index_home:store.dir}
  }))
  for(const x of store.harnessSettings())if(!rows.some(r=>r?.harness===x.harness))rows.push({harness:x.harness,label:x.harness,supported:false,detected:false,configured:false,hook:{status:'unsupported'},connection:'unverified'})
  return rows.filter(Boolean)
}
