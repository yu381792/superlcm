import {spawn} from 'node:child_process'
// One bounded stdio generation. Dead connections reject new calls immediately.
export function piMcpClient({node,script,home,onDead=()=>{},timeoutMs=30000}){
  const proc=spawn(node,[script,'mcp'],{stdio:['pipe','pipe','ignore'],env:{...process.env,SUPERLCM_HOME:home},windowsHide:true})
  proc.stdout.setEncoding('utf8')
  let alive=true,buffer='',id=0
  const waiting=new Map()
  const die=error=>{if(!alive)return;alive=false;for(const job of [...waiting.values()])job.finish(error);onDead();proc.kill()}
  proc.on('error',die);proc.on('exit',()=>die(Error('SuperLcm MCP server exited')))
  proc.stdin.on('error',die)
  proc.stdout.on('data',chunk=>{
    buffer+=chunk
    if(Buffer.byteLength(buffer)>2*1024*1024){die(Error('SuperLcm MCP response exceeds safe size'));return}
    for(let end;(end=buffer.indexOf('\n'))>=0;){
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1)
      let message;try{message=JSON.parse(line)}catch{continue}
      const job=waiting.get(message.id)
      if(job){
        // Older generated Pi extensions discard the MCP isError flag. Reject
        // tool failures here so Pi records them as failed instead of successful.
        const failed=job.method==='tools/call'&&message.result?.isError===true
        const detail=failed&&Array.isArray(message.result.content)?message.result.content.filter(c=>c?.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n'):''
        job.finish(message.error?Error(message.error.message||'MCP request failed'):failed?Error(detail||'SuperLcm tool call failed'):null,message.result)
      }
    }
  })
  const call=(method,params,signal)=>new Promise((resolve,reject)=>{
    if(!alive||proc.exitCode!==null||proc.signalCode!==null)return reject(Error('SuperLcm MCP server is disconnected'))
    if(signal?.aborted)return reject(signal.reason||Error('MCP request cancelled'))
    const n=++id
    const finish=(error,value)=>{if(!waiting.has(n))return;waiting.delete(n);clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value)}
    const abort=()=>finish(signal.reason||Error('MCP request cancelled'))
    const timer=setTimeout(()=>die(Error('SuperLcm MCP request timed out')),timeoutMs)
    waiting.set(n,{finish,method});signal?.addEventListener('abort',abort,{once:true})
    proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n',error=>{if(error)die(error)})
  })
  return {proc,call,get alive(){return alive},close:()=>die(Error('SuperLcm MCP connection closed')),notify(method,params){if(!alive)throw Error('SuperLcm MCP server is disconnected');proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n')}}
}
