import { contextPacket } from './context.js'
import { validModel } from './runtime.js'
import { summaryMode } from './mode.js'
import { normalizeApiEndpoint } from './api-endpoint.js'
import { readApiKey } from './api-credentials.js'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const hash = value => createHash('sha256').update(value).digest('hex')
const maxFile = 256 * 1024 * 1024
// Preserve the existing index path; both Claude and Codex must point at the same home.
export const home = () => resolve(process.env.SUPERLCM_HOME || process.env.SUPERLCM_CLAUDE_HOME || join(homedir(), '.superlcm-claude'))
function ensurePrivate(path) { mkdirSync(path, { recursive: true, mode: 0o700 }) }
function inside(parent, child) { const rel = relative(parent, child); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
export function claudeTranscript(path) {
  const root = realpathSync(resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'))
  const file = realpathSync(path)
  if (!inside(root, file) || !file.endsWith('.jsonl')) throw new Error('transcript_path must be a JSONL file inside the Claude projects directory')
  return file
}
function visible(record) {
  const parts = record?.message?.content ?? record?.content ?? record?.message ?? ''
  if (typeof parts === 'string') return parts
  if (!Array.isArray(parts)) return ''
  return parts.filter(p => ['text','input_text','output_text'].includes(p?.type) && typeof p.text === 'string').map(p => p.text).join('\n')
}
function extract(raw, kind) {
  if (kind === 'text') return raw.toString('utf8')
  try {
    const record = JSON.parse(raw.toString('utf8'))
    if (record?.type==='custom-title' && typeof record.customTitle==='string') return `custom-title: ${record.customTitle}`.slice(0,16000)
    if (record?.type==='ai-title' && typeof record.aiTitle==='string') return `ai-title: ${record.aiTitle}`.slice(0,16000)
    // Portable JSONL: {role:'user'|'assistant',content:'...'}; Claude Code;
    // and visible Codex rollout messages. Every raw record remains exact on disk.
    let role = record?.role ?? record?.type, item = record
    if (record?.type === 'response_item' && record.payload?.type === 'message') { role=record.payload.role; item=record.payload }
    if (record?.type === 'event_msg') {
      const event=record.payload?.type
      role=event === 'user_message' ? 'user' : event === 'agent_message' ? 'assistant' : null
      item=record.payload
    }
    if (role !== 'user' && role !== 'assistant') return ''
    const text=visible(item).trim()
    return text ? `${role}: ${text}`.slice(0, 16000) : ''
  } catch { return '' }
}
function derivedName(preview) { return typeof preview==='string' ? preview.replace(/^(user|assistant):\s*/,'').replace(/\s+/g,' ').trim().slice(0,90) : '' }
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
      CREATE TABLE IF NOT EXISTS summary_policies(session TEXT PRIMARY KEY REFERENCES sources(session), mode TEXT NOT NULL CHECK(mode IN ('off','cli','api')));
      CREATE TABLE IF NOT EXISTS session_origins(session TEXT PRIMARY KEY REFERENCES sources(session), harness TEXT NOT NULL, external_id TEXT, display_name TEXT, name_source TEXT);
      CREATE TABLE IF NOT EXISTS summary_preferences(session TEXT PRIMARY KEY REFERENCES sources(session), mode TEXT NOT NULL CHECK(mode IN ('auto','off','cli','codex-cli','api','agent')), model TEXT);
      CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT, source_session TEXT NOT NULL REFERENCES sources(session), target_session TEXT NOT NULL REFERENCES sources(session), target_harness TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), issued_at TEXT, CHECK(source_session<>target_session));
      CREATE TABLE IF NOT EXISTS delivery_packets(id INTEGER PRIMARY KEY REFERENCES deliveries(id),content TEXT NOT NULL,source_json TEXT NOT NULL,details_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS deliveries_target ON deliveries(target_harness,target_session,issued_at);
      CREATE TABLE IF NOT EXISTS client_seen(client TEXT NOT NULL, seen_at TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(client,kind));
      CREATE TABLE IF NOT EXISTS global_summary_settings(id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL CHECK(mode IN ('off','cli','codex-cli','api','agent')), model TEXT);
      CREATE TABLE IF NOT EXISTS harness_summary_settings(harness TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('off','cli','codex-cli','api','agent')), model TEXT);
    `)
    const deliveryColumns=new Set(this.db.prepare('PRAGMA table_info(deliveries)').all().map(c=>c.name))
    if(!deliveryColumns.has('issued_via'))this.db.exec('ALTER TABLE deliveries ADD COLUMN issued_via TEXT')
    if(!deliveryColumns.has('delivery_route'))this.db.exec("ALTER TABLE deliveries ADD COLUMN delivery_route TEXT NOT NULL DEFAULT 'hook'")
    // Existing alpha.5 indexes have only (session,harness); preserve every row.
    const columns=new Set(this.db.prepare('PRAGMA table_info(session_origins)').all().map(c=>c.name))
    for (const [column,type] of [['external_id','TEXT'],['display_name','TEXT'],['name_source','TEXT']]) if (!columns.has(column)) this.db.exec(`ALTER TABLE session_origins ADD COLUMN ${column} ${type}`)
    for(const table of ['global_summary_settings','harness_summary_settings']){const names=new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));for(const column of ['api_provider','api_url'])if(!names.has(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)}
  }
  close() { this.db.close() }
  setStatus(session,status) { this.db.prepare('UPDATE sources SET status=? WHERE session=?').run(status,session) }
  setSummaryMode(session,mode) {
    if (!['off','cli','api'].includes(mode) || !this.source(session)) throw new Error('Invalid session summary mode')
    this.db.prepare('INSERT INTO summary_policies(session,mode) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET mode=excluded.mode').run(session,mode)
  }
  summaryMode(session) { return this.db.prepare('SELECT mode FROM summary_policies WHERE session=?').get(session)?.mode || null }
  setPreference(session,mode,model=null) {
    if (!this.source(session) || !['auto','off','cli','codex-cli','api','agent'].includes(mode) || (model!==null && (typeof model!=='string' || !validModel(model)))) throw new Error('Invalid summary preference')
    this.db.prepare('INSERT INTO summary_preferences(session,mode,model) VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET mode=excluded.mode,model=excluded.model').run(session,mode,model)
    return this.preference(session)
  }
  preference(session) {return this.db.prepare('SELECT mode,model FROM summary_preferences WHERE session=?').get(session)||{mode:'auto',model:null}}
  // Legacy conversation preferences remain in SQLite for migration; routing ignores them.
  validateSetting(mode,model,apiProvider=null,apiURL=null) {
    if (!['off','cli','codex-cli','api','agent'].includes(mode) || (model!==null && (typeof model!=='string' || !validModel(model)))) throw new Error('Invalid summary setting or model ID')
    if(mode==='api') {if(!model)throw new Error('Custom API requires an explicit model ID');return {api_provider:apiProvider,api_url:normalizeApiEndpoint(apiProvider,apiURL)}}
    if (['off','agent'].includes(mode) && model!==null) throw new Error('This summary mode does not use a model')
    return {api_provider:null,api_url:null}
  }
  globalSetting() { return this.db.prepare('SELECT mode,model,api_provider,api_url FROM global_summary_settings WHERE id=1').get() || null }
  harnessSetting(harness) {
    if(typeof harness!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(harness))throw new Error('Invalid harness')
    return this.db.prepare('SELECT mode,model,api_provider,api_url FROM harness_summary_settings WHERE harness=?').get(harness) || null
  }
  setGlobalSetting(mode,model=null,apiProvider=null,apiURL=null) {
    const api=this.validateSetting(mode,model,apiProvider,apiURL)
    this.db.prepare('INSERT INTO global_summary_settings(id,mode,model,api_provider,api_url) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,model=excluded.model,api_provider=excluded.api_provider,api_url=excluded.api_url').run(mode,model,api.api_provider,api.api_url)
    return this.globalSetting()
  }
  setHarnessSetting(harness,mode,model=null,apiProvider=null,apiURL=null) {
    this.harnessSetting(harness);const api=this.validateSetting(mode,model,apiProvider,apiURL)
    this.db.prepare('INSERT INTO harness_summary_settings(harness,mode,model,api_provider,api_url) VALUES(?,?,?,?,?) ON CONFLICT(harness) DO UPDATE SET mode=excluded.mode,model=excluded.model,api_provider=excluded.api_provider,api_url=excluded.api_url').run(harness,mode,model,api.api_provider,api.api_url)
    return this.harnessSetting(harness)
  }
  clearHarnessSetting(harness) {this.harnessSetting(harness);this.db.prepare('DELETE FROM harness_summary_settings WHERE harness=?').run(harness);return null}
  harnessSettings() {return this.db.prepare('SELECT harness,mode,model,api_provider,api_url FROM harness_summary_settings ORDER BY harness').all()}
  effectiveSetting(session,env=process.env) {
    const harness=this.metadata(session).harness
    const specific=harness!=='legacy'?this.harnessSetting(harness):null
    const choice=specific||this.globalSetting()
    return choice ? {...choice,scope:specific?'harness':'global',harness} : {mode:summaryMode(env),model:null,api_provider:null,api_url:null,scope:'environment',harness}
  }
  apiCredential(session,env=process.env) {
    const chosen=this.effectiveSetting(session,env)
    if(chosen.mode!=='api')return null
    const scope=chosen.scope==='harness'?'harness:'+chosen.harness:'global'
    return readApiKey(this.dir,scope) || (!chosen.api_url && !chosen.api_provider ? env.SUPERLCM_ANTHROPIC_API_KEY||null : null)
  }
  hasApiCredential(scope){return Boolean(readApiKey(this.dir,scope))}
  enqueue(source,target,route='hook') {
    const from=this.metadata(source),to=this.metadata(target)
    if(source===target)throw Error('Source and target conversations must differ')
    if(!['hook','mcp'].includes(route))throw Error('Unknown delivery route')
    if(route==='hook'&&!['codex','claude-code'].includes(to.harness))throw Error('该目标尚无自动 hook；请选择目标 MCP 领取')
    const packet=contextPacket(this,source)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior=this.db.prepare('SELECT id,delivery_route FROM deliveries WHERE source_session=? AND target_session=? AND issued_at IS NULL').get(source,target)
      if(prior){this.db.exec('COMMIT');return {id:prior.id,source:from,target:to,status:'pending',route:prior.delivery_route,deduplicated:true}}
      const id=Number(this.db.prepare('INSERT INTO deliveries(source_session,target_session,target_harness,delivery_route) VALUES(?,?,?,?)').run(source,target,to.harness,route).lastInsertRowid)
      const {content,source:metadata,...details}=packet
      this.db.prepare('INSERT INTO delivery_packets VALUES(?,?,?,?)').run(id,content,JSON.stringify(metadata),JSON.stringify(details));this.db.exec('COMMIT')
      return {id,source:from,target:to,status:'pending',route,snapshot:true}
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  pendingFor(harness,conversationId,limit=3) {
    const targets=this.db.prepare('SELECT s.session FROM sources s JOIN session_origins o ON s.session=o.session WHERE o.harness=? AND o.external_id=?').all(harness,conversationId)
    if(targets.length!==1)return []
    return this.db.prepare("SELECT id,source_session,target_session FROM deliveries WHERE target_harness=? AND target_session=? AND issued_at IS NULL AND delivery_route='hook' ORDER BY id LIMIT ?").all(harness,targets[0].session,limit)
  }
  deliveryPacket(delivery,{maxChars=4000}={}) {
    const row=this.db.prepare('SELECT * FROM delivery_packets WHERE id=?').get(delivery.id)
    if(!row)return contextPacket(this,delivery.source_session,{maxChars})
    const details=JSON.parse(row.details_json)
    return {...details,source:JSON.parse(row.source_json),content:row.content.slice(0,maxChars),truncated:details.truncated||row.content.length>maxChars,snapshot:true}
  }
  receivePending(target) {
    const destination=this.metadata(target),packets=[]
    this.db.exec('BEGIN IMMEDIATE')
    try{for(const delivery of this.db.prepare('SELECT id,source_session FROM deliveries WHERE target_session=? AND issued_at IS NULL ORDER BY id LIMIT 3').all(target)){
      const packet=this.deliveryPacket(delivery);if(this.markIssued(delivery.id,'mcp'))packets.push({id:delivery.id,...packet})
    }this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}
    return {target:destination,packets,status:packets.length?'mcp_received':'no_pending',note:'MCP 已领取不等于模型已理解或采纳。'}
  }
  markIssued(id,via='hook') {return this.db.prepare("UPDATE deliveries SET issued_at=datetime('now'),issued_via=? WHERE id=? AND issued_at IS NULL").run(via,id).changes===1}
  deliveries(limit=30) {return this.db.prepare('SELECT id,source_session,target_session,target_harness,created_at,issued_at,issued_via,delivery_route FROM deliveries ORDER BY id DESC LIMIT ?').all(limit).map(x=>({...x,source:this.metadata(x.source_session),target:this.metadata(x.target_session),status:x.issued_at?(x.issued_via==='mcp'?'mcp_received':'hook_issued'):'pending'}))}
  markClient(client,kind='mcp') {if(typeof client!=='string'||!client.trim()||client.length>100)return;this.db.prepare("INSERT INTO client_seen(client,seen_at,kind) VALUES(?,datetime('now'),?) ON CONFLICT(client,kind) DO UPDATE SET seen_at=excluded.seen_at").run(client,kind)}
  clients() {return this.db.prepare('SELECT client,seen_at,kind FROM client_seen ORDER BY seen_at DESC LIMIT 30').all()}
  setOrigin(session,harness) {
    if (typeof harness !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(harness) || !this.source(session)) throw new Error('Invalid session harness or unknown session')
    const prior=this.db.prepare('SELECT harness FROM session_origins WHERE session=?').get(session)?.harness
    if (prior && prior!==harness) throw new Error('Session already belongs to a different harness; choose a new session ID')
    this.db.prepare('INSERT OR IGNORE INTO session_origins(session,harness) VALUES(?,?)').run(session,harness)
  }
  setMetadata(session,{harness,externalId,name,nameSource='derived'}) {
    if (typeof externalId!=='string' || !externalId || externalId.length>200) throw new Error('Invalid source conversation ID')
    this.setOrigin(session,harness)
    const old=this.db.prepare('SELECT external_id,display_name,name_source FROM session_origins WHERE session=?').get(session)
    if (old.external_id && old.external_id!==externalId) throw new Error('Source conversation ID changed; use a distinct session ID')
    const rawName=typeof name==='string' ? name : this.eventRows(session).find(e=>e.preview.startsWith('user:'))?.preview.replace(/^user:\s*/,'')
    const title=typeof rawName==='string' ? rawName.replace(/\s+/g,' ').trim().slice(0,160) : ''
    if (title && !['derived','native','manual'].includes(nameSource)) throw new Error('Invalid name provenance')
    const priority={derived:1,native:2,manual:3}
    const replace=title && (!old.display_name || priority[nameSource]>=priority[old.name_source||'derived'])
    this.db.prepare('UPDATE session_origins SET external_id=COALESCE(external_id,?),display_name=?,name_source=? WHERE session=?').run(externalId,replace ? title : old.display_name,replace ? nameSource : old.name_source,session)
  }
  nativeClaudeTitle(session) {
    const rows=this.eventRows(session)
    return (rows.filter(e=>e.preview.startsWith('custom-title: ')).at(-1) || rows.filter(e=>e.preview.startsWith('ai-title: ')).at(-1))?.preview.replace(/^(custom-title|ai-title):\s*/,'') || null
  }
  nameSession(session,name) {
    const origin=this.metadata(session)
    if (typeof name!=='string' || !name.trim() || name.length>160) throw new Error('Name must be 1–160 characters')
    this.setMetadata(session,{harness:origin.harness,externalId:origin.conversation_id,name,nameSource:'manual'})
    return this.metadata(session)
  }
  metadata(session) {
    if (!this.source(session)) throw new Error('Unknown session')
    const row=this.db.prepare('SELECT harness,external_id,display_name,name_source FROM session_origins WHERE session=?').get(session)
    const first=this.db.prepare("SELECT preview FROM events WHERE session=? AND preview<>'' ORDER BY ordinal LIMIT 1").get(session)?.preview
    return {session,harness:row?.harness||'legacy',conversation_id:row?.external_id||session,name:row?.display_name||derivedName(first)||session,name_source:row?.name_source||(first?'derived':'id')}
  }
  sources() { return this.listSessions(2147483647,0).sessions }
  listSessions(limit=20,offset=0,harness) {
    const where=harness ? " WHERE COALESCE(o.harness,'legacy')=?" : ''
    const params=harness ? [harness] : []
    const total=this.db.prepare('SELECT COUNT(*) AS n FROM sources s LEFT JOIN session_origins o ON s.session=o.session'+where).get(...params).n
    const select="SELECT s.session,s.kind,s.offset,s.status,COALESCE(o.harness,'legacy') AS harness,o.external_id AS conversation_id,o.display_name AS name,o.name_source,(SELECT COUNT(*) FROM nodes n WHERE n.session=s.session) AS summary_count,(SELECT substr(e.preview,1,160) FROM events e WHERE e.session=s.session AND e.preview<>'' ORDER BY e.ordinal LIMIT 1) AS first_message FROM sources s LEFT JOIN session_origins o ON s.session=o.session"
    const sessions=this.db.prepare(select+where+' ORDER BY s.session LIMIT ? OFFSET ?').all(...params,limit,offset).map(row=>{const setting=this.effectiveSetting(row.session);return {...row,summary_mode:setting.mode,summary_model:setting.model,conversation_id:row.conversation_id||row.session,name:row.name||derivedName(row.first_message)||row.session,name_source:row.name_source||(row.first_message?'derived':'id')}})
    return {sessions,total,next_offset:offset+sessions.length<total ? offset+sessions.length : null}
  }
  resolveSession(query,harness) {
    if (typeof query!=='string' || !query.trim() || query.length>200) throw new Error('Provide a conversation name or ID of 1–200 characters')
    if (harness!==undefined && (typeof harness!=='string' || !/^[a-z][a-z0-9-]{0,39}$/.test(harness))) throw new Error('Invalid harness filter')
    const ids=this.db.prepare("SELECT s.session FROM sources s LEFT JOIN session_origins o ON s.session=o.session WHERE (s.session=? OR o.external_id=? OR o.display_name=? COLLATE NOCASE)"+(harness ? " AND COALESCE(o.harness,'legacy')=?" : '')+' ORDER BY s.session LIMIT 21').all(query,query,query,...(harness?[harness]:[]))
    return {query,matches:ids.slice(0,20).map(row=>this.metadata(row.session)),ambiguous:ids.length>1,truncated:ids.length>20}
  }
  summaries(session, limit=10, offset=0) {
    const source=this.metadata(session)
    if (!Number.isSafeInteger(limit) || limit<1 || limit>50 || !Number.isSafeInteger(offset) || offset<0) throw new Error('Invalid summary page; limit must be 1–50 and offset nonnegative')
    const total=this.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE session=?').get(session).n
    const rows=this.db.prepare('SELECT id,level,first,last,children,summary,model FROM nodes WHERE session=? ORDER BY level DESC,first ASC,id ASC LIMIT ? OFFSET ?').all(session,limit,offset).map(row=>({...row,children:JSON.parse(row.children)}))
    return {session,source,total,nodes:rows,next_offset:offset+rows.length<total ? offset+rows.length : null}
  }
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
    return {session,source:this.metadata(session),ordinal,charOffset,content,next:charOffset+content.length < raw.length ? {ordinal,charOffset:charOffset+content.length} : null}
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
    const result=this.db.prepare('INSERT INTO leases(session,until_ms) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET until_ms=excluded.until_ms WHERE leases.until_ms < ?').run(session, now+duration, now)
    return result.changes === 1
  }
  release(session) { this.db.prepare('UPDATE leases SET until_ms=0 WHERE session=?').run(session) }
  search(session, query, limit = 10) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Provide a query of 1–200 characters')
    const tokens = query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) || []
    if (!tokens.length) return { source:this.metadata(session),events: [], nodes: [] }
    const q = tokens.map(t => `"${t.replaceAll('"','""')}"`).join(' OR ')
    const cap = bounded(limit, 10, 50)
    return {
      source:this.metadata(session),
      events: this.db.prepare('SELECT e.session,e.ordinal,substr(e.preview,1,500) AS snippet FROM event_fts f JOIN events e ON e.session=f.session AND e.ordinal=f.ordinal WHERE event_fts MATCH ? AND f.session=? ORDER BY e.ordinal DESC LIMIT ?').all(q,session,cap),
      nodes: this.db.prepare('SELECT n.id,n.level,n.first,n.last,n.summary FROM node_fts f JOIN nodes n ON n.session=f.session AND n.id=f.id WHERE node_fts MATCH ? AND f.session=? ORDER BY n.level DESC,n.first DESC LIMIT ?').all(q,session,cap)
    }
  }
  describe(session, id) {
    const node = this.node(session,id)
    if (!node) throw new Error('Unknown node')
    const parents = this.db.prepare('SELECT id FROM nodes WHERE session=? AND level>? AND first<=? AND last>=? ORDER BY level LIMIT 20').all(session,node.level,node.first,node.last).map(r=>r.id)
    return { ...node, source:this.metadata(session), children: JSON.parse(node.children), parents }
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
      if (from+slice.length < raw.length) return { source:this.metadata(session),chunks, next:{ ordinal:i, charOffset:from+slice.length } }
    }
    return { source:this.metadata(session),chunks, next: chunks.at(-1)?.ordinal < node.last ? { ordinal:chunks.at(-1).ordinal+1,charOffset:0 } : null }
  }
  overview(session) {
    const nodes = this.db.prepare('SELECT id,level,first,last,substr(summary,1,320) AS summary FROM nodes WHERE session=? ORDER BY level DESC,last DESC LIMIT 5').all(session)
    return { session, nodes, source:this.metadata(session),kind:this.source(session)?.kind || null }
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
export function importFile(store, path, label, origin = 'import', name) {
  if (typeof origin!=='string' || !/^[a-z][a-z0-9-]{0,39}$/.test(origin)) throw new Error('Invalid harness origin')
  if (label!==undefined && (typeof label!=='string' || label.length>200 || !/^[\w.-]+$/.test(label))) throw new Error('Invalid session ID')
  const original = realpathSync(path), st = statSync(original)
  if (!/\.(jsonl|txt)$/i.test(original)) throw new Error('Import requires .jsonl or .txt source')
  if (!st.isFile() || st.size > 32*1024*1024 || !st.size) throw new Error('Import requires a nonempty regular file of at most 32 MiB')
  const raw = readFileSync(original)
  if (raw.includes(0)) throw new Error('Binary imports are not supported')
  new TextDecoder('utf-8',{fatal:true}).decode(raw)
  const digest = hash(raw)
  const isJsonl = /\.jsonl$/i.test(original)
  if (isJsonl) {
    const content=raw.toString('utf8')
    if (!content.endsWith('\n')) throw new Error('JSONL imports require a final newline')
    let visibleCount=0
    for (const line of content.split('\n').slice(0,-1)) {
      if (Buffer.byteLength(line)>4*1024*1024) throw new Error('Individual JSONL line exceeds 4 MiB')
      try { JSON.parse(line) } catch { throw new Error('Invalid JSONL import; use portable {role,content} records or a UTF-8 .txt export') }
      if (extract(Buffer.from(line), 'jsonl')) visibleCount++
    }
    if (!visibleCount) throw new Error('No visible user/assistant messages in JSONL; export {role,content} records or a UTF-8 .txt file')
  }
  const folder = join(store.dir,'imports'); ensurePrivate(folder)
  const dest = join(folder,`${digest}.${isJsonl?'jsonl':'txt'}`)
  if (!existsSync(dest)) writeFileSync(dest,raw,{flag:'wx',mode:0o600})
  else if (hash(readFileSync(dest)) !== digest) throw new Error('Existing imported original was modified; refusing to reuse it')
  const session = label || `import-${digest.slice(0,16)}`
  const result=store.ingest(session,dest,isJsonl?'jsonl':'text')
  store.setMetadata(session,{harness:origin,externalId:session,name:name||derivedName(store.eventRows(session).find(e=>e.preview.startsWith('user:'))?.preview),nameSource:name?'manual':'derived'})
  return result
}
export const nodeId = (session, level, first, last, digest) => `s${level}-${hash(`${session}:${level}:${first}:${last}:${digest}`).slice(0,24)}`

export const SuperLcmStore = ClaudeStore
