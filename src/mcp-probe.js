import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
export function probeMcp({bin=process.execPath,script=fileURLToPath(new URL('./cli.js',import.meta.url)),env=process.env,timeoutMs=5000}={}) {
  return new Promise(resolve=>{
    let child,settled=false,text='',answers=[]
    const finish=x=>{if(settled)return;settled=true;clearTimeout(timer);if(child?.exitCode===null)child.kill('SIGTERM');resolve(x)}
    try{child=spawn(bin,[script,'mcp'],{env,stdio:['pipe','pipe','pipe'],windowsHide:true})}
    catch(error){return resolve({ok:false,error:error.message})}
    const timer=setTimeout(()=>finish({ok:false,error:'MCP protocol test timed out'}),timeoutMs)
    child.on('error',error=>finish({ok:false,error:error.message}))
    child.stderr.resume()
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      text+=chunk;if(text.length>200000)return finish({ok:false,error:'MCP response too large'})
      let index;while((index=text.indexOf('\n'))>=0){const line=text.slice(0,index);text=text.slice(index+1);try{answers.push(JSON.parse(line))}catch{return finish({ok:false,error:'Invalid MCP JSON'})}}
      if(answers.length>=2){const init=answers.find(x=>x.id===1),listed=answers.find(x=>x.id===2);finish(init?.result?.serverInfo?.name==='superlcm' && Array.isArray(listed?.result?.tools)?{ok:true,tool_count:listed.result.tools.length,scope:'local-protocol-only'}:{ok:false,error:'MCP handshake/tool list did not match'})}
    })
    child.stdin.on('error',()=>{})
    child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'web-self-test',version:'1'},capabilities:{}}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n')
  })
}
