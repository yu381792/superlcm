import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { page } from './web-page.js'
import { ClaudeStore } from './store.js'
import { contextPacket } from './context.js'
import { modelCatalog, harnessConnections } from './model-catalog.js'
import { summaryMode } from './mode.js'

const secret=()=>randomBytes(24).toString('hex')
const equal=(a,b)=>typeof a==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b))
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data))}
async function body(req){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>16000)throw new Error('Request body too large');chunks.push(chunk)}const x=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('JSON object required');return x}
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
export async function startWeb({store=new ClaudeStore(),port=0,host='127.0.0.1',token=secret()}={}) {
  if(host!=='127.0.0.1')throw new Error('Web console is loopback-only')
  if(!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('Invalid local Web port')
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1')
      if(req.headers.host!==`127.0.0.1:${server.address()?.port}`)return json(res,403,{error:'Loopback Host required'})
      const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('slcm='))?.slice(5)
      if(url.pathname==='/' && req.method==='GET' && (equal(url.searchParams.get('token'),token)||equal(cookie,token))){
        const nonce=secret();res.writeHead(200,{'Set-Cookie':`slcm=${token}; HttpOnly; SameSite=Strict; Path=/`,'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`});return res.end(page(token,nonce))
      }
      if(!equal(req.headers.authorization?.replace(/^Bearer /,''),token))return json(res,401,{error:'Local console token required'})
      if(req.method==='POST' && req.headers.origin && req.headers.origin!==`http://127.0.0.1:${server.address()?.port}`)return json(res,403,{error:'Cross-origin mutation refused'})
      if(req.method==='GET' && url.pathname==='/api/sessions'){
        const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0)return json(res,400,{error:'Invalid offset'});return json(res,200,store.listSessions(50,offset))
      }
      if(req.method==='GET' && url.pathname==='/api/state')return json(res,200,{deliveries:store.deliveries(),clients:store.clients()})
      if(req.method==='GET' && url.pathname==='/api/settings')return json(res,200,{global:store.globalSetting()||{mode:summaryMode(),model:null,configured:false},harnesses:await harnessConnections(store),settings:store.harnessSettings()})
      if(req.method==='GET' && url.pathname==='/api/models')return json(res,200,await modelCatalog(url.searchParams.get('backend')))
      if(req.method==='GET' && url.pathname==='/api/context')return json(res,200,contextPacket(store,url.searchParams.get('session')))
      if(req.method==='POST' && url.pathname==='/api/deliver'){const x=await body(req);return json(res,200,store.enqueue(x.source,x.target))}
      if(req.method==='POST' && url.pathname==='/api/settings'){const x=await body(req);if(x.scope==='global')return json(res,200,store.setGlobalSetting(x.mode,x.model||null));if(x.scope==='harness'){const known=await harnessConnections(store);if(!known.some(h=>h.harness===x.harness))return json(res,400,{error:'Harness has not been configured or observed'});return json(res,200,x.mode==='inherit'?store.clearHarnessSetting(x.harness):store.setHarnessSetting(x.harness,x.mode,x.model||null))}return json(res,400,{error:'Invalid settings scope'})}
      if(req.method==='POST' && url.pathname==='/api/probe'){await body(req);return json(res,200,await probeMcp({env:{...process.env,SUPERLCM_HOME:store.dir}}))}
      json(res,404,{error:'Unknown console route'})
    }catch(error){json(res,400,{error:error.message})}
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)})
  return {server,token,url:`http://127.0.0.1:${server.address().port}/?token=${token}`,close:()=>new Promise(resolve=>server.close(()=>{store.close();resolve()}))}
}
