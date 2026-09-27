// Hermes keeps conversations in a SQLite database ($HERMES_HOME/state.db), not in an append-only file.
// SuperLcm mirrors every message row of a conversation (tool rows included) into its own append-only
// JSONL file and indexes that file, so original records stay byte-exact and survive Hermes pruning them.
// A conversation that Hermes split on context compression (a child session whose parent ended with
// end_reason='compression') is kept as one SuperLcm conversation.
import { DatabaseSync } from 'node:sqlite'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { configFiles } from './harness.js'
const hash = x => createHash('sha256').update(x).digest('hex')
const columns = (db, table) => new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(x => x.name))
export const hermesSessionKey = root => 'hermes-' + String(root).replace(/[^\w.-]/g, '_').slice(0, 180)
export function openHermes(env = process.env) {
  const file = configFiles('hermes', env).transcripts
  if (!existsSync(file)) throw new Error('Hermes state.db not found')
  const db = new DatabaseSync(realpathSync(file), { readOnly: true })
  const s = columns(db, 'sessions'), m = columns(db, 'messages')
  if (!['id', 'parent_session_id', 'end_reason'].every(x => s.has(x)) || !['id', 'session_id', 'role', 'content'].every(x => m.has(x))) { db.close(); throw new Error('Unrecognized Hermes database schema') }
  db.exec('PRAGMA busy_timeout=3000')
  return { db, s, m, path: realpathSync(file) }
}
// Hermes' own continuation rule (get_compression_chain): a child of a session that ended with
// 'compression', unless it is a branch, delegated subagent, reset fork or tool-spawned session.
export function continuationSql(db, child = 'c') {
  const cols = columns(db, 'sessions'), marker = key => cols.has('model_config') ? `json_extract(CASE WHEN json_valid(${child}.model_config) THEN ${child}.model_config ELSE '{}' END,'$.${key}') IS NULL` : '1'
  return [marker('_branched_from'), marker('_delegate_from'), marker('_reset_from'), cols.has('source') ? `COALESCE(${child}.source,'')<>'tool'` : '1'].join(' AND ')
}
export function hermesLineage(db, sessionId) {
  const rule = continuationSql(db)
  const parentOf = db.prepare(`SELECT p.id FROM sessions c JOIN sessions p ON p.id=c.parent_session_id WHERE c.id=? AND p.end_reason='compression' AND ${rule}`)
  let root = sessionId
  for (let i = 0; i < 1000; i++) { const p = parentOf.get(root); if (!p) break; root = p.id }
  const children = db.prepare(`SELECT c.id FROM sessions c JOIN sessions p ON p.id=c.parent_session_id WHERE c.parent_session_id=? AND p.end_reason='compression' AND ${rule}`)
  const ids = [root], seen = new Set(ids)
  for (let i = 0; i < ids.length && ids.length < 5000; i++) for (const c of children.all(ids[i])) if (!seen.has(c.id)) { seen.add(c.id); ids.push(c.id) }
  return { root, ids }
}
const init = store => {
  store.db.exec('CREATE TABLE IF NOT EXISTS hermes_mirror(session TEXT PRIMARY KEY, root TEXT NOT NULL, last_id INTEGER NOT NULL)')
  if (!columns(store.db, 'hermes_mirror').has('last_sid')) store.db.exec('ALTER TABLE hermes_mirror ADD COLUMN last_sid TEXT')
}
// Append new Hermes message rows of this conversation to SuperLcm's mirror, then index it.
export function captureHermes(store, sessionId, { env = process.env, automatic = false } = {}) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('Invalid Hermes session id')
  init(store)
  const { db, s } = openHermes(env)
  try {
    if (!db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId)) throw new Error('Unknown Hermes session')
    const { root, ids } = hermesLineage(db, sessionId), session = hermesSessionKey(root)
    if (automatic && store.isDeleted(session)) return { session, skipped: 'deleted' }
    const folder = join(store.dir, 'hermes'); mkdirSync(folder, { recursive: true, mode: 0o700 })
    const file = join(folder, hash(root).slice(0, 40) + '.jsonl')
    const saved = store.db.prepare('SELECT last_id,last_sid FROM hermes_mirror WHERE session=?').get(session)
    let last = saved?.last_id ?? 0, lastSid = saved?.last_sid ?? null
    if (!existsSync(file)) { last = 0; lastSid = null } // a deleted conversation is mirrored again from the start
    else if (last === 0 && readFileSync(file).length) throw new Error('Hermes mirror exists without a checkpoint; refusing to duplicate records')
    const marks = ids.map(() => '?').join(',')
    const rows = db.prepare(`SELECT * FROM messages WHERE session_id IN (${marks}) AND id>? ORDER BY id LIMIT 200001`).all(...ids, last)
    if (rows.length > 200000) throw new Error('Too many new Hermes messages in one pass')
    // Each mirrored row is one record. A row from the next session of the chain is where Hermes compressed
    // the conversation: note that record so later summaries of it are not written from lost context.
    const base = store.source(session) ? store.stats(session).records : 0, compactions = []
    rows.forEach((r, k) => { if (lastSid !== null && r.session_id !== lastSid) compactions.push(base + k); lastSid = r.session_id })
    if (rows.length) {
      appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
      last = rows.at(-1).id
    }
    store.db.prepare('INSERT INTO hermes_mirror(session,root,last_id,last_sid) VALUES(?,?,?,?) ON CONFLICT(session) DO UPDATE SET last_id=excluded.last_id,last_sid=excluded.last_sid').run(session, root, last, lastSid)
    const result = existsSync(file) ? store.ingest(session, file) : { session, added: 0 }
    for (const ordinal of compactions) store.markCompaction(session, ordinal)
    const nameColumn = s.has('display_name') ? "COALESCE(NULLIF(display_name,''),NULLIF(title,''))" : s.has('title') ? "NULLIF(title,'')" : 'NULL'
    const title = db.prepare(`SELECT ${nameColumn} AS name FROM sessions WHERE id IN (${marks}) AND ${nameColumn} IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get(...ids)?.name
    if (store.source(session)) store.setMetadata(session, { harness: 'hermes', externalId: root, name: title || null, nameSource: title ? 'native' : 'derived' })
    return { ...result, session, root, sessions: ids.length, added_rows: rows.length }
  } finally { db.close() }
}
