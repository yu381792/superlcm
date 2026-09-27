import { harnessConnections } from './harness.js'
import { localConversations } from './local-conversations.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore } from './store.js'
import { configFiles, mcpRegistration, matchingMcp, hookInspection, script } from './harness.js'
import { runCommand as run, commandOptions } from './runtime.js'
import { probeMcp } from './mcp-probe.js'
import { codexHookTrust } from './codex-hook-trust.js'
import { hermesHookTrust } from './hermes-config.js'
import { setupPreview, hookCommandFor } from './setup.js'
import { findCli } from './runtime.js'
import { spawn } from 'node:child_process'
// Run a host CLI without a model call and collect its output.
function capture(bin,args,{env,input='',timeoutMs=30000}){return new Promise(resolve=>{let out='';const child=spawn(bin,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true});const timer=setTimeout(()=>{child.kill('SIGTERM');resolve({code:null,out,timeout:true})},timeoutMs);child.stdout.on('data',d=>{out+=d});child.stderr.on('data',d=>{out+=d});child.on('error',error=>{clearTimeout(timer);resolve({code:null,out:error.message})});child.on('close',code=>{clearTimeout(timer);resolve({code,out})});child.stdin.on('error',()=>{});child.stdin.end(input)})}
// Hermes: config written, Hermes itself can connect to the SuperLcm MCP server, and hook consent status.
async function testHermes(store,options){
  const env=options.env||process.env,plan=await setupPreview(store,'hermes',{env})
  const configured=plan.mcp_action==='preserve'&&!plan.hook_events_added.length
  const test=configured?await capture(findCli('hermes',env),['mcp','test','superlcm'],{env}):null
  const tools=Number(test?.out.match(/Tools discovered:\s*(\d+)/)?.[1]||0)
  return {harness:'hermes',checked_at:new Date().toISOString(),configuration:{ok:configured},protocol:{ok:configured&&tools>0,tools,error:!configured?'配置未写入':tools?null:'Hermes 未能连上 SuperLcm 工具'},hook:{trust_check:hermesHookTrust(hookCommandFor(store,'hermes-hook'),env)},note:'由 Hermes 自己连接 SuperLcm（hermes mcp test），未调用模型。'}
}
// Pi: load only the SuperLcm extension in RPC mode and ask it which SuperLcm tools are active. No model call.
async function testPi(store,options){
  const env=options.env||process.env,plan=setupPreview(store,'pi',{env}),p=await plan,file=p.files.mcp
  if(p.mcp_action!=='preserve')return {harness:'pi',configuration:{ok:false},protocol:{ok:false,error:'扩展文件未写入'}}
  const input=[{id:'1',type:'prompt',message:'/superlcm-status'}].map(x=>JSON.stringify(x)).join('\n')+'\n'
  const run=await capture(findCli('pi',env),['--mode','rpc','--no-session','--offline','--no-extensions','--no-context-files','-e',file],{env,input,timeoutMs:40000})
  const tools=(run.out.match(/SuperLcm tools: ([\w,]+)/)?.[1]||'').split(',').filter(x=>x.startsWith('lcm_'))
  return {harness:'pi',checked_at:new Date().toISOString(),configuration:{ok:true},protocol:{ok:tools.length>0,tools:tools.length,error:tools.length?null:'Pi 加载扩展后没有出现 SuperLcm 工具'},note:'以 RPC 模式只加载 SuperLcm 扩展并查询工具，未调用模型。'}
}
export async function testHook(harness,{env=process.env,runCommand=run}={}) {
  configFiles(harness,env)
  const dir=mkdtempSync(join(tmpdir(),'superlcm-hook-check-')),codex=harness==='codex';let fixture
  try {
    const configured={...env,SUPERLCM_HOME:join(dir,'index'),SUPERLCM_CLAUDE_HOME:join(dir,'index'),CODEX_HOME:join(dir,'codex'),CLAUDE_CONFIG_DIR:join(dir,'claude'),SUPERLCM_SUMMARY_MODE:'off'}
    delete configured.SUPERLCM_CLI_WORKER
    const folder=codex?join(configured.CODEX_HOME,'sessions'):join(configured.CLAUDE_CONFIG_DIR,'projects');mkdirSync(folder,{recursive:true})
    const path=join(folder,'diagnostic.jsonl');writeFileSync(path,Array.from({length:8},(_,i)=>JSON.stringify({role:i%2?'assistant':'user',content:'SuperLcm isolated diagnostic '+i})).join('\n')+'\n')
    const response=await hookProcess([script,codex?'codex-hook':'hook'],configured,{session_id:'diagnostic',transcript_path:path,cwd:dir,hook_event_name:'Stop',stop_hook_active:false})
    fixture=new ClaudeStore(configured.SUPERLCM_HOME);const result=fixture.doctor(codex?'codex-diagnostic':'diagnostic')
    return {ok:result.events===8&&result.nodes===0&&result.issues.length===0,events:result.events,nodes:result.nodes,exit_code:response.code,scope:'isolated-hook-to-index',note:'临时目录中执行真实 hook，验证写入原文；未触发用户宿主、未调用模型。'}
  }finally{fixture?.close();rmSync(dir,{recursive:true,force:true})}
}
async function hookProcess(args,env,input) {
  const {spawn}=await import('node:child_process')
  return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true});let out='',settled=false;const timer=setTimeout(()=>{child.kill('SIGTERM');finish(Error('hook 测试超时'))},5000);function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value)}child.on('error',finish);child.stdout.on('data',x=>{out+=x;if(out.length>64000){child.kill('SIGTERM');finish(Error('hook 输出过大'))}});child.stderr.resume();child.stdin.on('error',()=>{});child.on('close',code=>code===0?finish(null,{code,stdout:out}):finish(Error('hook 测试退出码 '+code)));child.stdin.end(JSON.stringify(input))})
}
export async function testHarness(store,harness,options={}) {
  if(harness==='hermes')return testHermes(store,options)
  if(harness==='pi')return testPi(store,options)
  if(!['codex','claude-code'].includes(harness)){const row=(await harnessConnections(store,options)).find(x=>x.harness===harness);if(!row)throw Error('Unknown detected harness');let local;try{const page=row.local_conversations?localConversations(store,harness,{...options,limit:1}):null;local=page?{ok:true,total:page.total}:{ok:false,note:'暂无本地会话 adapter'}}catch(error){local={ok:false,error:error.message}}return {harness,capabilities_only:true,detected:row.detected,version:row.version,local,host_connection:'unverified',note:'仅检查 CLI 和原生会话读取能力；MCP / 自动 hook 接入尚未适配，不宣称已连接。'}}
  const reg=await mcpRegistration(harness,options),matches=matchingMcp(reg,store),hook=hookInspection(harness,options.env)
  const protocol=matches?await probeMcp({env:{...(options.env||process.env),SUPERLCM_HOME:store.dir}}):{ok:false,skipped:true,error:reg.found?'配置不匹配此 SuperLcm 路径 / 索引；未执行未知命令':'未配置 SuperLcm MCP'}
  let adapter;try{adapter=await testHook(harness,options)}catch(error){adapter={ok:false,error:error.message}}
  const trust=harness==='codex'?await codexHookTrust({env:options.env||process.env}):null
  return {harness,checked_at:new Date().toISOString(),configuration:{ok:matches,found:reg.found},protocol,hook:{...hook,adapter,...(trust?{trust_check:trust}:{})},host_connection:'unverified',note:'逐行测试验证配置、stdio 协议、隔离 hook 写入。并非宿主已加载、已信任或模型已调用的证明。'}
}
