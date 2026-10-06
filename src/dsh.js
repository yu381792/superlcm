// DSH emits immutable logical events. Its own persistence remains authoritative;
// this append-only mirror gives every SuperLcm client exact, portable recall.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readSync, closeSync, appendFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { syncDshSummaries } from './dsh-summaries.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
// Native persistence adds this default when reading older headers. It does
// not identify a different session; every other identity field stays exact.
const stableHeader = value => JSON.stringify(canonical({ ...value, delegationDepth: value.delegationDepth === undefined ? 0 : value.delegationDepth }))
export function dshSessionKey(id) {
  if (typeof id !== 'string' || !/^[\w.-]{1,190}$/.test(id)) throw Error('Invalid DSH session ID')
  return 'dsh-' + id
}
export function projectDshEvent(id,event,text) {
  const role=event.type==='user/message'?'user':event.type.startsWith('tool/')||['assistant/message','compaction/summary'].includes(event.type)?'assistant':'metadata'
  const content=text.length>16000?text.slice(0,16000)+' …[projection preview; the complete original is in event]':text
  return {role,content,dsh_session:id,event}
}
function checkRecord(record, id) {
  if (record?.dsh_session !== id || !Number.isSafeInteger(record?.event?.seq) || record.event.seq < 0 || typeof record.event.type !== 'string') throw Error('Invalid DSH event')
  if (!['user', 'assistant', 'metadata'].includes(record.role) || typeof record.content !== 'string') throw Error('Invalid DSH event projection')
  return sha(JSON.stringify(canonical(record.event)))
}
function initialize(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS dsh_mirrors(session TEXT PRIMARY KEY,header TEXT NOT NULL,next_seq INTEGER NOT NULL,bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dsh_event_digests(session TEXT NOT NULL,seq INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(session,seq));
    CREATE TABLE IF NOT EXISTS dsh_activity(session TEXT PRIMARY KEY,records INTEGER NOT NULL,time_ms INTEGER NOT NULL);
  `)
}
export function captureDshPacket(store, packet, {clientKind='hook'}={}) {
  const id = packet?.header?.id, session = dshSessionKey(id)
  if (clientKind !== 'import' && !store.integrationEnabled('dsh')) return {session,skipped:'disconnected'}
  if (store.isDeleted(session) && clientKind !== 'import') return { session, skipped: 'deleted' }
  if (!Array.isArray(packet.records) || packet.records.length > 1000) throw Error('DSH capture requires at most 1000 events per batch')
  initialize(store)
  const folder = join(store.dir, 'dsh'); mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = join(folder, sha(id).slice(0, 40) + '.jsonl')
  const header = stableHeader(packet.header)
  const records = packet.records.map(record => ({ record, digest: checkRecord(record, id) }))
  let added = 0
  store.db.exec('BEGIN IMMEDIATE')
  try {
    if(store.isDeleted(session)) {
      for(const table of ['deleted_sessions','dsh_mirrors','dsh_event_digests'])store.db.prepare('DELETE FROM '+table+' WHERE session=?').run(session)
    }
    const saved = store.db.prepare('SELECT * FROM dsh_mirrors WHERE session=?').get(session)
    if (saved && stableHeader(JSON.parse(saved.header)) !== header) throw Error('DSH session identity changed; refusing to mix histories')
    let next = saved?.next_seq ?? 0, bytes = saved?.bytes ?? 0
    const size = existsSync(file) ? statSync(file).size : 0
    if (size < bytes) throw Error('DSH mirror became shorter; original history was not replaced')
    const remember = store.db.prepare('INSERT INTO dsh_event_digests(session,seq,digest) VALUES(?,?,?)')
    // A process can exit after the append but before its SQLite commit. Adopt only
    // complete, contiguous records; a damaged tail refuses further writes.
    if (size > bytes) {
      if (size - bytes > 32e6) throw Error('DSH mirror recovery tail exceeds the capture batch limit')
      const tail = Buffer.alloc(size - bytes), fd = openSync(file, 'r')
      try {
        let read = 0
        while (read < tail.length) { const count = readSync(fd, tail, read, tail.length - read, bytes + read); if (!count) throw Error('DSH mirror changed during recovery'); read += count }
      } finally { closeSync(fd) }
      if (tail.at(-1) !== 10) throw Error('DSH mirror has a partial tail; capture paused')
      for (const line of tail.toString('utf8').trimEnd().split('\n')) {
        const record = JSON.parse(line), digest = checkRecord(record, id)
        if (record.event.seq !== next) throw Error('DSH mirror recovery found a sequence gap')
        remember.run(session, next++, digest)
      }
      bytes = size
    }
    const pending = []
    for (const { record, digest } of records) {
      const seq = record.event.seq
      if (seq < next) {
        const prior = store.db.prepare('SELECT digest FROM dsh_event_digests WHERE session=? AND seq=?').get(session, seq)
        if (!prior || prior.digest !== digest) throw Error('Previously archived DSH event changed')
        continue
      }
      if (seq !== next) throw Error('DSH capture found a sequence gap')
      pending.push(JSON.stringify(record) + '\n')
      remember.run(session, next++, digest); added++
    }
    const text = pending.join('')
    if (pending.some(line => Buffer.byteLength(line) > 4 * 1024 * 1024)) throw Error('DSH event exceeds the archive 4 MiB record limit; capture paused')
    if (Buffer.byteLength(text) > 32e6) throw Error('DSH capture batch exceeds 32 MB; split the batch')
    if (text) { appendFileSync(file, text, { mode: 0o600 }); bytes += Buffer.byteLength(text) }
    store.db.prepare('INSERT INTO dsh_mirrors VALUES(?,?,?,?) ON CONFLICT(session) DO UPDATE SET next_seq=excluded.next_seq,bytes=excluded.bytes').run(session, header, next, bytes)
    store.db.exec('COMMIT')
  } catch (error) { store.db.exec('ROLLBACK'); throw error }
  if (existsSync(file)) {
    store.ingest(session, file)
    // Importing or replaying history is not new conversation activity. Keep
    // the list ordered by the native last event, rather than archive time.
    store.db.exec('BEGIN IMMEDIATE')
    try {
      const count = store.db.prepare('SELECT records FROM session_event_counts WHERE session=?').get(session)?.records ?? 0
      if (count) {
        const last = records.find(item => item.record.event.seq === count - 1)?.record.event
        const saved = store.db.prepare('SELECT records,time_ms FROM dsh_activity WHERE session=?').get(session)
        const time = last?.time ?? (saved?.records === count ? saved.time_ms : JSON.parse(store.exact(session, count - 1)).event?.time)
        if (Number.isFinite(time) && time >= 0) {
          store.db.prepare('INSERT INTO dsh_activity VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET records=excluded.records,time_ms=excluded.time_ms').run(session, count, Math.round(time))
          store.db.prepare('UPDATE sources SET updated_ms=? WHERE session=?').run(Math.round(time), session)
        }
      }
      store.db.exec('COMMIT')
    } catch (error) { store.db.exec('ROLLBACK'); throw error }
    const first = store.db.prepare("SELECT preview FROM events WHERE session=? AND preview LIKE 'user:%' ORDER BY ordinal LIMIT 1").get(session)
    store.setMetadata(session, { harness: 'dsh', externalId: id, name: packet.title || first?.preview.replace(/^user:\s*/, '').slice(0, 100) || id, nameSource: packet.title ? 'native' : 'derived' })
    // Capture preserves the user's independent archive-summary preference.
    syncDshSummaries(store, session, id)
  }
  store.markClient('dsh', clientKind)
  return { session, code: store.source(session) ? store.metadata(session).code : null, added, records: store.source(session) ? store.stats(session).records : 0 }
}
