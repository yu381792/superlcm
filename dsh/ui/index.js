import { readFileSync,writeFileSync,renameSync,mkdirSync } from 'node:fs'
import { join,dirname } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { randomUUID,createHash } from 'node:crypto'
import { ClaudeStore } from '../../src/store.js'
import { controlsPath } from '../../src/dsh-controls.js'
import { readControls } from '../controls-config.js'
import { dshHome,dshHost } from '../../src/dsh-connection.js'
import { uiManifest,linkUi } from '../../src/dsh-ui-install.js'
import {consoleLocation} from '../../src/console-location.js'
export const name='superlcm-settings'
export async function apply(ctx,config={}) {
  const store=new ClaudeStore(config.archiveHome)
  ctx.effect(()=>()=>store.close())
  const summaryState=()=>({archive_only:true,enabled:store.integrationEnabled('dsh'),setting:store.harnessSetting('dsh')||store.globalSetting()||{mode:'off'},
    revision:createHash('sha256').update(JSON.stringify([store.harnessSetting('dsh'),store.globalSetting(),store.integrationRevision('dsh'),store.apiModels()])).digest('hex'),
    models:store.apiModels().map(m=>({id:m.id,label:m.label||m.model,model:m.model})),target_chars:store.tuning().target_chars,target_tokens:store.tuning().target_tokens??null})
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
          if(endpoint==='save')throw Error('请在 SuperLcm 后台设置中修改配置')
          const value={...summaryState(),console:consoleLocation(store)}
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
      store.setIntegrationEnabled('dsh',active)
      // Enabling the bundle resumes archiving, never opt-in compaction.
      if(config.archiveOnly||active){prior=active;return}
      const document=readControls(controlsPath(store));if(!document)return
      store.db.exec('BEGIN IMMEDIATE')
      try {
        const document=readControls(controlsPath(store));document.config.auto=false;document.revision=randomUUID()
        const temp=controlsPath(store)+'.'+randomUUID();writeFileSync(temp,JSON.stringify(document,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,controlsPath(store));store.db.exec('COMMIT');prior=active
      }catch(e){store.db.exec('ROLLBACK');throw e}
    } catch {ctx.logger?.warn?.('SuperLcm 插件开关未能同步，保留原压缩设置')}
  },1000);timer.unref();ctx.effect(()=>()=>clearInterval(timer))
}
