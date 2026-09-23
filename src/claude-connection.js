import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { findCli } from './runtime.js'
import { mcpRegistration, matchingMcp } from './harness.js'
import { subscriptionEnv } from './claude-cli.js'
// Real Claude initialization + mcp_status, not our own standalone server handshake.
// No user message, persisted conversation, tools execution or model inference.
export async function probeClaudeConnection(store,{env=process.env,registration,spawnProcess=spawn,timeoutMs=15000}={}) {
 const reg=registration||await mcpRegistration('claude-code',{env})
 if(!matchingMcp(reg,store))return {ok:false,skipped:true,status:'not_configured',message:'Claude 的 SuperLcm 配置尚未匹配此索引；请先确认接入。'}
 const server={type:'stdio',command:reg.config.command,args:reg.config.args,env:{...reg.config.env,SUPERLCM_HOME:store.dir,SUPERLCM_DIAGNOSTIC:'1'}}
 return new Promise(resolve=>{
  const args=['--print','--input-format','stream-json','--output-format','stream-json','--verbose','--no-session-persistence','--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{superlcm:server}}),'--settings','{"disableAllHooks":true}','--tools','']
  let child,poll,timer,done=false,text='',bytes=0,lastStatus='initializing'
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(poll);child?.stdin.end();if(child?.exitCode===null)child.kill('SIGTERM');resolve({...value,scope:'claude-runtime-probe',existing_session_verified:false})}
  try{child=spawnProcess(findCli('claude',env)||'claude',args,{env:subscriptionEnv(env),cwd:tmpdir(),stdio:['pipe','pipe','pipe'],windowsHide:true})}catch{return finish({ok:false,status:'launch_failed',message:'无法启动 Claude CLI'})}
  const send=(request_id,subtype)=>{if(!done)child.stdin.write(JSON.stringify({type:'control_request',request_id,request:{subtype}})+'\n')}
  timer=setTimeout(()=>finish({ok:false,status:'timeout',message:'Claude 连接验证超时（最后状态：'+lastStatus+'）；检查 CLI 登录状态或服务器路径。'}),timeoutMs)
  child.stdin.on('error',()=>{});child.stderr.resume()
  child.on('error',()=>finish({ok:false,status:'launch_failed',message:'Claude CLI 无法启动'}))
  child.on('close',code=>{if(!done)finish({ok:false,status:'closed',exit_code:code,message:'Claude 未完成 MCP 连接验证便退出'})})
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>2*1024*1024)return finish({ok:false,status:'oversized',message:'Claude 控制响应超限'});text+=chunk;let end
   while((end=text.indexOf('\n'))>=0){const line=text.slice(0,end);text=text.slice(end+1);let item;try{item=JSON.parse(line)}catch{continue}if(item.type!=='control_response')continue;const response=item.response
    if(response?.request_id==='slcm-init'){if(response.subtype!=='success')return finish({ok:false,status:'initialize_failed',message:'Claude 初始化失败，无法读取 MCP 状态'});send('slcm-status','mcp_status')}
    if(response?.request_id==='slcm-status'){if(response.subtype!=='success')return finish({ok:false,status:'unsupported',message:'此 Claude CLI 不支持 mcp_status 控制请求'});const list=response.response?.mcpServers;const target=Array.isArray(list)?list.find(x=>x.name==='superlcm'):null;lastStatus=target?.status||'waiting'
     if(lastStatus==='connected')return finish({ok:true,status:'connected',message:'真实 Claude CLI 已成功加载 SuperLcm；此前打开的会话仍需重载 MCP。',tool_count:Array.isArray(target.tools)?target.tools.length:null})
     if(['failed','disabled','needs-auth'].includes(lastStatus))return finish({ok:false,status:lastStatus,message:'Claude 报告 SuperLcm 状态：'+lastStatus+'；未宣称连接成功。'})
     poll=setTimeout(()=>send('slcm-status','mcp_status'),300)
    }
   }
  })
  send('slcm-init','initialize')
 })
}
