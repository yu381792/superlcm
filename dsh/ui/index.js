import { readFileSync,writeFileSync,renameSync,mkdirSync } from 'node:fs'
import { join,dirname } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { ClaudeStore } from '../../src/store.js'
import { dshCompressionSettings,publicCompressionSettings,saveDshCompression,controlsPath } from '../../src/dsh-controls.js'
import { readControls } from '../controls-config.js'
import { dshHome,dshHost } from '../../src/dsh-connection.js'
import { uiManifest,linkUi } from '../../src/dsh-ui-install.js'
export const name='superlcm-settings'
export async function apply(ctx,config={}) {
  const store=new ClaudeStore(config.archiveHome)
  ctx.effect(()=>()=>store.close())
  // Exact routes use DSH's authenticated /api carrier. Its admission checks
  // run before this handler; no separate server or second credentials store.
  const host=dshHost()
  const {clientRequestSchema}=await import(pathToFileURL(host.require.resolve('@deepseek-ai/dsh-client-connection')).href)
  ctx.inject(['connection'],child=>{
    for(const endpoint of ['read','save'])child.connection.fetch.register({
      path:'/api/superlcm/'+endpoint,methods:['POST'],requestBody:'buffered',
      fetch:async request=>{
        let message
        try {message=clientRequestSchema.parse(await request.json())}
        catch {return new Response('请求格式无效',{status:400})}
        if(message.method!=='superlcm/'+endpoint)return new Response('请求方法无效',{status:400})
        let result
        try {
          request.signal.throwIfAborted()
          const value=endpoint==='read'?publicCompressionSettings(await dshCompressionSettings(store)):
            await saveDshCompression(store,message.payload)
          result={ok:true,value}
        }catch(error){result={ok:false,error:{code:'SUPERLCM_SETTINGS',message:error.message,details:{}}}}
        return Response.json({type:'server-response',rpcId:message.rpcId,result})
      }
    })
  })
  // DSH's bundle toggle is a real control, rather than a stale old package
  // marker. Changing it pauses/resumes global automatic compaction; shutdown
  // and reload keep the saved settings intact.
  const profile=ctx.get('profileContext')?.name
  if(!profile)return
  const manifest=join(dshHome(),'profiles',profile,'package.json')
  // New launch profiles inherit global integration on their first real boot.
  // This is a local registration only, not an npm install or model call.
  const raw=readFileSync(manifest,'utf8'),value=JSON.parse(raw)
  if(!value.dependencies?.superlcm) {
    const stage=dirname(dirname(dirname(fileURLToPath(import.meta.url)))),row={name:profile,dir:dirname(manifest),manifest:raw}
    const backup=join(store.dir,'config-backups','dsh-ui-'+randomUUID());mkdirSync(backup,{recursive:true,mode:0o700});writeFileSync(join(backup,'manifest.before'),raw,{mode:0o600})
    const link=linkUi(row,stage,backup)
    try{const host=dshHost(),ops=await import(pathToFileURL(host.require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href);await ops.saveManifest(row.dir,uiManifest(row,stage))}catch(e){link.restore();throw e}
  }
  const selected=()=>JSON.parse(readFileSync(manifest,'utf8')).dsh?.profile?.bundles?.includes('superlcm')===true
  let prior=selected()
  const timer=setInterval(()=>{
    try {
      const active=selected();if(active===prior)return
      const document=readControls(controlsPath(store));if(!document)return
      store.db.exec('BEGIN IMMEDIATE')
      try {
        const document=readControls(controlsPath(store));document.config.auto=active;document.revision=randomUUID()
        const temp=controlsPath(store)+'.'+randomUUID();writeFileSync(temp,JSON.stringify(document,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,controlsPath(store));store.db.exec('COMMIT');prior=active
      }catch(e){store.db.exec('ROLLBACK');throw e}
    } catch {ctx.logger?.warn?.('SuperLcm 插件开关未能同步，保留原压缩设置')}
  },1000);timer.unref();ctx.effect(()=>()=>clearInterval(timer))
}
