import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const run=promisify(execFile)
const valid=id=>typeof id==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)

// Metadata only: these probes never submit a prompt or invoke a paid model.
export async function modelCatalog(kind,{env=process.env,runCommand=run}={}) {
  if(kind==='codex-cli') {
    try {
      const file=join(env.CODEX_HOME||join(homedir(),'.codex'),'models_cache.json')
      if(statSync(file).size>2*1024*1024)throw new Error('Model cache is too large')
      const cache=JSON.parse(readFileSync(file,'utf8'))
      const models=(Array.isArray(cache.models)?cache.models:[])
        .filter(m=>m.visibility==='list' && valid(m.slug))
        .sort((a,b)=>(a.priority??999)-(b.priority??999))
        .slice(0,50).map(m=>({id:m.slug,label:typeof m.display_name==='string'?m.display_name.slice(0,100):m.slug}))
      return {kind,models,source:'Codex CLI models_cache.json',updated_at:cache.fetched_at||null,note:models.length?'本机 CLI 缓存；是否可调用仍以登录和订阅权限为准。':'CLI 缓存没有可列出的模型；可手动输入模型名。'}
    }catch {return {kind,models:[],source:'Codex CLI models_cache.json',updated_at:null,note:'未找到可用的本机 Codex 模型缓存；可手动输入模型名。'}}
  }
  if(kind==='cli') {
    try {
      const {stdout}=await runCommand(env.SUPERLCM_CLAUDE_CLI_BIN||'claude',['--help'],{env,timeout:5000,maxBuffer:128*1024,windowsHide:true})
      const section=stdout.split('--model <model>')[1]?.split(/\n\s{2}-[a-zA-Z]/)[0]||''
      const aliasText=section.split("model's full name")[0]
      const ids=[...new Set([...aliasText.matchAll(/'([a-zA-Z][a-zA-Z0-9_-]{0,127})'/g)].map(m=>m[1]))].slice(0,15)
      return {kind,models:ids.map(id=>({id,label:id})),source:'Claude CLI --help',updated_at:null,note:'CLI 文档中的模型别名示例，不是订阅可用性验证；完整模型名可手动输入。'}
    }catch {return {kind,models:[],source:'Claude CLI --help',updated_at:null,note:'无法读取 Claude CLI 模型帮助信息；可手动输入模型名。'}}
  }
  throw new Error('Unknown CLI model backend')
}

// Configured is not connected. ClientInfo is self-reported, and hooks only show past activity.
export async function harnessConnections(store,{env=process.env,runCommand=run}={}) {
  const seen=store.clients()
  const names=['codex','claude-code']
  const checks=await Promise.all(names.map(async name=>{
    const bin=name==='codex'?(env.SUPERLCM_CODEX_CLI_BIN||'codex'):(env.SUPERLCM_CLAUDE_CLI_BIN||'claude')
    try {await runCommand(bin,['mcp','get','superlcm'],{env,timeout:5000,maxBuffer:128*1024,windowsHide:true});return true}
    catch{return false}
  }))
  const known=store.harnessSettings().map(x=>x.harness)
  const observed=seen.filter(x=>x.kind==='hook' || x.kind==='mcp-self-reported')
  const fromClient=x=>{if(!x||/^(anonymous|modern-anonymous|web-self-test)$/i.test(x))return null;return /codex/i.test(x)?'codex':/claude/i.test(x)?'claude-code':x.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||null}
  const all=[...new Set([...names.filter((_,i)=>checks[i]),...known,...observed.map(x=>fromClient(x.client)).filter(Boolean)])]
  return all.map(harness=>{
    const hook=observed.find(x=>x.kind==='hook'&&x.client===harness)
    const mcp=observed.find(x=>x.kind==='mcp-self-reported'&&fromClient(x.client)===harness)
    return {harness,configured:checks[names.indexOf(harness)]===true,hook_seen:hook?.seen_at||null,mcp_self_reported:mcp?.seen_at||null}
  })
}
