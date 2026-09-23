import { connectionEvidence } from './connections.js'
import { definitions } from './harness.js'
import { probeClaudeConnection } from './claude-connection.js'
import { localConversations, indexLocalConversation } from './local-conversations.js'
import { testHarness } from './diagnostics.js'
import { setupPreview, publicPreview, applySetup } from './setup.js'
import { probeMcp } from './mcp-probe.js'
export { probeMcp } from './mcp-probe.js'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { page } from './web-page.js'
import { ClaudeStore } from './store.js'
import { contextPacket } from './context.js'
import { modelCatalog, harnessConnections } from './model-catalog.js'
import { summaryMode } from './mode.js'
import { saveApiKey } from './api-credentials.js'

const secret=()=>randomBytes(24).toString('hex')
const equal=(a,b)=>typeof a==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b))
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data))}
async function body(req){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>16000)throw new Error('Request body too large');chunks.push(chunk)}const x=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('JSON object required');return x}
export async function startWeb({store=new ClaudeStore(),port=0,host='127.0.0.1',token=secret(),env=process.env,discovery=harnessConnections,catalog=modelCatalog,claudeProbe=probeClaudeConnection}={}) {
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
        const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0)return json(res,400,{error:'Invalid offset'});return json(res,200,store.listSessions(50,offset,url.searchParams.get('harness')||undefined))
      }
      if(req.method==='GET' && url.pathname==='/api/connections')return json(res,200,{connections:definitions.map(h=>({harness:h.id,evidence:connectionEvidence(store,h.id)}))})
      if(req.method==='GET' && url.pathname==='/api/harnesses')return json(res,200,{harnesses:await discovery(store,{env})})
      if(req.method==='GET' && url.pathname==='/api/local-conversations')return json(res,200,localConversations(store,url.searchParams.get('harness'),{env,offset:Number(url.searchParams.get('offset')||0)}))
      if(req.method==='POST' && url.pathname==='/api/index-local'){const x=await body(req);return json(res,200,indexLocalConversation(store,x.harness,x.key,{env}))}
      if(req.method==='POST' && url.pathname==='/api/connection-check'){const x=await body(req);return json(res,200,x.harness==='claude-code'?await claudeProbe(store,{env}):await testHarness(store,x.harness,{env}))}
      if(req.method==='POST' && url.pathname==='/api/harness-test'){const x=await body(req);return json(res,200,await testHarness(store,x.harness,{env}))}
      if(req.method==='POST' && url.pathname==='/api/setup-preview'){const x=await body(req);return json(res,200,publicPreview(await setupPreview(store,x.harness,{env})))}
      if(req.method==='POST' && url.pathname==='/api/setup-apply'){const x=await body(req);if(x.confirm!==true)throw Error('请先预览并确认安装');return json(res,200,await applySetup(store,x.harness,x.revision,{env}))}
      if(req.method==='GET' && url.pathname==='/api/doctor')return json(res,200,store.doctor(url.searchParams.get('session')))
      if(req.method==='GET' && url.pathname==='/api/summary-nodes')return json(res,200,store.summaries(url.searchParams.get('session'),20,Number(url.searchParams.get('offset')||0)))
      if(req.method==='GET' && url.pathname==='/api/statistics')return json(res,200,{sessions:store.db.prepare('SELECT count(*) AS n FROM sources').get().n,summaries:store.db.prepare('SELECT count(*) AS n FROM nodes').get().n,groups:store.db.prepare("SELECT COALESCE(o.harness,'legacy') AS harness,count(*) AS sessions FROM sources s LEFT JOIN session_origins o ON o.session=s.session GROUP BY harness").all()})
      if(req.method==='GET' && url.pathname==='/api/state')return json(res,200,{deliveries:store.deliveries(),clients:store.clients()})
      if(req.method==='GET' && url.pathname==='/api/settings')return json(res,200,{global:{...(store.globalSetting()||{mode:summaryMode(),model:null,api_provider:null,api_url:null,configured:false}),api_key_configured:store.hasApiCredential('global')},harnesses:await discovery(store,{env}),settings:store.harnessSettings().map(x=>({...x,api_key_configured:store.hasApiCredential('harness:'+x.harness)}))})
      if(req.method==='GET' && url.pathname==='/api/models')return json(res,200,await catalog(url.searchParams.get('backend'),{env}))
      if(req.method==='GET' && url.pathname==='/api/context')return json(res,200,contextPacket(store,url.searchParams.get('session')))
      if(req.method==='POST' && url.pathname==='/api/deliver'){const x=await body(req);return json(res,200,store.enqueue(x.source,x.target,x.route||'hook'))}
      if(req.method==='POST' && url.pathname==='/api/settings'){
        const x=await body(req)
        if(x.scope!=='global'&&x.scope!=='harness')return json(res,400,{error:'Invalid settings scope'})
        if(x.scope==='harness'){const known=await discovery(store,{env});if(!known.some(h=>h.harness===x.harness))return json(res,400,{error:'Harness has not been configured or observed'})}
        if(x.scope==='harness'&&x.mode==='inherit')return json(res,200,store.clearHarnessSetting(x.harness))
        const scope=x.scope==='global'?'global':'harness:'+x.harness
        const model=x.model||null,provider=x.api_provider||null,address=x.api_url||null,key=x.api_key
        store.validateSetting(x.mode,model,provider,address)
        if(x.mode==='api'){
          if(key!==undefined&&typeof key!=='string')throw new Error('API key must be text')
          if(!key&&!store.hasApiCredential(scope))throw new Error('Enter and save an API key for this setting')
          if(key)saveApiKey(store.dir,scope,key)
        }else if(key)throw new Error('API key is accepted only for custom API mode')
        const result=x.scope==='global'?store.setGlobalSetting(x.mode,model,provider,address):store.setHarnessSetting(x.harness,x.mode,model,provider,address)
        return json(res,200,{...result,api_key_configured:store.hasApiCredential(scope)})
      }
      if(req.method==='POST' && url.pathname==='/api/probe'){await body(req);return json(res,200,await probeMcp({env:{...process.env,SUPERLCM_HOME:store.dir}}))}
      json(res,404,{error:'Unknown console route'})
    }catch(error){json(res,400,{error:error.message})}
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)})
  return {server,token,url:`http://127.0.0.1:${server.address().port}/?token=${token}`,close:()=>new Promise(resolve=>server.close(()=>{store.close();resolve()}))}
}
