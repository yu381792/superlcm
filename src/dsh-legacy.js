// Exact historical snapshots use the normal shared archive and recall tools.
// Original sequences stay inside event; physical positions live outside it.
import {readFile,stat} from 'node:fs/promises'
import {dirname,join,basename} from 'node:path'
import {createHash} from 'node:crypto'
import {decodeLegacyBytes} from '../dsh/legacy-archive.js'
import {captureDshPacket,dshSessionKey,projectDshEvent} from './dsh.js'
import {canonical,mergeDshHeader,legacyDshSource} from './dsh-evidence.js'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const digest=event=>sha(JSON.stringify(canonical(event)))
export async function captureLegacyDshSource(store,source,{clientKind='hook'}={}){
 const session=dshSessionKey(source?.header?.id)
 if(clientKind!=='import'&&!store.integrationEnabled('dsh'))return {session,skipped:'disconnected'}
 if(clientKind!=='import'&&store.isDeleted(session))return {session,skipped:'deleted'}
 if(typeof source.compressed!=='boolean'||!/^session(?:\.v[123])?\.jsonl(?:\.zstd)?$/.test(basename(source.path))||source.path.endsWith('.zstd')!==source.compressed)throw Error('Historical DSH source layout is invalid')
 const current=source.currentPath||join(dirname(source.path),'session.v'+Math.max(4,source.header.version)+'.jsonl'+(source.compressed?'.zstd':''))
 if(dirname(current)!==dirname(source.path)||!/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(basename(current)))throw Error('Current DSH artifact layout is invalid')
 const checkCurrent=async()=>{try{await stat(current);throw Error('Current DSH artifact exists; refusing stale historical fallback')}catch(e){if(e.code!=='ENOENT')throw e}}
 await checkCurrent()
 const before=await stat(source.path,{bigint:true});if(before.size>128n*1024n*1024n)throw Error('Historical DSH source exceeds size limit')
 const bytes=await readFile(source.path),after=await stat(source.path,{bigint:true})
 if(['dev','ino','size','mtimeNs','ctimeNs'].some(k=>before[k]!==after[k])||sha(bytes)!==source.sha256)throw Error('Historical DSH source changed while reading')
 const raw=await decodeLegacyBytes(bytes,source.compressed,{recoverSequence:true})
 if(raw.header.version!==Number(basename(source.path).match(/^session(?:\.v(\d+))?\.jsonl/)?.[1]??0))throw Error('Historical DSH source version does not match its layout')
 mergeDshHeader(source.header,raw.header)
 await checkCurrent()
 const entries=raw.recovery?.entries??raw.events.map(event=>({ordinal:event.seq,sourceRow:null,event})),mode=raw.recovery?'physical-order':'event-sequence'
 // Validate the entire already-archived prefix before saving a marker or writing
 // a new byte. Old normal prefixes are accepted only when their event is exact.
 store.db.exec('CREATE TABLE IF NOT EXISTS dsh_legacy_sources(session TEXT PRIMARY KEY,version INTEGER NOT NULL,sha256 TEXT NOT NULL,bytes BLOB NOT NULL,sequence_mode TEXT NOT NULL,records INTEGER NOT NULL,complete INTEGER NOT NULL)')
 store.db.exec('BEGIN IMMEDIATE')
 try{
  const hasMirrors=!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='dsh_mirrors'").get()
  const saved=hasMirrors?store.db.prepare('SELECT header,next_seq FROM dsh_mirrors WHERE session=?').get(session):null
  if(saved)mergeDshHeader(JSON.parse(saved.header),raw.header)
  if(saved?.next_seq>entries.length)throw Error('Historical DSH source became shorter')
  const prior=hasMirrors?store.db.prepare('SELECT seq,digest FROM dsh_event_digests WHERE session=? ORDER BY seq').all(session):[]
  if(prior.length!==(saved?.next_seq??0))throw Error('Historical DSH saved prefix is incomplete')
  for(const [index,row] of prior.entries())if(row.seq!==index||!entries[row.seq]||digest(entries[row.seq].event)!==row.digest)throw Error('Previously archived DSH event changed')
  const known=legacyDshSource(store.db,session)
  if(known&&(known.sha256!==source.sha256||known.sequence_mode!==mode||known.records!==entries.length))throw Error('Historical DSH source changed; original archive retained')
  store.db.prepare('INSERT INTO dsh_legacy_sources VALUES(?,?,?,?,?,?,0) ON CONFLICT(session) DO NOTHING').run(session,raw.header.version,source.sha256,bytes,mode,entries.length)
  store.db.exec('COMMIT')
 }catch(error){store.db.exec('ROLLBACK');throw error}
 const title=raw.events.filter(event=>event.type==='session/title').at(-1)?.data?.title
 let batch=[],size=0,result,added=0
 const flush=()=>{result=captureDshPacket(store,{header:raw.header,title,records:batch},{clientKind,legacyCapture:true});added+=result.added??0;batch=[];size=0;if(result.skipped)throw Error('Historical DSH capture was disconnected')}
 try{
  for(const entry of entries){
   const event=entry.event,text=JSON.stringify(event.data??{}),record=projectDshEvent(raw.header.id,event,text)
   if(raw.recovery)record.dsh_archive={sequenceMode:mode,ordinal:entry.ordinal,sourceRow:entry.sourceRow,sourceSeq:event.seq}
   const length=Buffer.byteLength(JSON.stringify(record));if(length>32*1024*1024)throw Error('Historical DSH event exceeds 32 MiB historical record limit')
   if(batch.length>=500||size+length>24e6)flush();batch.push(record);size+=length
  }
  flush()
  store.db.prepare('UPDATE dsh_legacy_sources SET complete=1 WHERE session=?').run(session)
  return {...result,added,records:entries.length,historical:true,sequenceMode:mode}
 }catch(error){if(store.source(session))store.setStatus(session,'archive_error');throw error}
}
