import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const hash = value => createHash('sha256').update(value).digest('hex')
const maxFile = 256 * 1024 * 1024
export const home = () => resolve(process.env.SUPERLCM_CLAUDE_HOME || join(homedir(), '.superlcm-claude'))
function ensurePrivate(path) { mkdirSync(path, { recursive: true, mode: 0o700 }) }
function inside(parent, child) { const rel = relative(parent, child); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
export function claudeTranscript(path) {
  const root = realpathSync(resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'))
  const file = realpathSync(path)
  if (!inside(root, file) || !file.endsWith('.jsonl')) throw new Error('transcript_path must be a JSONL file inside the Claude projects directory')
  return file
}
function visible(record) {
  const parts = record?.message?.content ?? record?.content ?? ''
  if (typeof parts === 'string') return parts
  if (!Array.isArray(parts)) return ''
  return parts.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n')
}
function extract(raw, kind) {
  if (kind === 'text') return raw.toString('utf8')
  try {
    const record = JSON.parse(raw.toString('utf8'))
    if (record?.type !== 'user' && record?.type !== 'assistant') return ''
    return `${record.type}: ${visible(record)}`.slice(0, 16000)
  } catch { return '' }
}
function bounded(value, fallback, max) { return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback }
export class ClaudeStore {
  constructor(dir = home()) {
    this.dir = resolve(dir)
    ensurePrivate(this.dir)
    this.db = new DatabaseSync(join(this.dir, 'lcm.sqlite'))
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources(session TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ok');
      CREATE TABLE IF NOT EXISTS events(session TEXT NOT NULL, ordinal INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, digest TEXT NOT NULL, preview TEXT NOT NULL, PRIMARY KEY(session, ordinal));
      CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(session UNINDEXED, ordinal UNINDEXED, preview);
      CREATE TABLE IF NOT EXISTS nodes(session TEXT NOT NULL, id TEXT NOT NULL, level INTEGER NOT NULL, first INTEGER NOT NULL, last INTEGER NOT NULL, children TEXT NOT NULL, summary TEXT NOT NULL, digest TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(session,id));
      CREATE INDEX IF NOT EXISTS nodes_level ON nodes(session,level,first);
      CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(session UNINDEXED, id UNINDEXED, summary);
      CREATE TABLE IF NOT EXISTS leases(session TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);
    `)
  }
  close() { this.db.close() }
  setStatus(session,status) { this.db.prepare('UPDATE sources SET status=? WHERE session=?').run(status,session) }
  sources() { return this.db.prepare('SELECT session,kind,offset,status FROM sources ORDER BY session').all() }
  source(session) { return this.db.prepare('SELECT * FROM sources WHERE session=?').get(session) }
  #verifySource(session, path, kind) {
    if (!session || typeof session !== 'string' || session.length > 200 || !/^[\w.-]+$/.test(session)) throw new Error('Invalid session id')
    const file = realpathSync(path)
    if (!statSync(file).isFile()) throw new Error('Source is not a regular file')
    const prior = this.source(session)
    if (prior && (prior.path !== file || prior.kind !== kind)) throw new Error('Session already bound to a different source; use a distinct session id')
    this.db.prepare('INSERT OR IGNORE INTO sources(session,path,kind) VALUES(?,?,?)').run(session, file, kind)
    return file
  }
  ingest(session, path, kind = 'jsonl') {
    if (!['jsonl','text'].includes(kind)) throw new Error('Unsupported source type')
    const file = this.#verifySource(session, path, kind)
    const src = this.source(session)
    const fd = openSync(file, 'r')
    try {
      const size = fstatSync(fd).size
      if (size > maxFile) throw new Error('Source exceeds 256 MiB per session; split it first')
      const last = this.db.prepare('SELECT * FROM events WHERE session=? ORDER BY ordinal DESC LIMIT 1').get(session)
      if (size < src.offset || (last && this.#readRange(fd, last.start, last.end, size)?.digest !== last.digest)) {
        this.db.prepare("UPDATE sources SET status='changed' WHERE session=?").run(session)
        throw new Error('Source history changed or was truncated; existing pointers may be stale; do not silently rebuild')
      }
      let offset = src.offset, ordinal = last ? last.ordinal + 1 : 0, pending = Buffer.alloc(0), added = 0
      const chunk = Buffer.alloc(64 * 1024)
      while (offset + pending.length < size) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset - pending.length), offset + pending.length)
        if (!n) break
        pending = Buffer.concat([pending, chunk.subarray(0, n)])
        let cut
        while ((cut = pending.indexOf(10)) >= 0) {
          const raw = pending.subarray(0, cut + 1)
          if (raw.length > 4 * 1024 * 1024) throw new Error('Individual JSONL line exceeds 4 MiB')
          if (kind === 'jsonl') { try { JSON.parse(raw.toString('utf8')) } catch { return { session, added, offset, warning: 'Incomplete or invalid JSONL line; waiting for a complete record' } } }
          this.#addEvent(session, ordinal++, offset, offset + raw.length, raw, kind)
          added++; offset += raw.length; pending = pending.subarray(cut + 1)
        }
        if (pending.length > 4 * 1024 * 1024) throw new Error('Individual JSONL line exceeds 4 MiB')
      }
      if (kind === 'text' && pending.length) { this.#addEvent(session,ordinal,offset,offset+pending.length,pending,kind);added++;offset+=pending.length }
      return { session, added, offset, ...(pending.length && kind==='jsonl' ? { warning: 'Trailing partial line not indexed yet' } : {}) }
    } finally { closeSync(fd) }
  }
  #addEvent(session, ordinal, start, end, raw, kind) {
    const preview = extract(raw, kind)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(session, ordinal, start, end, hash(raw), preview)
      this.db.prepare('INSERT INTO event_fts(session,ordinal,preview) VALUES(?,?,?)').run(session, ordinal, preview)
      this.db.prepare("UPDATE sources SET offset=?,status='ok' WHERE session=?").run(end, session)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  #readRange(fd, start, end, size) {
    if (end > size || end < start) return null
    const raw = Buffer.alloc(end - start)
    let got = 0
    while (got < raw.length) { const n = readSync(fd, raw, got, raw.length - got, start + got); if (!n) return null; got += n }
    return { raw, digest: hash(raw) }
  }
  exact(session, ordinal) {
    const event = this.db.prepare('SELECT * FROM events WHERE session=? AND ordinal=?').get(session, ordinal)
    const source = this.source(session)
    if (!event || !source) throw new Error('Unknown source event')
    const fd = openSync(source.path, 'r')
    try {
      const actual = this.#readRange(fd, event.start, event.end, fstatSync(fd).size)
      if (!actual || actual.digest !== event.digest) throw new Error('Raw transcript changed: exact expansion refused')
      return actual.raw.toString('utf8')
    } finally { closeSync(fd) }
  }
  readEvent(session, ordinal, charOffset = 0, maxChars = 12000) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('Invalid event ordinal')
    if (!Number.isSafeInteger(charOffset) || charOffset < 0) throw new Error('Invalid character offset')
    const raw = this.exact(session,ordinal), cap = bounded(maxChars,12000,50000)
    if (charOffset > raw.length) throw new Error('Offset past end of event')
    const content = raw.slice(charOffset,charOffset+cap)
    return {session,ordinal,charOffset,content,next:charOffset+content.length < raw.length ? {ordinal,charOffset:charOffset+content.length} : null}
  }
  eventRows(session) { return this.db.prepare('SELECT ordinal,digest,preview FROM events WHERE session=? ORDER BY ordinal').all(session) }
  nodeRows(session, level) { return this.db.prepare('SELECT * FROM nodes WHERE session=? AND level=? ORDER BY first').all(session, level) }
  node(session, id) { return this.db.prepare('SELECT * FROM nodes WHERE session=? AND id=?').get(session, id) }
  addNode(node) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT OR IGNORE INTO nodes VALUES(?,?,?,?,?,?,?,?,?)').run(node.session,node.id,node.level,node.first,node.last,JSON.stringify(node.children),node.summary,node.digest,node.model)
      if (this.db.prepare('SELECT changes() AS n').get().n) this.db.prepare('INSERT INTO node_fts(session,id,summary) VALUES(?,?,?)').run(node.session,node.id,node.summary)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  lease(session, duration = 120000) {
    const now = Date.now()
    this.db.prepare('INSERT INTO leases(session,until_ms) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET until_ms=excluded.until_ms WHERE leases.until_ms < ?').run(session, now+duration, now)
    return this.db.prepare('SELECT until_ms FROM leases WHERE session=?').get(session)?.until_ms === now+duration
  }
  release(session) { this.db.prepare('UPDATE leases SET until_ms=0 WHERE session=?').run(session) }
  search(session, query, limit = 10) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Provide a query of 1–200 characters')
    const tokens = query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) || []
    if (!tokens.length) return { events: [], nodes: [] }
    const q = tokens.map(t => `"${t.replaceAll('"','""')}"`).join(' OR ')
    const cap = bounded(limit, 10, 50)
    return {
      events: this.db.prepare('SELECT e.session,e.ordinal,substr(e.preview,1,500) AS snippet FROM event_fts f JOIN events e ON e.session=f.session AND e.ordinal=f.ordinal WHERE event_fts MATCH ? AND f.session=? ORDER BY e.ordinal DESC LIMIT ?').all(q,session,cap),
      nodes: this.db.prepare('SELECT n.id,n.level,n.first,n.last,n.summary FROM node_fts f JOIN nodes n ON n.session=f.session AND n.id=f.id WHERE node_fts MATCH ? AND f.session=? ORDER BY n.level DESC,n.first DESC LIMIT ?').all(q,session,cap)
    }
  }
  describe(session, id) {
    const node = this.node(session,id)
    if (!node) throw new Error('Unknown node')
    const parents = this.db.prepare('SELECT id FROM nodes WHERE session=? AND level>? AND first<=? AND last>=? ORDER BY level LIMIT 20').all(session,node.level,node.first,node.last).map(r=>r.id)
    return { ...node, children: JSON.parse(node.children), parents }
  }
  expand(session, id, ordinal, charOffset = 0, maxChars = 12000) {
    const node = this.node(session,id)
    if (!node) throw new Error('Unknown node')
    const first = ordinal === undefined ? node.first : ordinal
    if (!Number.isSafeInteger(first) || first < node.first || first > node.last) throw new Error('Ordinal outside node range')
    if (!Number.isSafeInteger(charOffset) || charOffset < 0) throw new Error('Invalid character offset')
    const cap = bounded(maxChars,12000,50000), chunks = []
    let left = cap
    for (let i = first; i <= node.last && left; i++) {
      const raw = this.exact(session,i)
      const from = i === first ? charOffset : 0
      if (from > raw.length) throw new Error('Offset past end of event')
      const slice = raw.slice(from, from+left)
      chunks.push({ ordinal:i, charOffset:from, content:slice })
      left -= slice.length
      if (from+slice.length < raw.length) return { chunks, next:{ ordinal:i, charOffset:from+slice.length } }
    }
    return { chunks, next: chunks.at(-1)?.ordinal < node.last ? { ordinal:chunks.at(-1).ordinal+1,charOffset:0 } : null }
  }
  overview(session) {
    const nodes = this.db.prepare('SELECT id,level,first,last,substr(summary,1,320) AS summary FROM nodes WHERE session=? ORDER BY level DESC,last DESC LIMIT 5').all(session)
    return { session, nodes, source: this.source(session)?.kind || null }
  }
  doctor(session) {
    const src = this.source(session)
    if (!src) throw new Error('Unknown session')
    const rows = this.db.prepare('SELECT ordinal,start,end,digest FROM events WHERE session=? ORDER BY ordinal').all(session)
    const issues = [], fd = openSync(src.path,'r')
    try {
      const size = fstatSync(fd).size
      for (const row of rows) if (this.#readRange(fd,row.start,row.end,size)?.digest !== row.digest) issues.push(`bad source pointer ${row.ordinal}`)
      if (size < src.offset) issues.push('source truncated')
    } finally { closeSync(fd) }
    const nodes = this.db.prepare('SELECT id,first,last,children FROM nodes WHERE session=?').all(session)
    for (const n of nodes) {
      if (n.first > n.last || n.first < 0 || n.last >= rows.length) issues.push(`bad node range ${n.id}`)
      for (const id of JSON.parse(n.children)) if (typeof id === 'string' && !this.node(session,id)) issues.push(`missing child ${id}`)
    }
    return { session, events:rows.length, nodes:nodes.length, status:src.status, sqlite:this.db.prepare('PRAGMA integrity_check').get().integrity_check, issues }
  }
}
export function importFile(store, path, label) {
  const original = realpathSync(path), st = statSync(original)
  if (!/\.(jsonl|txt)$/i.test(original)) throw new Error('Import requires .jsonl or .txt source')
  if (!st.isFile() || st.size > 32*1024*1024 || !st.size) throw new Error('Import requires a nonempty regular file of at most 32 MiB')
  const raw = readFileSync(original)
  if (raw.includes(0)) throw new Error('Binary imports are not supported')
  new TextDecoder('utf-8',{fatal:true}).decode(raw)
  const digest = hash(raw)
  const isJsonl = original.endsWith('.jsonl')
  if (isJsonl && !raw.toString('utf8').endsWith('\n')) throw new Error('JSONL imports require a final newline')
  const folder = join(store.dir,'imports'); ensurePrivate(folder)
  const dest = join(folder,`${digest}.${isJsonl?'jsonl':'txt'}`)
  if (!existsSync(dest)) writeFileSync(dest,raw,{flag:'wx',mode:0o600})
  else if (hash(readFileSync(dest)) !== digest) throw new Error('Existing imported original was modified; refusing to reuse it')
  const session = label || `desktop-${digest.slice(0,16)}`
  return store.ingest(session,dest,isJsonl?'jsonl':'text')
}
export const nodeId = (session, level, first, last, digest) => `s${level}-${hash(`${session}:${level}:${first}:${last}:${digest}`).slice(0,24)}`
