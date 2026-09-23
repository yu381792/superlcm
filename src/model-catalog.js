import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand as run, paths, findCli, commandOptions, validModel } from './runtime.js'
import { subscriptionEnv } from './claude-cli.js'
export { harnessConnections } from './harness.js'

// Initialize-only control protocol: no user message, inference, tools, hooks or persisted session.
export function claudeModels({env=process.env,spawnProcess=spawn,timeoutMs=15000}={}) {
  return new Promise((resolve,reject)=>{
    const args=['--print','--input-format','stream-json','--output-format','stream-json','--verbose','--no-session-persistence','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--settings','{"disableAllHooks":true}','--tools','']
    const child=spawnProcess(findCli('claude',env)||env.SUPERLCM_CLAUDE_CLI_BIN||'claude',args,{env:subscriptionEnv(env),cwd:tmpdir(),stdio:['pipe','pipe','pipe'],windowsHide:true})
    let settled=false,text='',bytes=0
    const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);child.stdin.end();if(child.exitCode===null||child.exitCode===undefined)child.kill('SIGTERM');err?reject(err):resolve(value)}
    const timer=setTimeout(()=>finish(new Error('Claude 初始化目录读取超时')),timeoutMs)
    child.on('error',()=>finish(new Error('Claude CLI 无法启动')))
    child.on('close',code=>{if(!settled)finish(new Error('Claude 未返回模型目录（exit '+code+'）'))})
    child.stderr.resume();child.stdin.on('error',()=>{})
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      bytes+=Buffer.byteLength(chunk);if(bytes>2*1024*1024)return finish(new Error('Claude 目录响应超限'))
      text+=chunk;let i;while((i=text.indexOf('\n'))>=0){const line=text.slice(0,i);text=text.slice(i+1);let msg;try{msg=JSON.parse(line)}catch{continue}
        if(msg.type==='control_response'&&msg.response?.request_id==='superlcm-models'){
          const models=msg.response.response?.models
          if(msg.response.subtype!=='success'||!Array.isArray(models))return finish(new Error('CLI 不支持初始化模型目录；不使用帮助示例代替'))
          return finish(null,models)
        }
      }
    })
    child.stdin.write(JSON.stringify({type:'control_request',request_id:'superlcm-models',request:{subtype:'initialize'}})+'\n')
  })
}
export async function modelCatalog(kind,{env=process.env,runCommand=run,readClaude=claudeModels}={}) {
  const fetched=new Date().toISOString()
  if(kind==='codex-cli') {
    let cache,source='Codex CLI · debug models',stale=false,error=null,updated=fetched
    try {const result=await runCommand(findCli('codex',env)||'codex',['debug','models'],commandOptions(env));cache=JSON.parse(result.stdout);if(!Array.isArray(cache.models))throw Error('missing catalog')}
    catch {stale=true;error='实时 CLI 目录读取失败';source='Codex CLI · models_cache.json（缓存回退）';try{const file=join(paths(env).codex,'models_cache.json');if(statSync(file).size>2*1024*1024)throw Error('too large');cache=JSON.parse(readFileSync(file,'utf8'));updated=cache.fetched_at||null}catch{cache={models:[]};updated=null}}
    const models=(cache.models||[]).filter(m=>m.visibility!=='hide'&&validModel(m.slug)).sort((a,b)=>(a.priority??999)-(b.priority??999)).slice(0,100).map(m=>({id:m.slug,label:String(m.display_name||m.slug).slice(0,100),description:String(m.description||'').slice(0,250)}))
    return {kind,models,source,stale,error,updated_at:updated,status:models.length?(stale?'cached':'live'):'unavailable',note:'来自本机 CLI 的真实目录；不是订阅调用成功证明。自定义 provider 模型还依赖其配置，独立 worker 不继承用户配置。'}
  }
  if(kind==='cli') {
    try {const raw=await readClaude({env});const models=raw.filter(m=>validModel(m.value)).slice(0,100).map(m=>({id:m.value,label:String(m.displayName||m.value).slice(0,100),resolved_model:m.resolvedModel||null,description:String(m.description||'').slice(0,250)}));return {kind,models,source:'Claude CLI · initialize.models',updated_at:fetched,status:models.length?'live':'unavailable',stale:false,note:'CLI 初始化真实选项（无推理）；resolvedModel 显示别名当前指向，不保证账户可调用。'}}
    catch(error){return {kind,models:[],source:'Claude CLI · initialize.models',updated_at:null,status:'unavailable',stale:false,error:error.message,note:'未能读取真实目录；不会用 help 示例或写死的模型冒充。可手动输入。'}}
  }
  throw new Error('Unknown CLI model backend')
}
