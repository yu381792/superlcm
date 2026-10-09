// Read native generations through DSH's installed persistence provider. Opening
// with read access does not publish migrations, repair logs or acquire writers.
import { existsSync,realpathSync,statSync,readdirSync } from 'node:fs'
import { join,relative,isAbsolute,sep } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { dshHost,dshHome } from './dsh-connection.js'
import { captureDshPacket,dshSessionKey,projectDshEvent } from './dsh.js'
import {readRawDshSession} from '../dsh/raw-session.js'
import {captureLegacyDshSource} from './dsh-legacy.js'
import { maxFile } from './store.js'
import { SuperLcmStore } from '../dsh/store.js'
const keyFor=path=>createHash('sha256').update('dsh\0'+path).digest('hex')
const inside=(root,path)=>{const rel=relative(root,path);return rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)}
function compression(root) {
  for(const project of readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory())) {
    const dir=join(root,project.name)
    for(const session of readdirSync(dir,{withFileTypes:true}).filter(x=>x.isDirectory())) {
      const file=readdirSync(join(dir,session.name),{withFileTypes:true}).find(x=>x.isFile()&&/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(x.name))
      if(file)return file.name.endsWith('.zstd')?'zstd':'none'
    }
  }
  return 'zstd'
}
async function reader(env) {
  const host=dshHost(env),load=name=>import(pathToFileURL(host.require.resolve(name)).href)
  const [{Context},{default:Persistence},{extractSessionEventText}]=await Promise.all([load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-session-persistence-jsonl'),load('@deepseek-ai/dsh-session-query')])
  const ctx=new Context()
  try {return {ctx,persistence:new Persistence(ctx,{root:join(dshHome(env),'sessions'),compression:compression(join(dshHome(env),'sessions'))}),extract:extractSessionEventText}}
  catch(error){await ctx.fiber.dispose();throw error}
}
const rawContext=native=>({sessionPersistence:native.persistence,sessionQuery:{listSessions:async()=>(await native.persistence.listArtifacts()).map(row=>({header:row.header}))}})
async function artifacts(persistence,root) {
  const rows=await persistence.listArtifacts()
  return rows.filter(row=>row.header.origin!=='subagent').map(row=>{
    const path=realpathSync(row.path)
    if(!inside(root,path))throw Error('DSH 会话路径超出本机会话目录')
    const stat=statSync(path)
    return {...row,path,bytes:stat.size,mtime:stat.mtimeMs}
  }).sort((a,b)=>b.mtime-a.mtime||a.path.localeCompare(b.path))
}
export async function dshConversations(store,{env=process.env,offset=0,limit=30}={}) {
  const root=join(dshHome(env),'sessions')
  if(!existsSync(root))return {harness:'dsh',root,conversations:[],total:0,next_offset:null,scan_limited:false}
  const native=await reader(env)
  try {
    const rows=await artifacts(native.persistence,realpathSync(root)),conversations=[]
    for(const row of rows.slice(offset,offset+limit)) {
      const id=row.header.id
      let session=null,error=null
      try{session=dshSessionKey(id)}catch{error='无法确定对话 ID'}
      const known=session&&store.source(session)
      let name=known?store.metadata(session).name:null
      if(row.bytes>maxFile)error='超过单会话 4 GiB 限制'
      if(!error) {
        let handle
        try {
          handle=await readRawDshSession(rawContext(native),id)
          const {events}=handle
          if(!events.length)error='暂无已保存记录'
          const title=events.filter(e=>e.type==='session/title').at(-1)?.data?.title
          const first=events.find(e=>e.type==='user/message')
          name=name||title||(first?native.extract(first).replace(/\s+/g,' ').trim().slice(0,100):null)
        }catch(e){error=e.message}
        finally{await handle?.close()}
      }
      conversations.push({key:keyFor(row.path),harness:'dsh',session,conversation_id:id,name:name||id,path:row.path,bytes:row.bytes,updated_at:new Date(row.mtime).toISOString(),indexed:!!known,summary_count:known?store.summaries(session).total:0,import_kind:'dsh-native',can_index:!error,error})
    }
    return {harness:'dsh',root,conversations,total:rows.length,next_offset:offset+limit<rows.length?offset+limit:null,scan_limited:false}
  }finally{await native.ctx.fiber.dispose()}
}
export async function importDshConversation(store,key,{env=process.env}={}) {
  const root=realpathSync(join(dshHome(env),'sessions')),native=await reader(env)
  let handle,nativeIndex
  try {
    const row=(await artifacts(native.persistence,root)).find(row=>keyFor(row.path)===key)
    if(!row)throw Error('会话已变化，请重新读取列表')
    if(row.bytes>maxFile)throw Error('超过单会话 4 GiB 限制')
    handle=await readRawDshSession(rawContext(native),row.header.id)
    const {events,header}=handle
    if(handle.legacySource){
      const result=await captureLegacyDshSource(store,{path:handle.legacySource.path,currentPath:handle.legacySource.currentPath,compressed:handle.legacySource.compressed,sha256:handle.legacySource.sha256,header},{clientKind:'import'})
      return {...result,source:store.metadata(result.session),summary_count:0,note:'历史原文完整保存，原编号保留，位置按归档顺序读取。此档案仅供原文检索。'}
    }
    if(!events.length)throw Error('暂无已保存记录')
    const title=events.filter(e=>e.type==='session/title').at(-1)?.data?.title
    let records=[],bytes=0,result,added=0
    const flush=()=>{result=captureDshPacket(store,{header,title,records},{clientKind:'import'});added+=result.added;records=[];bytes=0}
    for(const event of events) {
      const record=projectDshEvent(header.id,event,native.extract(event)),size=Buffer.byteLength(JSON.stringify(record))
      if(size>4*1024*1024)throw Error('DSH 单条记录超过 4 MiB 限制')
      if(records.length>=500||bytes+size>24e6)flush()
      records.push(record);bytes+=size
    }
    flush()
    const {reindexSession}=await import('../dsh/core.js')
    nativeIndex=new SuperLcmStore(join(store.dir,'lcm.sqlite'))
    const indexed=reindexSession(nativeIndex,{id:header.id,header,snapshotEvents:()=>events})
    if(indexed.errors.length)throw Error('DSH 原有摘要无法验证：'+indexed.errors[0].error)
    result=captureDshPacket(store,{header,title,records:[]},{clientKind:'import'})
    return {...result,added,source:store.source(result.session)?store.metadata(result.session):null,summary_count:store.summaries(result.session).total,note:'已导入原文和可验证的已有摘要；未调用模型。接入后，新消息继续追加到同一档案。'}
  }finally{nativeIndex?.close();await handle?.close();await native.ctx.fiber.dispose()}
}
