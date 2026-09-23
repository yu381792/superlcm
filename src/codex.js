import { DatabaseSync } from 'node:sqlite'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const within = (root, file) => {
  const r=relative(root,file)
  return r==='' || (r!=='..' && !r.startsWith(`..${sep}`) && !isAbsolute(r))
}
export const codexHome = (env=process.env) => resolve(env.CODEX_HOME || join(homedir(),'.codex'))

// Codex explicitly supplies transcript_path. Never search all files or accept a
// path outside its local session directory (or the session's trusted .codex dir).
export function codexTranscript(path,{env=process.env,cwd}={}) {
  if (typeof path!=='string' || !path.endsWith('.jsonl')) throw new Error('Codex transcript_path must be a JSONL file')
  const file=realpathSync(path)
  if (!statSync(file).isFile()) throw new Error('Codex transcript_path is not a regular file')
  const roots=[join(codexHome(env),'sessions')]
  if (typeof cwd==='string' && isAbsolute(cwd)) roots.push(join(resolve(cwd),'.codex'))
  if (!roots.some(root=>existsSync(root) && within(realpathSync(root),file))) throw new Error('Codex transcript_path is outside its local sessions directory')
  return file
}

// The Codex state DB is an optional, version-dependent hint, never transcript
// truth. If the name/rollout path schema changes, fall back to first user text.
export function codexNativeName(sessionId,file,{env=process.env}={}) {
  for (const path of [join(codexHome(env),'state_5.sqlite'),join(codexHome(env),'sqlite','state_5.sqlite')]) {
    if (!existsSync(path)) continue
    let db
    try {
      db=new DatabaseSync(path,{readOnly:true})
      const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(row=>row.name))
      if (!['id','rollout_path','title'].every(key=>columns.has(key))) continue
      const nameColumn=columns.has('name') ? 'name' : 'NULL AS name'
      const row=db.prepare(`SELECT ${nameColumn},title,rollout_path FROM threads WHERE id=?`).get(sessionId)
      if (!row?.rollout_path || realpathSync(row.rollout_path)!==file) continue
      const title=typeof row.name==='string' && row.name.trim() ? row.name : row.title
      if (typeof title==='string' && title.trim()) return title.replace(/\s+/g,' ').trim().slice(0,160)
    } catch { /* A changing/private state DB is not an ingestion dependency. */ }
    finally { db?.close() }
  }
  return null
}

export function codexSessionKey(id) {
  if (typeof id!=='string' || !/^[\w.-]{1,190}$/.test(id)) throw new Error('Invalid Codex session ID')
  return `codex-${id}`
}
