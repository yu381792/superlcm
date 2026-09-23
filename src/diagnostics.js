import { harnessConnections } from './harness.js'
import { localConversations } from './local-conversations.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore } from './store.js'
import { configFiles, mcpRegistration, matchingMcp, hookInspection, script } from './harness.js'
import { runCommand as run, commandOptions } from './runtime.js'
import { probeMcp } from './mcp-probe.js'
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
  if(!['codex','claude-code'].includes(harness)){const row=(await harnessConnections(store,options)).find(x=>x.harness===harness);if(!row)throw Error('Unknown detected harness');let local;try{const page=row.local_conversations?localConversations(store,harness,{...options,limit:1}):null;local=page?{ok:true,total:page.total}:{ok:false,note:'暂无本地会话 adapter'}}catch(error){local={ok:false,error:error.message}}return {harness,capabilities_only:true,detected:row.detected,version:row.version,local,host_connection:'unverified',note:'仅检查 CLI 和原生会话读取能力；MCP / 自动 hook 接入尚未适配，不宣称已连接。'}}
  const reg=await mcpRegistration(harness,options),matches=matchingMcp(reg,store),hook=hookInspection(harness,options.env)
  const protocol=matches?await probeMcp({env:{...(options.env||process.env),SUPERLCM_HOME:store.dir}}):{ok:false,skipped:true,error:reg.found?'配置不匹配此 SuperLcm 路径 / 索引；未执行未知命令':'未配置 SuperLcm MCP'}
  let adapter;try{adapter=await testHook(harness,options)}catch(error){adapter={ok:false,error:error.message}}
  return {harness,checked_at:new Date().toISOString(),configuration:{ok:matches,found:reg.found},protocol,hook:{...hook,adapter},host_connection:'unverified',note:'逐行测试验证配置、stdio 协议、隔离 hook 写入。并非宿主已加载、已信任或模型已调用的证明。'}
}
