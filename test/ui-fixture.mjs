import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ClaudeStore} from '../src/store.js'
import {startWeb} from '../src/web.js'
import {modelCatalog} from '../src/model-catalog.js'
import {findCli} from '../src/runtime.js'
import {buildHierarchy} from '../src/summarize.js'
const dir=mkdtempSync(join(tmpdir(),'superlcm-browser-')),store=new ClaudeStore(join(dir,'index'))
const env={...process.env,HOME:dir,USERPROFILE:dir,CODEX_HOME:join(dir,'codex'),CLAUDE_CONFIG_DIR:join(dir,'claude'),SUPERLCM_CODEX_CLI_BIN:findCli('codex'),SUPERLCM_CLAUDE_CLI_BIN:findCli('claude')}
store.setGlobalSetting('off')
store.db.prepare('INSERT OR REPLACE INTO summary_tuning VALUES(1,12000,8,4)').run()
for(const [h,id,name] of [['codex','source','Codex 架构来源'],['claude-code','target','Claude 验证目标'],['codex','fresh','待导入本地记录']]){
 const folder=h==='codex'?join(env.CODEX_HOME,'sessions'):join(env.CLAUDE_CONFIG_DIR,'projects');mkdirSync(folder,{recursive:true});const file=join(folder,id+'.jsonl')
 const header=h==='codex'?{type:'session_meta',payload:{id}}:{type:'custom-title',sessionId:id,customTitle:name}
 writeFileSync(file,[header,...Array.from({length:h==='codex'&&id==='source'?40:15},(_,i)=>({role:i%2?'assistant':'user',content:name+' decision '+i,sessionId:id}))].map(x=>JSON.stringify(x)).join('\n')+'\n')
 if(id==='fresh')continue
 const session=h==='codex'?'codex-'+id:id;store.ingest(session,file);store.setMetadata(session,{harness:h,externalId:id,name,nameSource:'manual'})
 if(id==='source')await buildHierarchy(store,session,{model:'fixture-only',summarize:async()=> 'Fixture: keep each conversation isolated and source-verifiable.'})
}
// Never open a real terminal from the browser test.
const web=await startWeb({store,env,catalog:kind=>modelCatalog(kind),terminal:{spawnProcess:()=>({on(){},unref(){}})}})
console.log(JSON.stringify({url:web.url,dir}));
process.on('SIGTERM',async()=>{await web.close();rmSync(dir,{recursive:true,force:true});process.exit(0)})
