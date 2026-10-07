import { dshConversations,importDshConversation } from './dsh-history.js'
import { hermesConversations } from './native-snapshots.js'
import { captureHermes } from './hermes.js'
import { capturePi } from './pi.js'
import { readdirSync, statSync, realpathSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { join, relative, isAbsolute, sep, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { maxFile } from './store.js'
import { configFiles } from './harness.js'
import { codexSessionKey } from './codex.js'
import { nativeConversationName, paseoNames } from './conversation-names.js'
const inside=(root,file)=>{const rel=relative(root,file);return rel!== '..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)}
const keyFor=(harness,file)=>createHash('sha256').update(harness+'\0'+file).digest('hex')
function peek(file){const fd=openSync(file,'r');try{const bytes=Buffer.alloc(Math.min(statSync(file).size,512*1024));const n=readSync(fd,bytes,0,bytes.length,0);return bytes.subarray(0,n).toString('utf8').split('\n').slice(0,-1).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})}finally{closeSync(fd)}}
// Enumerate only the known local transcript root. Never follow directory symlinks.
export function localConversations(store,harness,{env=process.env,offset=0,limit=30}={}) {
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('Invalid local conversation page')
  if(harness==='dsh')return dshConversations(store,{env,offset,limit})
  if(harness==='hermes')return hermesConversations(store,{env,offset,limit})
  const root=configFiles(harness,env).transcripts
  if(!existsSync(root))return {harness,root,conversations:[],total:0,next_offset:null,scan_limited:false}
  const canonical=realpathSync(root),files=[];let visited=0,limited=false
  const walk=(dir,depth)=>{if(depth>8){limited=true;return}for(const item of readdirSync(dir,{withFileTypes:true})){if(++visited>20000){limited=true;return}const path=join(dir,item.name);if(item.isSymbolicLink())continue;if(item.isDirectory()){if(item.name==='subagents')continue;walk(path,depth+1)}else if(item.isFile()&&item.name.endsWith('.jsonl')){const st=statSync(path);files.push({path:realpathSync(path),size:st.size,mtime:st.mtimeMs})}}}
  walk(canonical,0);files.sort((a,b)=>b.mtime-a.mtime||a.path.localeCompare(b.path))
  const names=paseoNames(env)
  const conversations=files.slice(offset,offset+limit).map(file=>{
    const records=peek(file.path),meta=records.find(r=>r.type==='session_meta')?.payload
    const id=harness==='codex'?meta?.id:harness==='pi'?records.find(r=>r.type==='session')?.id:(records.find(r=>typeof r.sessionId==='string')?.sessionId||basename(file.path,'.jsonl'))
    const valid=typeof id==='string'&&/^[\w.-]{1,190}$/.test(id)&&inside(canonical,file.path)
    const session=valid?(harness==='codex'?codexSessionKey(id):harness==='pi'?'pi-'+id:id):null
    const first=records.find(r=>r.role==='user'||r.type==='user'||(r.type==='message'&&r.message?.role==='user')||(r.type==='event_msg'&&r.payload?.type==='user_message'))
    const parts=first?.message?.content||first?.content||first?.payload?.message
    const derived=typeof parts==='string'?parts:Array.isArray(parts)?parts.filter(x=>x.type==='text'||x.type==='input_text').map(x=>x.text).join(' '):''
    const native=valid?nativeConversationName(store,{harness,id,file:file.path,records,env,names}):null
    const snapshot=harness==='pi'&&session&&!store.source(session)?store.resolveSession(id,'pi').matches[0]:null
    const known=snapshot?store.source(snapshot.session):session&&store.source(session);const metadata=known?store.metadata(known.session):null
    const conflict=harness!=='pi'&&!!known&&known.path!==file.path
    return {key:keyFor(harness,file.path),harness,session,conversation_id:id||null,name:metadata?.name_source==='manual'?metadata.name:native||metadata?.name||derived?.replace(/\s+/g,' ').trim().slice(0,100)||id||basename(file.path),name_source:metadata?.name_source==='manual'?'manual':native?'native':'derived',path:file.path,bytes:file.size,updated_at:new Date(file.mtime).toISOString(),indexed:!!known,summary_count:known?store.db.prepare('SELECT count(*) AS n FROM nodes WHERE session=?').get(known.session).n:0,import_kind:'live-jsonl',can_index:valid&&!conflict&&file.size<=maxFile,error:!valid?'无法确定对话 ID':conflict?'同 ID 已绑定其他源路径':file.size>maxFile?'超过单会话 4 GiB 限制':null}
  })
  return {harness,root:canonical,conversations,total:files.length,next_offset:offset+limit<files.length?offset+limit:null,scan_limited:limited}
}
export function indexLocalConversation(store,harness,key,{env=process.env}={}) {
  if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid local conversation selection')
  if(harness==='dsh')return importDshConversation(store,key,{env})
  if(harness==='hermes'){
    const {conversations}=hermesByKey(store,key,env)
    const result=captureHermes(store,conversations.conversation_id,{env})
    return {...result,source:store.metadata(result.session),summary_count:store.summaries(result.session).total,note:'已完整收录（含工具记录），之后的新消息会自动追加。未调用模型。'}
  }
  let offset=0,entry
  do {const result=localConversations(store,harness,{env,offset,limit:50});entry=result.conversations.find(x=>x.key===key);if(entry)break;offset=result.next_offset}while(offset!==null)
  if(!entry?.can_index)throw Error(entry?.error||'Conversation is no longer available; rescan before indexing')
  if(harness==='pi'){const result=capturePi(store,{session_id:entry.conversation_id,session_file:entry.path},{env});return {...result,source:store.metadata(result.session),summary_count:store.summaries(result.session).total,note:'已逐字节收录整个对话文件。未调用模型。'}}
  const result=store.ingest(entry.session,entry.path)
  const name=nativeConversationName(store,{harness,id:entry.conversation_id,file:entry.path,env})
  store.setMetadata(entry.session,{harness,externalId:entry.conversation_id,name:name||entry.name,nameSource:name?'native':entry.name_source||'derived'})
  return {...result,source:store.metadata(entry.session),summary_count:store.summaries(entry.session).total,note:'仅索引所选对话；未请求摘要模型。'}
}
function hermesByKey(store,key,env){
  for(let offset=0;offset!==null;){const page=hermesConversations(store,{env,offset,limit:50});const hit=page.conversations.find(x=>x.key===key);if(hit)return {conversations:hit};offset=page.next_offset}
  throw Error('Hermes conversation is no longer available; rescan before importing')
}
