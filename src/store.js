import { validModel } from './runtime.js'
import { summaryMode } from './mode.js'
import { normalizeApiEndpoint, loopbackEndpoint, EFFORTS, validApiModel } from './api-endpoint.js'
import { readApiKey, saveApiKey, removeApiKey } from './api-credentials.js'
import { takeoverDefaults, takeoverLimits } from './compaction.js'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
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
// Indexed text is capped; a cut says so, so summaries and searches know the record goes on.
const PREVIEW_CHARS = 16000
const clip = text => text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)} …[${text.length - PREVIEW_CHARS} more characters; lcm_read has the full record]` : text
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
    if (record?.type === 'message' && record.message?.role) role=record.message.role // Pi session entries
    if (record?.type === 'event_msg') {
      const event=record.payload?.type
      role=event === 'user_message' ? 'user' : event === 'agent_message' ? 'assistant' : null
      item=record.payload
    }
    if (role !== 'user' && role !== 'assistant') return ''
    const text=visible(item).trim()
    return text ? clip(`${role}: ${text}`) : ''
  } catch { return '' }
}
function jsonRecord(raw) { try { return JSON.parse(raw.toString('utf8')) } catch { return null } }
function derivedName(preview) { return typeof preview==='string' ? preview.replace(/^(user|assistant):\s*/,'').replace(/\s+/g,' ').trim().slice(0,90) : '' }
export const shortCode = session => hash(String(session)).slice(0,5)
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
      CREATE TABLE IF NOT EXISTS summary_tuning(id INTEGER PRIMARY KEY CHECK(id=1), target_chars INTEGER NOT NULL, batch_size INTEGER NOT NULL, fanout INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS harness_summary_settings(harness TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('off','cli','codex-cli','api','agent')), model TEXT);
      CREATE TABLE IF NOT EXISTS deleted_sessions(session TEXT PRIMARY KEY, deleted_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS compactions(session TEXT NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY(session,ordinal));
      CREATE TABLE IF NOT EXISTS takeover_settings(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, window INTEGER NOT NULL, previous TEXT);
      CREATE TABLE IF NOT EXISTS takeover_copies(session TEXT PRIMARY KEY, remaining INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS host_writers(session TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);
    `)
    const deliveryColumns=new Set(this.db.prepare('PRAGMA table_info(deliveries)').all().map(c=>c.name))
    if(!new Set(this.db.prepare('PRAGMA table_info(leases)').all().map(c=>c.name)).has('owner'))this.db.exec("ALTER TABLE leases ADD COLUMN owner TEXT NOT NULL DEFAULT ''")
    if(!new Set(this.db.prepare('PRAGMA table_info(takeover_settings)').all().map(c=>c.name)).has('keep_tokens'))this.db.exec('ALTER TABLE takeover_settings ADD COLUMN keep_tokens INTEGER NOT NULL DEFAULT 40000')
    if(!deliveryColumns.has('issued_via'))this.db.exec('ALTER TABLE deliveries ADD COLUMN issued_via TEXT')
    if(!deliveryColumns.has('delivery_route'))this.db.exec("ALTER TABLE deliveries ADD COLUMN delivery_route TEXT NOT NULL DEFAULT 'hook'")
    // Existing alpha.5 indexes have only (session,harness); preserve every row.
    const columns=new Set(this.db.prepare('PRAGMA table_info(session_origins)').all().map(c=>c.name))
    for (const [column,type] of [['external_id','TEXT'],['display_name','TEXT'],['name_source','TEXT']]) if (!columns.has(column)) this.db.exec(`ALTER TABLE session_origins ADD COLUMN ${column} ${type}`)
    const sourceColumns=new Set(this.db.prepare('PRAGMA table_info(sources)').all().map(c=>c.name))
    if(!sourceColumns.has('updated_ms')){
      this.db.exec('ALTER TABLE sources ADD COLUMN updated_ms INTEGER')
      for(const row of this.db.prepare('SELECT session,path FROM sources').all()){let ms=null;try{ms=Math.round(statSync(row.path).mtimeMs)}catch{}this.db.prepare('UPDATE sources SET updated_ms=? WHERE session=?').run(ms,row.session)}
    }
    for(const table of ['global_summary_settings','harness_summary_settings']){const names=new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));for(const column of ['api_provider','api_url'])if(!names.has(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)}
    if(!new Set(this.db.prepare('PRAGMA table_info(harness_summary_settings)').all().map(c=>c.name)).has('api_ref'))this.db.exec('ALTER TABLE harness_summary_settings ADD COLUMN api_ref TEXT')
    // Custom API models are added once in Settings and picked per tool; each keeps its own key ('model:<id>').
    const hadModels=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_models'").get()
    this.db.exec('CREATE TABLE IF NOT EXISTS api_models(id TEXT PRIMARY KEY, provider TEXT, url TEXT, model TEXT NOT NULL, created_ms INTEGER NOT NULL)')
    {const names=new Set(this.db.prepare('PRAGMA table_info(api_models)').all().map(c=>c.name));for(const column of ['label','effort'])if(!names.has(column))this.db.exec(`ALTER TABLE api_models ADD COLUMN ${column} TEXT`)}
    if(!hadModels){
      // Earlier versions kept the endpoint on the global or a tool's setting; turn each into an added model.
      const adopt=(choice,scope)=>{
        let m=this.apiModels().find(y=>y.provider===choice.api_provider&&y.url===choice.api_url&&y.model===choice.model)
        if(!m){m={id:randomBytes(4).toString('hex'),provider:choice.api_provider,url:choice.api_url,model:choice.model};this.db.prepare('INSERT INTO api_models(id,provider,url,model,created_ms) VALUES(?,?,?,?,?)').run(m.id,m.provider,m.url,m.model,Date.now())}
        try{const key=readApiKey(this.dir,scope);if(key&&!readApiKey(this.dir,'model:'+m.id))saveApiKey(this.dir,'model:'+m.id,key)}catch{}
        return m.id
      }
      const g=this.globalSetting();if(g?.mode==='api'&&g.model)adopt(g,'global')
      for(const x of this.db.prepare("SELECT harness,mode,model,api_provider,api_url FROM harness_summary_settings WHERE mode='api' AND api_ref IS NULL").all())if(x.model)this.db.prepare('UPDATE harness_summary_settings SET api_ref=? WHERE harness=?').run(adopt(x,'harness:'+x.harness),x.harness)
    }
    // v1: background writing is "the conversation's own tool" ('cli'), no longer a chosen Claude or Codex CLI.
    // A model picked for one CLI moves to that tool's own setting; anywhere else it no longer applies.
    if(this.db.prepare('PRAGMA user_version').get().user_version<1){
      this.db.exec('BEGIN')
      const owner={cli:'claude-code','codex-cli':'codex'},g=this.globalSetting()
      if(owner[g?.mode]&&g.model)this.db.prepare("INSERT OR IGNORE INTO harness_summary_settings(harness,mode,model) VALUES(?,'cli',?)").run(owner[g.mode],g.model)
      this.db.exec("UPDATE global_summary_settings SET mode='cli',model=NULL WHERE mode IN ('cli','codex-cli')")
      for(const x of this.harnessSettings())if(owner[x.mode])this.db.prepare("UPDATE harness_summary_settings SET mode='cli',model=? WHERE harness=?").run(owner[x.mode]===x.harness?x.model:null,x.harness)
      this.db.exec('PRAGMA user_version=1');this.db.exec('COMMIT')
    }
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
    if (!['off','cli','api','agent'].includes(mode) || (model!==null && (typeof model!=='string' || !(mode==='api'?validApiModel(model):validModel(model))))) throw new Error('Invalid summary setting or model ID')
    if(mode==='api') {if(!model)throw new Error('Custom API requires an explicit model ID');return {api_provider:apiProvider,api_url:normalizeApiEndpoint(apiProvider,apiURL)}}
    if (['off','agent'].includes(mode) && model!==null) throw new Error('This summary mode does not use a model')
    return {api_provider:null,api_url:null}
  }
  // Granularity applies to batches planned from now on; saved nodes keep their original ranges.
  tuning() { return this.db.prepare('SELECT target_chars,batch_size,fanout FROM summary_tuning WHERE id=1').get() || {target_chars:12000,batch_size:32,fanout:4} }
  setTuning({target_chars,batch_size=this.tuning().batch_size,fanout}) {
    const within=(n,lo,hi)=>Number.isSafeInteger(n)&&n>=lo&&n<=hi
    if (!within(target_chars,2000,48000) || !within(batch_size,2,64) || !within(fanout,2,8)) throw new Error('Unsupported summary granularity')
    this.db.prepare('INSERT INTO summary_tuning(id,target_chars,batch_size,fanout) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET target_chars=excluded.target_chars,batch_size=excluded.batch_size,fanout=excluded.fanout').run(target_chars,batch_size,fanout)
    return this.tuning()
  }
  // Where the host tool last compacted this conversation: records from this ordinal on were seen by the
  // AI after that compaction, so it can still summarize them from memory.
  // 接管压缩: off by default; window is the auto-compact window SuperLcm sets in Claude Code while on.
  // previous holds Claude Code's own values from before as JSON: {window, env} (older rows: the window alone).
  // 本工具后台写 inside Claude Code itself (hooks/compact-mod.js): while a session's own Claude Code writes its
  // summaries, the Stop hook does not start a separate `claude -p` for it.
  hostWriter(session) { return Boolean(this.db.prepare('SELECT 1 FROM host_writers WHERE session=? AND until_ms>?').get(session,Date.now())) }
  setHostWriter(session,on,duration=6*3600000) { if(on)this.db.prepare('INSERT INTO host_writers(session,until_ms) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET until_ms=excluded.until_ms').run(session,Date.now()+duration); else this.db.prepare('DELETE FROM host_writers WHERE session=?').run(session) }
  takeover() { const r=this.db.prepare('SELECT enabled,window,previous,keep_tokens FROM takeover_settings WHERE id=1').get(); return r?{enabled:Boolean(r.enabled),window:r.window,keep:r.keep_tokens,previous:r.previous}:{...takeoverDefaults,previous:null} }
  setTakeover({enabled,window=this.takeover().window,keep=this.takeover().keep,previous=this.takeover().previous}) {
    if (typeof enabled!=='boolean' || !Number.isSafeInteger(window) || window<takeoverLimits.window[0] || window>takeoverLimits.window[1] || !Number.isSafeInteger(keep) || keep<takeoverLimits.keep[0] || keep>takeoverLimits.keep[1]) throw new Error('Unsupported compaction takeover setting')
    this.db.prepare('INSERT INTO takeover_settings(id,enabled,window,previous,keep_tokens) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,window=excluded.window,previous=excluded.previous,keep_tokens=excluded.keep_tokens').run(enabled?1:0,window,previous,keep)
    return this.takeover()
  }
  markCompaction(session,ordinal=this.stats(session).records) { if(this.source(session))this.db.prepare('INSERT OR IGNORE INTO compactions(session,ordinal) VALUES(?,?)').run(session,ordinal) }
  lastCompaction(session) { return this.db.prepare('SELECT MAX(ordinal) AS o FROM compactions WHERE session=?').get(session)?.o ?? 0 }
  globalSetting() { return this.db.prepare('SELECT mode,model,api_provider,api_url FROM global_summary_settings WHERE id=1').get() || null }
  // A tool on an added API model reads that model's current endpoint, so editing it in Settings applies everywhere.
  static SETTING="SELECT h.harness,h.mode,CASE WHEN m.id IS NULL THEN h.model ELSE m.model END AS model,COALESCE(m.provider,h.api_provider) AS api_provider,COALESCE(m.url,h.api_url) AS api_url,h.api_ref,m.effort AS api_effort FROM harness_summary_settings h LEFT JOIN api_models m ON m.id=h.api_ref"
  harnessSetting(harness) {
    if(typeof harness!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(harness))throw new Error('Invalid harness')
    const x=this.db.prepare(ClaudeStore.SETTING+' WHERE h.harness=?').get(harness);if(!x)return null
    const {harness:_,...rest}=x;return rest
  }
  apiModels() {return this.db.prepare('SELECT id,label,provider,url,model,effort FROM api_models ORDER BY created_ms,id').all()}
  apiModel(id) {return typeof id==='string'?this.db.prepare('SELECT id,label,provider,url,model,effort FROM api_models WHERE id=?').get(id)||null:null}
  // Checks a model entry without saving it; returns the normalized fields.
  checkApiModel({provider=null,url=null,model,label=null,effort=null}) {
    const api=this.validateSetting('api',model||null,provider,url)
    if(effort!==null&&!EFFORTS.includes(effort))throw new Error('Unknown reasoning effort')
    if(label!==null&&(typeof label!=='string'||label.length>60||/[\u0000-\u001f]/.test(label)))throw new Error('Name must be up to 60 characters')
    return {provider:api.api_provider,url:api.api_url,model,label:label?.trim()||null,effort}
  }
  saveApiModel({id=null,...fields}) {
    const m=this.checkApiModel(fields)
    if(id!==null&&!this.apiModel(id))throw new Error('Unknown API model')
    // The same model may be added again with another 思考程度.
    if(this.apiModels().some(y=>y.id!==id&&y.provider===m.provider&&y.url===m.url&&y.model===m.model&&y.effort===m.effort))throw new Error('This model is already added with the same reasoning effort')
    if(id)this.db.prepare('UPDATE api_models SET label=?,provider=?,url=?,model=?,effort=? WHERE id=?').run(m.label,m.provider,m.url,m.model,m.effort,id)
    else {id=randomBytes(4).toString('hex');this.db.prepare('INSERT INTO api_models(id,label,provider,url,model,effort,created_ms) VALUES(?,?,?,?,?,?,?)').run(id,m.label,m.provider,m.url,m.model,m.effort,Date.now())}
    return this.apiModel(id)
  }
  deleteApiModel(id) {
    if(!this.apiModel(id))throw new Error('Unknown API model')
    const users=this.db.prepare('SELECT harness FROM harness_summary_settings WHERE api_ref=?').all(id).map(x=>x.harness)
    if(users.length)throw new Error('Still used by '+users.join(', ')+'; pick another method for it first')
    this.db.prepare('DELETE FROM api_models WHERE id=?').run(id);removeApiKey(this.dir,'model:'+id)
    return true
  }
  setGlobalSetting(mode,model=null,apiProvider=null,apiURL=null) {
    const api=this.validateSetting(mode,model,apiProvider,apiURL)
    this.db.prepare('INSERT INTO global_summary_settings(id,mode,model,api_provider,api_url) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,model=excluded.model,api_provider=excluded.api_provider,api_url=excluded.api_url').run(mode,model,api.api_provider,api.api_url)
    return this.globalSetting()
  }
  setHarnessSetting(harness,mode,model=null,apiProvider=null,apiURL=null,apiRef=null) {
    this.harnessSetting(harness)
    if(apiRef!==null){const m=this.apiModel(apiRef);if(mode!=='api'||!m)throw new Error('Unknown API model');[model,apiProvider,apiURL]=[m.model,m.provider,m.url]}
    const api=this.validateSetting(mode,model,apiProvider,apiURL)
    this.db.prepare('INSERT INTO harness_summary_settings(harness,mode,model,api_provider,api_url,api_ref) VALUES(?,?,?,?,?,?) ON CONFLICT(harness) DO UPDATE SET mode=excluded.mode,model=excluded.model,api_provider=excluded.api_provider,api_url=excluded.api_url,api_ref=excluded.api_ref').run(harness,mode,model,api.api_provider,api.api_url,apiRef)
    return this.harnessSetting(harness)
  }
  // Where a tool's API key lives: its added model's, else (older settings) its own.
  harnessKeyScope(harness,setting=this.harnessSetting(harness)) {return setting?.api_ref?'model:'+setting.api_ref:'harness:'+harness}
  clearHarnessSetting(harness) {this.harnessSetting(harness);this.db.prepare('DELETE FROM harness_summary_settings WHERE harness=?').run(harness);return null}
  harnessSettings() {return this.db.prepare(ClaudeStore.SETTING+' ORDER BY h.harness').all()}
  effectiveSetting(session,env=process.env) {
    const harness=this.metadata(session).harness
    const specific=harness!=='legacy'?this.harnessSetting(harness):null
    const choice=specific||this.globalSetting()
    const r=choice ? {...choice,scope:specific?'harness':'global',harness} : {mode:summaryMode(env),model:null,api_provider:null,api_url:null,scope:'environment',harness}
    // A model belongs to one tool's CLI, so only a tool's own setting (or the environment) names one.
    if(r.mode==='codex-cli')r.mode='cli'
    if(r.mode==='cli'&&r.scope==='global')r.model=null
    return r
  }
  apiCredential(session,env=process.env) {
    const chosen=this.effectiveSetting(session,env)
    if(chosen.mode!=='api')return null
    const scope=chosen.scope==='harness'?this.harnessKeyScope(chosen.harness,chosen):'global'
    // '' = no key needed (a local gateway); null = not configured.
    return readApiKey(this.dir,scope) || (!chosen.api_url && !chosen.api_provider ? env.SUPERLCM_ANTHROPIC_API_KEY||null : null) || (loopbackEndpoint(chosen.api_url) ? '' : null)
  }
  // A saved custom API (this conversation's tool first, then global) usable for a one-off catch-up in any mode.
  apiConfig(session,env=process.env) {
    const harness=this.metadata(session).harness
    const own=harness!=='legacy'?this.harnessSetting(harness):null
    for (const [scope,choice] of [[this.harnessKeyScope(harness,own),own],['global',this.globalSetting()]]) {
      if (choice?.mode!=='api') continue
      const apiKey=readApiKey(this.dir,scope) || (scope==='global' && !choice.api_url && !choice.api_provider ? env.SUPERLCM_ANTHROPIC_API_KEY||null : null) || (loopbackEndpoint(choice.api_url) ? '' : null)
      if (apiKey!==null) return {model:choice.model,api_provider:choice.api_provider,api_url:choice.api_url,effort:choice.api_effort||null,apiKey}
    }
    return null
  }
  hasApiCredential(scope){return Boolean(readApiKey(this.dir,scope))}
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
    return {session,code:shortCode(session),harness:row?.harness||'legacy',conversation_id:row?.external_id||session,name:row?.display_name||derivedName(first)||session,name_source:row?.name_source||(first?'derived':'id')}
  }
  sources() { return this.listSessions(2147483647,0).sessions }
  listSessions(limit=20,offset=0,harness) {
    const where=harness ? " WHERE COALESCE(o.harness,'legacy')=?" : ''
    const params=harness ? [harness] : []
    const total=this.db.prepare('SELECT COUNT(*) AS n FROM sources s LEFT JOIN session_origins o ON s.session=o.session'+where).get(...params).n
    const select="SELECT s.session,s.kind,s.offset,s.status,s.updated_ms,COALESCE(o.harness,'legacy') AS harness,o.external_id AS conversation_id,o.display_name AS name,o.name_source,(SELECT COUNT(*) FROM nodes n WHERE n.session=s.session) AS summary_count,(SELECT COUNT(*) FROM events e WHERE e.session=s.session) AS records,(SELECT COALESCE(MAX(n.last)+1,0) FROM nodes n WHERE n.session=s.session) AS summarized_to,(SELECT COALESCE(MAX(n.level)+1,0) FROM nodes n WHERE n.session=s.session) AS levels,(SELECT substr(e.preview,1,160) FROM events e WHERE e.session=s.session AND e.preview<>'' ORDER BY e.ordinal LIMIT 1) AS first_message FROM sources s LEFT JOIN session_origins o ON s.session=o.session"
    const sessions=this.db.prepare(select+where+' ORDER BY s.updated_ms IS NULL, s.updated_ms DESC, s.session LIMIT ? OFFSET ?').all(...params,limit,offset).map(row=>{const setting=this.effectiveSetting(row.session);return {...row,code:shortCode(row.session),summary_mode:setting.mode,summary_model:setting.model,conversation_id:row.conversation_id||row.session,name:row.name||derivedName(row.first_message)||row.session,name_source:row.name_source||(row.first_message?'derived':'id')}})
    return {sessions,total,next_offset:offset+sessions.length<total ? offset+sessions.length : null}
  }
  resolveSession(query,harness) {
    if (typeof query!=='string' || !query.trim() || query.length>200) throw new Error('Provide a conversation name or ID of 1–200 characters')
    if (harness!==undefined && (typeof harness!=='string' || !/^[a-z][a-z0-9-]{0,39}$/.test(harness))) throw new Error('Invalid harness filter')
    const ids=this.db.prepare("SELECT s.session FROM sources s LEFT JOIN session_origins o ON s.session=o.session WHERE (s.session=? OR o.external_id=? OR o.display_name=? COLLATE NOCASE)"+(harness ? " AND COALESCE(o.harness,'legacy')=?" : '')+' ORDER BY s.session LIMIT 21').all(query,query,query,...(harness?[harness]:[]))
    return {query,matches:ids.slice(0,20).map(row=>this.metadata(row.session)),ambiguous:ids.length>1,truncated:ids.length>20}
  }
  // Accepts #code, code, internal/source ID or name. Exact identity wins over partial names.
  resolve(query) {
    if (typeof query!=='string' || !query.trim() || query.length>200) throw new Error('Provide a conversation code, ID or name')
    const q=query.trim().replace(/^#/,'')
    const all=this.db.prepare('SELECT s.session,o.external_id,o.display_name FROM sources s LEFT JOIN session_origins o ON s.session=o.session').all()
    const exact=all.filter(r=>shortCode(r.session)===q.toLowerCase()||r.session===q||r.external_id===q||(r.display_name||'').toLowerCase()===q.toLowerCase())
    const rows=exact.length?exact:all.filter(r=>(r.display_name||this.metadata(r.session).name).toLowerCase().includes(q.toLowerCase()))
    return rows.slice(0,20).map(r=>this.metadata(r.session))
  }
  resolveOne(query) {
    const matches=this.resolve(query)
    if(matches.length===1) return matches[0].session
    if(!matches.length) throw new Error(`No conversation matches "${query}". Use lcm_find to list conversations.`)
    throw new Error(`"${query}" matches ${matches.length} conversations: `+matches.slice(0,8).map(m=>`#${m.code} ${m.name} (${m.harness})`).join('; ')+'. Retry with a #code.')
  }
  stats(session) {
    return this.db.prepare('SELECT (SELECT COUNT(*) FROM events WHERE session=?) AS records,(SELECT COALESCE(MAX(last)+1,0) FROM nodes WHERE session=?) AS summarized_to,(SELECT COUNT(*) FROM nodes WHERE session=?) AS summary_count,(SELECT COALESCE(MAX(level)+1,0) FROM nodes WHERE session=?) AS levels,(SELECT updated_ms FROM sources WHERE session=?) AS updated_ms').get(session,session,session,session,session)
  }
  // Roots of the summary forest in time order: the shortest outline that covers everything summarized.
  roots(session) {
    const nodes=this.db.prepare('SELECT id,level,first,last,children,summary FROM nodes WHERE session=? ORDER BY first,level DESC').all(session)
    const owned=new Set(nodes.flatMap(n=>JSON.parse(n.children)))
    return nodes.filter(n=>!owned.has(n.id)).map(n=>({...n,children:JSON.parse(n.children)}))
  }
  outline(session, nodeId) {
    const source=this.metadata(session), stats=this.stats(session)
    const tail=stats.summarized_to<stats.records?{from:stats.summarized_to,to:stats.records-1}:null
    if(!nodeId) return {source,...stats,nodes:this.roots(session),unsummarized:tail}
    const node=this.node(session,nodeId)
    if(!node) throw new Error('Unknown summary node')
    const children=JSON.parse(node.children)
    if(children.length) return {source,node:{...node,children},nodes:children.map(id=>this.node(session,id)).filter(Boolean).map(n=>({...n,children:JSON.parse(n.children)}))}
    const events=this.db.prepare("SELECT ordinal,substr(preview,1,400) AS preview FROM events WHERE session=? AND ordinal BETWEEN ? AND ? AND preview<>'' ORDER BY ordinal").all(session,node.first,node.last)
    return {source,node:{...node,children},events}
  }
  // Exact raw events by ordinal range, verified against the original file.
  readRange(session, from, to=from, charOffset=0, maxChars=12000) {
    if (!Number.isSafeInteger(from) || from<0 || !Number.isSafeInteger(to) || to<from) throw new Error('Invalid ordinal range')
    if (!Number.isSafeInteger(charOffset) || charOffset<0) throw new Error('Invalid character offset')
    const records=this.stats(session).records
    if (from>=records) throw new Error(`Ordinal ${from} is past the last record (${records-1})`)
    const last=Math.min(to,records-1), cap=bounded(maxChars,12000,50000), chunks=[]
    let left=cap
    for (let i=from;i<=last&&left;i++) {
      const raw=this.exact(session,i), start=i===from?charOffset:0
      if (start>raw.length) throw new Error('Offset past end of event')
      const content=raw.slice(start,start+left)
      chunks.push({ordinal:i,charOffset:start,content});left-=content.length
      if (start+content.length<raw.length) return {source:this.metadata(session),chunks,next:{ordinal:i,charOffset:start+content.length}}
    }
    const end=chunks.at(-1)?.ordinal
    return {source:this.metadata(session),chunks,next:end!==undefined&&end<last?{ordinal:end+1,charOffset:0}:null}
  }
  // Readable previews for the console; exact bytes stay behind readRange.
  eventPreviews(session, from, to) {
    if (!Number.isSafeInteger(from) || from<0 || !Number.isSafeInteger(to) || to<from) throw new Error('Invalid record range')
    return this.db.prepare('SELECT ordinal,preview FROM events WHERE session=? AND ordinal BETWEEN ? AND ? ORDER BY ordinal LIMIT 400').all(session,from,Math.min(to,from+399))
  }
  bands(session) { return this.db.prepare('SELECT id,level,first,last FROM nodes WHERE session=? AND level>=1 ORDER BY level DESC,first').all(session) }
  harnessGroups() { return this.db.prepare("SELECT COALESCE(o.harness,'legacy') AS harness,COUNT(*) AS n FROM sources s LEFT JOIN session_origins o ON o.session=s.session GROUP BY 1 ORDER BY 2 DESC").all() }
  summarizing(session) { return Boolean(this.db.prepare('SELECT 1 FROM leases WHERE session=? AND until_ms>?').get(session,Date.now())) }
  // Most recent visible messages, oldest first, within a character budget.
  recent(session, maxChars=6000) {
    const out=[];let left=maxChars
    for (const e of this.db.prepare("SELECT ordinal,preview FROM events WHERE session=? AND preview<>'' AND preview NOT LIKE 'custom-title:%' AND preview NOT LIKE 'ai-title:%' ORDER BY ordinal DESC LIMIT 200").iterate(session)) {
      const text=e.preview.length>1500?e.preview.slice(0,1500)+' …[truncated; lcm_read for full text]':e.preview
      if (text.length>left && out.length) break
      out.unshift({ordinal:e.ordinal,text});left-=text.length
      if (left<=0) break
    }
    return out
  }
  // Substring search (works for CJK) across one or all conversations.
  find(query, {session, harness, limit=20}={}) {
    const cap=bounded(limit,20,50)
    if (query===undefined || query==='') {
      const list=this.listSessions(cap,0,harness)
      return {conversations:list.sessions.map(({session,code,harness,name,records,summary_count,updated_ms})=>({session,code,harness,name,records,summary_count,updated_ms})),total:list.total}
    }
    if (typeof query!=='string' || query.length>200) throw new Error('Query must be 1–200 characters')
    const like='%'+query.trim().replace(/[\\%_]/g,m=>'\\'+m)+'%'
    const scope=session?' AND x.session=?':harness?" AND x.session IN (SELECT session FROM session_origins WHERE harness=?)":''
    const args=session?[session]:harness?[harness]:[]
    const conversations=session?[]:this.resolve(query).filter(m=>!harness||m.harness===harness).slice(0,10)
    const summaries=this.db.prepare(`SELECT x.session,x.id,x.level,x.first,x.last,x.summary FROM nodes x WHERE x.summary LIKE ? ESCAPE '\\'${scope} ORDER BY x.level DESC,x.first DESC LIMIT ?`).all(like,...args,cap).map(r=>({...r,conversation:this.metadata(r.session)}))
    const events=this.db.prepare(`SELECT x.session,x.ordinal,x.preview FROM events x WHERE x.preview LIKE ? ESCAPE '\\'${scope} ORDER BY x.rowid DESC LIMIT ?`).all(like,...args,cap).map(r=>{const i=r.preview.toLowerCase().indexOf(query.trim().toLowerCase());return {session:r.session,ordinal:r.ordinal,snippet:r.preview.slice(Math.max(0,i-120),i+240),conversation:this.metadata(r.session)}})
    return {query,conversations,summaries,events}
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
    this.db.prepare('DELETE FROM deleted_sessions WHERE session=?').run(session) // an explicit (re)index revives a deleted conversation
    const file = this.#verifySource(session, path, kind)
    const src = this.source(session)
    if (src.offset > 0) this.archive(session)
    const fd = openSync(file, 'r'), copy = this.#archiveWriter(session, src.offset)
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
          if (copy !== null) writeSync(copy, raw, 0, raw.length, offset)
          this.#addEvent(session, ordinal++, offset, offset + raw.length, raw, kind)
          added++; offset += raw.length; pending = pending.subarray(cut + 1)
        }
        if (pending.length > 4 * 1024 * 1024) throw new Error('Individual JSONL line exceeds 4 MiB')
      }
      if (kind === 'text' && pending.length) { if (copy !== null) writeSync(copy, pending, 0, pending.length, offset); this.#addEvent(session,ordinal,offset,offset+pending.length,pending,kind);added++;offset+=pending.length }
      return { session, added, offset, ...(pending.length && kind==='jsonl' ? { warning: 'Trailing partial line not indexed yet' } : {}) }
    } finally { closeSync(fd); if (copy !== null) closeSync(copy) }
  }
  // Private copy of every indexed byte, so originals survive the host moving or deleting its transcript.
  // The copy is exactly source bytes [0, offset), so event offsets address it unchanged.
  // Deleted conversations stay deleted: automatic capture (hooks) checks this before indexing again.
  isDeleted(session) { return Boolean(this.db.prepare('SELECT 1 FROM deleted_sessions WHERE session=?').get(session)) }
  // Remove one conversation from SuperLcm: records, summaries, settings and SuperLcm's own copies.
  // The host tool's transcript is never touched.
  deleteSession(session) {
    const src = this.source(session)
    if (!src) throw new Error('Unknown session')
    const records = this.stats(session).records
    const ownCopy = !relative(this.dir, src.path).startsWith('..') && !isAbsolute(relative(this.dir, src.path))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const deliveries = this.db.prepare('SELECT id FROM deliveries WHERE source_session=? OR target_session=?').all(session, session).map(x => x.id)
      for (const id of deliveries) { this.db.prepare('DELETE FROM delivery_packets WHERE id=?').run(id); this.db.prepare('DELETE FROM deliveries WHERE id=?').run(id) }
      for (const table of ['event_fts', 'events', 'node_fts', 'nodes', 'leases', 'compactions', 'takeover_copies', 'host_writers', 'summary_policies', 'summary_preferences', 'session_origins', 'sources']) this.db.prepare(`DELETE FROM ${table} WHERE session=?`).run(session)
      this.db.prepare('INSERT INTO deleted_sessions(session,deleted_ms) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET deleted_ms=excluded.deleted_ms').run(session, Date.now())
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    const files = [this.archivePath(session)]
    // Import and snapshot copies live under the index; remove them unless another conversation still uses them.
    if (ownCopy && !this.db.prepare('SELECT 1 FROM sources WHERE path=?').get(src.path)) files.push(src.path)
    for (const file of files) try { unlinkSync(file) } catch {}
    return { session, deleted: true, records }
  }
  // Conversations whose last activity is before a cutoff, optionally for one tool.
  staleSessions(beforeMs, harness) {
    if (!Number.isSafeInteger(beforeMs)) throw new Error('Invalid cutoff')
    return this.db.prepare("SELECT s.session,COALESCE(o.harness,'legacy') AS harness,o.display_name AS name,s.updated_ms,(SELECT COUNT(*) FROM events e WHERE e.session=s.session) AS records FROM sources s LEFT JOIN session_origins o ON o.session=s.session WHERE s.updated_ms IS NOT NULL AND s.updated_ms<?" + (harness ? " AND COALESCE(o.harness,'legacy')=?" : '') + ' ORDER BY s.updated_ms').all(...(harness ? [beforeMs, harness] : [beforeMs]))
  }
  storageStats() {
    const size = file => { try { return statSync(file).size } catch { return 0 } }
    const row = this.db.prepare('SELECT (SELECT COUNT(*) FROM sources) AS conversations,(SELECT COUNT(*) FROM events) AS records,(SELECT COUNT(*) FROM nodes) AS summaries').get()
    const originals = this.db.prepare('SELECT session FROM sources').all().reduce((n, x) => n + size(this.archivePath(x.session)), 0)
    return { ...row, index_bytes: size(join(this.dir, 'lcm.sqlite')) + size(join(this.dir, 'lcm.sqlite-wal')), originals_bytes: originals, dir: this.dir }
  }
  archivePath(session) { return join(this.dir, 'originals', hash(String(session)).slice(0, 40) + '.raw') }
  #archiveWriter(session, offset) {
    const path = this.archivePath(session)
    if (offset > 0 && !(existsSync(path) && statSync(path).size >= offset)) return null
    ensurePrivate(dirname(path))
    const fd = openSync(path, existsSync(path) ? 'r+' : 'w', 0o600)
    if (fstatSync(fd).size > offset) ftruncateSync(fd, offset) // bytes from an append whose index write never committed
    return fd
  }
  // Hosts move finished transcripts; Codex archives rollouts from sessions/YYYY/MM/DD/ into archived_sessions/.
  #moved(path) {
    const candidate = path.replace(/([\\/])sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]/, '$1archived_sessions$1')
    return candidate !== path && existsSync(candidate) ? candidate : null
  }
  // Build or complete the private copy from the source, keeping it only if every indexed record verifies.
  archive(session) {
    const src = this.source(session)
    if (!src) throw new Error('Unknown session')
    const target = this.archivePath(session)
    if (existsSync(target) && statSync(target).size >= src.offset) return { session, archived: true, copied: 0 }
    const path = existsSync(src.path) ? src.path : this.#moved(src.path)
    if (!path) return { session, archived: false, error: 'Original transcript is missing' }
    const rows = this.db.prepare('SELECT ordinal,start,end,digest FROM events WHERE session=? ORDER BY ordinal').all(session)
    ensurePrivate(dirname(target))
    const tmp = target + '.tmp', input = openSync(path, 'r')
    let ok = false
    try {
      if (fstatSync(input).size < src.offset) return { session, archived: false, error: 'Original transcript is shorter than what was indexed' }
      const out = openSync(tmp, 'w', 0o600), chunk = Buffer.alloc(1024 * 1024)
      try { for (let at = 0; at < src.offset;) { const n = readSync(input, chunk, 0, Math.min(chunk.length, src.offset - at), at); if (!n) break; writeSync(out, chunk, 0, n, at); at += n } } finally { closeSync(out) }
      const check = openSync(tmp, 'r'), size = src.offset
      try { ok = rows.every(row => this.#readRange(check, row.start, row.end, size)?.digest === row.digest) } finally { closeSync(check) }
      if (!ok) return { session, archived: false, error: 'Original transcript no longer matches the index' }
      renameSync(tmp, target)
      return { session, archived: true, copied: src.offset, ...(path !== src.path ? { found_at: path } : {}) }
    } finally { closeSync(input); if (!ok && existsSync(tmp)) unlinkSync(tmp) }
  }
  archiveAll() { return this.db.prepare('SELECT session FROM sources ORDER BY session').all().map(r => this.archive(r.session)) }
  // Readable copies in preference order: private archive first, then the host's transcript.
  #originals(session) {
    const src = this.source(session), archive = this.archivePath(session)
    if (!(existsSync(archive) && statSync(archive).size >= src.offset)) this.archive(session)
    return [archive, src.path, this.#moved(src.path)].filter(p => p && existsSync(p))
  }
  #addEvent(session, ordinal, start, end, raw, kind) {
    let preview = extract(raw, kind)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // A SuperLcm compaction packet, and the kept messages Claude Code writes again right after it, are
      // already recorded: their bytes stay in the archive, but they are not indexed or summarized twice.
      // Only the first message after Claude Code's compact_boundary can be a packet (remaining -1 marks
      // that point), so the same text pasted into a prompt is indexed like any other message.
      const record = kind === 'jsonl' ? jsonRecord(raw) : null
      const copies = this.db.prepare('SELECT remaining FROM takeover_copies WHERE session=?').get(session)?.remaining || 0
      const setCopies = n => this.db.prepare('INSERT INTO takeover_copies(session,remaining) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET remaining=excluded.remaining').run(session, n)
      const message = record?.type === 'user' || record?.type === 'assistant'
      const packet = copies === -1 && message && /^user: <superlcm-context [^>]*keep="(\d+)"/.exec(preview)
      if (record?.type === 'system' && record.subtype === 'compact_boundary') setCopies(-1)
      else if (packet) { preview=''; setCopies(Number(packet[1])) }
      else if (copies === -1 && message) setCopies(0)
      else if (copies > 0 && message) { preview=''; setCopies(copies - 1) }
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(session, ordinal, start, end, hash(raw), preview)
      this.db.prepare('INSERT INTO event_fts(session,ordinal,preview) VALUES(?,?,?)').run(session, ordinal, preview)
      this.db.prepare("UPDATE sources SET offset=?,status='ok',updated_ms=? WHERE session=?").run(end, Date.now(), session)
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
    const copies = this.#originals(session)
    if (!copies.length) throw new Error('Original transcript is missing and no archived copy exists')
    for (const path of copies) {
      const fd = openSync(path, 'r')
      try {
        const actual = this.#readRange(fd, event.start, event.end, fstatSync(fd).size)
        if (actual && actual.digest === event.digest) return actual.raw.toString('utf8')
      } finally { closeSync(fd) }
    }
    throw new Error('Raw transcript changed: exact expansion refused')
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
  eventRowsFrom(session, start) { return this.db.prepare('SELECT ordinal,digest,preview FROM events WHERE session=? AND ordinal>=? ORDER BY ordinal').all(session, start) }
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
  // One writer per conversation at a time. owner is 'host' for the summaries Claude Code writes inside the
  // conversation and 'worker:<pid>' for a separate run; only the owner renews or releases its lease.
  lease(session, duration = 120000, owner = `worker:${process.pid}`) {
    const now = Date.now()
    const result=this.db.prepare("INSERT INTO leases(session,until_ms,owner) VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET until_ms=excluded.until_ms,owner=excluded.owner WHERE leases.until_ms < ?").run(session, now+duration, owner, now)
    return result.changes === 1
  }
  renewLease(session, duration = 120000, owner = `worker:${process.pid}`) { this.db.prepare('UPDATE leases SET until_ms=? WHERE session=? AND owner=?').run(Date.now()+duration, session, owner) }
  release(session, owner = `worker:${process.pid}`) { this.db.prepare('UPDATE leases SET until_ms=0 WHERE session=? AND owner=?').run(session, owner) }
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
    const issues = [], [path] = this.#originals(session)
    if (!path) issues.push('original transcript missing and not archived')
    else {
      if (path !== this.archivePath(session)) issues.push('no archived copy yet')
      const fd = openSync(path,'r')
      try {
        const size = fstatSync(fd).size
        for (const row of rows) if (this.#readRange(fd,row.start,row.end,size)?.digest !== row.digest) issues.push(`bad source pointer ${row.ordinal}`)
        if (size < src.offset) issues.push('source truncated')
      } finally { closeSync(fd) }
    }
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
