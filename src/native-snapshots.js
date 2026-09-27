// Versioned, immutable visible-message snapshots for native stores that can branch or mutate.
// These snapshots are the exact retained source; never claim byte-exact provenance to a live DB.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { configFiles } from './harness.js'
import { continuationSql } from './hermes.js'
const hash=x=>createHash('sha256').update(x).digest('hex')
const key=(path,id)=>hash('hermes\0'+path+'\0'+id)
const columns=(db,table)=>new Set(db.prepare('PRAGMA table_info('+table+')').all().map(x=>x.name))
function hermesDb(path){const db=new DatabaseSync(path,{readOnly:true});try{const s=columns(db,'sessions'),m=columns(db,'messages');if(!['id','started_at'].every(x=>s.has(x))||!['id','session_id','role','content'].every(x=>m.has(x)))throw Error('Hermes 本机 schema 不兼容；不猜测数据格式');return {db,s,m}}catch(error){db.close();throw error}}
export function hermesConversations(store,{env=process.env,offset=0,limit=30}={}){
 const file=configFiles('hermes',env).transcripts;if(!existsSync(file))return {harness:'hermes',root:file,conversations:[],total:0,next_offset:null}
 const path=realpathSync(file),{db,s}=hermesDb(path)
 try{const name=s.has('display_name')&&s.has('title')?"COALESCE(NULLIF(display_name,''),NULLIF(title,''),id)":s.has('title')?'COALESCE(title,id)':'id';const visible=' c WHERE '+(s.has('hidden')?'COALESCE(c.hidden,0)=0 AND ':'')+"NOT (EXISTS (SELECT 1 FROM sessions p WHERE p.id=c.parent_session_id AND p.end_reason='compression') AND "+continuationSql(db)+')'+(s.has('model_config')?" AND json_extract(CASE WHEN json_valid(c.model_config) THEN c.model_config ELSE '{}' END,'$._delegate_from') IS NULL":'');const total=db.prepare('SELECT count(*) AS n FROM sessions'+visible).get().n
 const rows=db.prepare('SELECT id,'+name+' AS title,started_at FROM sessions'+visible+' ORDER BY started_at DESC,id LIMIT ? OFFSET ?').all(limit,offset)
 return {harness:'hermes',root:path,total,next_offset:offset+rows.length<total?offset+rows.length:null,conversations:rows.map(x=>{const known=[store.source('hermes-'+String(x.id).replace(/[^\w.-]/g,'_').slice(0,180)),...store.resolveSession(x.id,'hermes').matches].filter(Boolean);const summaries=known.reduce((sum,row)=>sum+store.summaries(row.session).total,0);return {key:key(path,x.id),harness:'hermes',conversation_id:x.id,name:x.title,session:known[0]?.session||null,path,bytes:0,updated_at:new Date(Number(x.started_at)*1000).toISOString(),indexed:known.length>0,summary_count:summaries,can_index:true,import_kind:'live-mirror',error:null}})}
 }finally{db.close()}
}
function visibleContent(value){if(typeof value!=='string')return value||'';if(!/^[\[{]/.test(value.trim()))return value;try{const x=JSON.parse(value);return Array.isArray(x)?x:value}catch{return value}}
function plain(content){if(typeof content==='string')return content;if(Array.isArray(content))return content.filter(p=>['text','input_text','output_text'].includes(p?.type)&&typeof p.text==='string').map(p=>p.text).join('\n');return ''}
function persistSnapshot(store,harness,id,title,rows,provenance){
 if(typeof id!=='string'||!id||id.length>200)throw Error('Invalid native conversation ID')
 const lines=rows.filter(x=>['user','assistant'].includes(x.role)).map(x=>({role:x.role,content:plain(x.content),native_id:x.native_id,provenance})).filter(x=>x.content.trim())
 if(!lines.length)throw Error('此对话暂无可见用户/助手文本')
 const raw=lines.map(x=>JSON.stringify(x)).join('\n')+'\n';if(Buffer.byteLength(raw)>32*1024*1024)throw Error('快照超过 32 MiB，请缩小来源')
 const digest=hash(raw),folder=join(store.dir,'native-snapshots');mkdirSync(folder,{recursive:true,mode:0o700});const path=join(folder,digest+'.jsonl')
 if(!existsSync(path))writeFileSync(path,raw,{flag:'wx',mode:0o600});else if(hash(readFileSync(path))!==digest)throw Error('Existing snapshot changed')
 const session=harness+'-'+hash(id).slice(0,16)+'-'+digest.slice(0,16);const result=store.ingest(session,path)
 store.setMetadata(session,{harness,externalId:id,name:title||id,nameSource:'native'})
 return {...result,source:store.metadata(session),summary_count:store.summaries(session).total,import_kind:'snapshot',note:'已保存可见消息的不可变快照；精确展开针对保留快照，不冒充实时原生库。未调用模型。'}
}
export function importHermes(store,selection,{env=process.env}={}){
 const path=realpathSync(configFiles('hermes',env).transcripts),{db,s,m}=hermesDb(path)
 try{db.exec('BEGIN');const row=db.prepare('SELECT id'+(s.has('title')?',title':'')+(s.has('display_name')?',display_name':'')+' FROM sessions').all().find(x=>key(path,x.id)===selection);if(!row)throw Error('Hermes session selection no longer exists')
 const rows=db.prepare("SELECT id,role,content FROM messages WHERE session_id=? AND role IN ('user','assistant')"+(m.has('active')?' AND COALESCE(active,1)=1':'')+' ORDER BY id LIMIT 10001').all(row.id);if(rows.length>10000)throw Error('会话超过 10000 条可见消息，拒绝静默截断')
 return persistSnapshot(store,'hermes',row.id,row.display_name||row.title,rows.map(x=>({role:x.role,content:visibleContent(x.content),native_id:String(x.id)})),{kind:'hermes-visible-snapshot',database:path,session_id:row.id})
 }finally{db.close()}
}
export function importPi(store,entry){
 if(statSync(entry.path).size>32*1024*1024)throw Error('Pi 单次快照文件超过 32 MiB')
 const raw=readFileSync(entry.path,'utf8');const records=raw.split('\n').slice(0,-1).map(line=>JSON.parse(line));const header=records.find(x=>x.type==='session');if(header?.id!==entry.conversation_id)throw Error('Pi source identity changed')
 const entries=records.filter(x=>x.type!=='session'&&x.id),byId=new Map(entries.map(x=>[x.id,x]));if(byId.size!==entries.length)throw Error('Duplicate Pi tree entry ID')
 let current=entries.at(-1);const chain=[],seen=new Set();while(current){if(seen.has(current.id))throw Error('Pi source branch cycle');seen.add(current.id);chain.push(current);if(current.parentId&&!byId.has(current.parentId))throw Error('Pi source branch has missing parent');current=current.parentId?byId.get(current.parentId):null}chain.reverse()
 const title=records.filter(x=>x.type==='session_info').at(-1)?.name||entry.name
 return persistSnapshot(store,'pi',header.id,title,chain.filter(x=>x.type==='message').map(x=>({role:x.message?.role,content:x.message?.content,native_id:x.id})),{kind:'pi-current-branch-snapshot',source:entry.path,session_id:header.id,leaf_id:entries.at(-1)?.id||null})
}
