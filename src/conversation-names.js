import { readFileSync, readdirSync, lstatSync, realpathSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, basename, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'
import { codexNativeName } from './codex.js'

const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : ''
function smallJson(path, limit = 256 * 1024) {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch { return null } // Optional host metadata must never block capture.
}

// Claude Desktop stores a rename beside, rather than inside, the JSONL file.
export function claudeSidecarTitle(id, file) {
  if (!file || !/^[\w.-]{1,190}$/.test(id) || basename(file) !== id + '.jsonl') return null
  return clean(smallJson(join(dirname(file), id, 'custom-title.json'))?.customTitle) || null
}

// A shell can rename a native conversation without changing its transcript.
// Match the persisted provider session ID, never a prompt, folder or similar title.
const shellCache = new Map()
export function paseoNames(env = process.env, { force = false } = {}) {
  const root = resolve(env.PASEO_HOME || join(env.HOME || homedir(), '.paseo'), 'agents')
  const prior = shellCache.get(root)
  if (!force && prior && Date.now() - prior.at < 15000) return prior.names
  const names = new Map()
  try {
    let visited = 0
    for (const directory of readdirSync(root, { withFileTypes: true })) {
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue
      for (const entry of readdirSync(join(root, directory.name), { withFileTypes: true })) {
        if (++visited > 20000) throw Error('Shell metadata scan limit')
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue
        const row = smallJson(join(root, directory.name, entry.name))
        const provider = row?.provider === 'claude' ? 'claude-code' : row?.provider === 'codex' ? 'codex' : null
        const id = row?.persistence?.sessionId
        const title = clean(row?.title)
        if (!provider || row?.persistence?.provider !== row.provider || typeof id !== 'string' || !/^[\w.-]{1,190}$/.test(id) || !title) continue
        const key = provider + '\0' + id, at = Date.parse(row.updatedAt) || 0, old = names.get(key)
        if (!old || at > old.at) names.set(key, { title, at })
        else if (at === old.at && old.title !== title) names.set(key, { title: null, at })
      }
    }
  } catch { names.clear() }
  shellCache.set(root, { at: Date.now(), names })
  return names
}

export function nativeConversationName(store, { harness, id, file, records = [], env = process.env, names }) {
  // A portable import can reuse an external ID. Only host-owned files may take
  // a host/shell name; imports keep their own label and provenance.
  const codex = harness === 'codex' ? codexNativeName(id, file, { env }) : null
  // Older valid Codex rollouts need not have session_meta; the state database
  // independently verifies the exact native ID and canonical rollout path.
  if (!codex && !nativeIdentity(harness, id, file, env)) return null
  const shell = (names || paseoNames(env)).get(harness + '\0' + id)?.title
  if (harness === 'codex') return shell || codex
  if (harness !== 'claude-code') return null
  const custom = claudeSidecarTitle(id, file)
  const recorded = store.source(id) ? store.nativeClaudeTitle(id) : null
  const title = records.filter(r => r.type === 'custom-title').at(-1)?.customTitle
    || records.filter(r => r.type === 'ai-title').at(-1)?.aiTitle
  return shell || custom || recorded || clean(title) || null
}

function nativeIdentity(harness, id, file, env) {
  if (!file || !['claude-code','codex'].includes(harness)) return false
  try {
    const root = realpathSync(harness === 'claude-code'
      ? join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'), 'projects')
      : join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'sessions'))
    const path = realpathSync(file), rel = relative(root, path)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || !path.endsWith('.jsonl')) return false
    if (harness === 'claude-code') return basename(path) === id + '.jsonl'
    // Codex supplies the native ID in its first rollout record.
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(65536), length = readSync(fd, buffer, 0, buffer.length, 0)
      const end = buffer.subarray(0, length).indexOf(10)
      if (end < 0) return false
      const header = JSON.parse(buffer.subarray(0, end).toString('utf8'))
      return header.type === 'session_meta' && header.payload?.id === id
    } finally { closeSync(fd) }
  } catch { return false }
}

const refreshed = new WeakMap()
export function refreshConversationNames(store, { env = process.env, session, minIntervalMs = 0 } = {}) {
  const key = session || '*', cache = refreshed.get(store) || new Map(), at = cache.get(key) || 0
  if (Date.now() - at < minIntervalMs) return { checked: 0, changed: 0, cached: true }
  const names = paseoNames(env)
  let changed = 0
  const rows = store.db.prepare("SELECT s.session,s.path,o.harness,o.external_id,o.display_name,o.name_source FROM sources s JOIN session_origins o USING(session) WHERE o.harness IN ('claude-code','codex') AND COALESCE(o.name_source,'')<>'manual'" + (session ? ' AND s.session=?' : '')).all(...(session ? [session] : []))
  for (const row of rows) {
    const name = nativeConversationName(store, { harness: row.harness, id: row.external_id || row.session, file: row.path, env, names })
    if (name && (name !== row.display_name || row.name_source !== 'native')) {
      store.setMetadata(row.session, { harness: row.harness, externalId: row.external_id || row.session, name, nameSource: 'native' })
      changed++
    }
  }
  cache.set(key, Date.now());refreshed.set(store, cache)
  return { checked: rows.length, changed }
}
