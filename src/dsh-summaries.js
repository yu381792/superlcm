// Reuse the summaries already committed by the DSH compaction engine. No model
// calls, and no attempt to reinterpret an incomplete compaction as a success.
import {legacyDshSource,archivePosition} from './dsh-evidence.js'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { jsonlTail } from './jsonl-tail.js'
import { semanticKind, semanticFrontier, semanticLevel } from '../dsh/tree-semantics.js'

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
export function dshVisibleNodes(db, alias = 'n') {
  const visible=hasTable(db,'dsh_shared_nodes')?`NOT EXISTS (SELECT 1 FROM dsh_shared_nodes v WHERE v.session=${alias}.session AND v.id=${alias}.id AND v.visible=0)`:'1'
  return hasTable(db,'dsh_legacy_sources')?`(${visible}) AND NOT EXISTS(SELECT 1 FROM dsh_legacy_sources h WHERE h.session=${alias}.session)`:visible
}

export function dshRecordCategory(event) {
  if (event?.data?.source?.kind === 'compact-checkpoint') return 'checkpoint'
  if (['system/message', 'developer/message'].includes(event?.type) && event.surfaceOp) return 'persistent'
  const operation = typeof event?.surfaceOp === 'string' ? event.surfaceOp : event?.surfaceOp?.op
  if (['append', 'replace'].includes(operation) && ['user/message', 'assistant/message', 'tool/result'].includes(event.type)) return 'original'
  return 'non-message'
}

// Classify immutable original events, including messages whose projection text is
// empty (images, tool calls carried by an assistant message, and tool results).
// Capture persists this derived index; old archives can also be read without a write.
function recordCategories(store, session, records) {
  const db = store.db
  const saved = hasTable(db, 'dsh_record_kinds') ? db.prepare('SELECT seq,category FROM dsh_record_kinds WHERE session=? AND seq<? ORDER BY seq').all(session, records) : []
  const categories = new Map(saved.map(row => [row.seq, row.category]))
  categories.revisionEvents = new Map()
  if (categories.size === records) return categories
  if (categories.size && store.exact) {
    for (let seq = 0; seq < records; seq++) {
      if (!categories.has(seq)) {
        const event = JSON.parse(store.exact(session, seq)).event
        categories.set(seq, dshRecordCategory(event)); categories.revisionEvents.set(seq, revisionMetadata(event))
      }
    }
    return categories
  }
  const source = store.source(session)
  const archive = store.archivePath?.(session)
  const file = archive && existsSync(archive) ? archive : source.path
  for (const item of jsonlTail(file)) {
    if (item.end > source.offset) break
    const event = item.record.event,seq=archivePosition(item.record)
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= records) throw Error('Invalid archived DSH event identity')
    const category = dshRecordCategory(event)
    if (categories.has(seq) && categories.get(seq) !== category) throw Error('Previously classified DSH event changed')
    categories.set(seq, category)
    categories.revisionEvents.set(seq, revisionMetadata(event))
    if (item.end === source.offset) break
  }
  if (categories.size !== records) throw Error('DSH archive classification is incomplete')
  return categories
}

const revisionMetadata = event => ({ seq: event.seq, type: event.type, surfaceOp: event.surfaceOp,
  sourceEventSeqs: event.sourceEventSeqs, data: { source: { kind: event.data?.source?.kind } } })
function recordRevisions(store, session, records, categories) {
  const db = store.db
  const revisions = new Map(hasTable(db, 'dsh_record_revisions') ? db.prepare('SELECT seq,replaced_by FROM dsh_record_revisions WHERE session=? AND seq<?').all(session, records).map(row => [row.seq, row.replaced_by]) : [])
  const cursor = hasTable(db, 'dsh_revision_scan') ? db.prepare('SELECT next_seq FROM dsh_revision_scan WHERE session=?').get(session)?.next_seq ?? 0 : 0
  const inspect = event => {
    const op = event.surfaceOp
    if (event.data?.source?.kind === 'compact-checkpoint' || op?.op !== 'replace' || categories.get(event.seq) !== 'original') return
    const cited = event.sourceEventSeqs
    if (!Number.isSafeInteger(op.startSeq) || !Number.isSafeInteger(op.endSeq) || op.startSeq > op.endSeq
      || !Array.isArray(cited) || !cited.includes(op.startSeq) || !cited.includes(op.endSeq)) return
    for (const seq of cited) if (Number.isSafeInteger(seq) && seq >= op.startSeq && seq <= op.endSeq && seq < event.seq && categories.get(seq) === 'original') revisions.set(seq, event.seq)
  }
  if (cursor === 0 && categories.revisionEvents.size < records && records) {
    const source = store.source(session), archive = store.archivePath?.(session)
    for (const item of jsonlTail(archive && existsSync(archive) ? archive : source.path)) {
      if (item.end > source.offset) break
      inspect(item.record.event)
      if (item.end === source.offset) break
    }
  } else {
    for (let seq = cursor; seq < records; seq++) inspect(categories.revisionEvents.get(seq) ?? JSON.parse(store.exact(session, seq)).event)
  }
  return revisions
}

const ranges = seqs => {
  const result = []
  for (const seq of seqs) {
    const previous = result.at(-1)
    if (previous && previous.to + 1 === seq) previous.to = seq
    else result.push({ from: seq, to: seq })
  }
  return result
}

export function syncDshSummaries(store, session, id) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS dsh_node_sources(session TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(session,id,seq));
    CREATE TABLE IF NOT EXISTS dsh_shared_nodes(session TEXT NOT NULL,id TEXT NOT NULL,visible INTEGER NOT NULL,PRIMARY KEY(session,id));
    CREATE TABLE IF NOT EXISTS dsh_record_kinds(session TEXT NOT NULL,seq INTEGER NOT NULL,category TEXT NOT NULL,PRIMARY KEY(session,seq));
    CREATE TABLE IF NOT EXISTS dsh_record_revisions(session TEXT NOT NULL,seq INTEGER NOT NULL,replaced_by INTEGER NOT NULL,PRIMARY KEY(session,seq));
    CREATE TABLE IF NOT EXISTS dsh_revision_scan(session TEXT PRIMARY KEY,next_seq INTEGER NOT NULL);`)
  const records = store.db.prepare('SELECT records FROM session_event_counts WHERE session=?').get(session)?.records ?? 0
  const categories = recordCategories(store, session, records)
  const revisions = recordRevisions(store, session, records, categories)
  const remember = store.db.prepare('INSERT OR IGNORE INTO dsh_record_kinds VALUES(?,?,?)')
  store.db.exec('BEGIN IMMEDIATE')
  try {
    for (const [seq, category] of categories) remember.run(session, seq, category)
    const revision = store.db.prepare('INSERT INTO dsh_record_revisions VALUES(?,?,?) ON CONFLICT(session,seq) DO UPDATE SET replaced_by=excluded.replaced_by')
    for (const [seq, replacement] of revisions) revision.run(session, seq, replacement)
    store.db.prepare('INSERT INTO dsh_revision_scan VALUES(?,?) ON CONFLICT(session) DO UPDATE SET next_seq=excluded.next_seq').run(session, records)
    store.db.exec('COMMIT')
  } catch (error) { store.db.exec('ROLLBACK'); throw error }
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lcm_nodes'").get()) return
  const rows = store.db.prepare("SELECT * FROM lcm_nodes WHERE session_id=? AND status='ready' ORDER BY summary_seq").all(id)
  const nodes = new Map(rows.map(row => [row.node_id, row])), memo = new Map()
  const adapter = { getNode(_session, key) {
    const row = nodes.get(key)
    return row ? { summary: JSON.parse(row.summary_json), childIds: JSON.parse(row.child_ids_json), sourceSeqs: JSON.parse(row.source_seqs_json), kind: row.node_kind ?? null } : null
  } }
  const archived = seq => Boolean(store.db.prepare('SELECT 1 FROM dsh_event_digests WHERE session=? AND seq=?').get(session, seq))
  const eligible = new Set(rows.filter(row => {
    const seqs = JSON.parse(row.source_seqs_json)
    return seqs.length && archived(row.summary_seq) && seqs.every(seq => Number.isSafeInteger(seq) && seq >= 0 && archived(seq))
  }).map(row => row.node_id))
  const shared = new Map()
  const canShare = (key, seen = new Set()) => {
    if (seen.has(key)) throw Error('DSH summary graph contains a cycle')
    if (shared.has(key)) return shared.get(key)
    const row = nodes.get(key)
    const result = eligible.has(key) && !!row && JSON.parse(row.child_ids_json).every(child => canShare(child, new Set([...seen, key])))
    shared.set(key, result); return result
  }
  const sources = (key, seen = new Set()) => {
    if (seen.has(key)) throw Error('DSH summary graph contains a cycle')
    if (memo.has(key)) return memo.get(key)
    const node = nodes.get(key)
    if (!node) throw Error('DSH summary refers to a missing child')
    const children = JSON.parse(node.child_ids_json)
    const value = [...new Set([...JSON.parse(node.source_seqs_json), ...children.flatMap(child => sources(child, new Set([...seen, key])))])]
      .filter(seq => categories.get(seq) !== 'checkpoint').sort((a, b) => a - b)
    memo.set(key, value); return value
  }
  const derived = []
  for (const row of rows) {
    const direct = JSON.parse(row.source_seqs_json)
    if (!direct.length || direct.some(seq => !Number.isSafeInteger(seq) || seq < 0)) continue
    if (!canShare(row.node_id) || semanticKind(adapter, id, row.node_id) === 'assembled') continue
    const seqs = sources(row.node_id), children = JSON.parse(row.child_ids_json).flatMap(child => semanticFrontier(adapter, id, child))
    if (!seqs.length || seqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) continue
    const nodeId = 'dsh-native-' + row.node_id
    const existing = store.node(session, nodeId)
    const text = row.summary_text
    const clean = value => value.replace(/^DSH native summary\. Exact selected source records:[^\n]*\n/, '')
    if (existing && clean(existing.summary) !== text) throw Error('Previously archived DSH summary changed')
    derived.push({ session, id: nodeId, level: semanticLevel(adapter, id, row.node_id) - 1, first: seqs[0], last: seqs.at(-1), children: children.map(child => 'dsh-native-' + child), summary: existing?.summary ?? text, digest: createHash('sha256').update(JSON.stringify(row)).digest('hex'), model: 'dsh-native:' + (row.model || 'configured'), seqs })
  }
  // Retain historical derived rows and text; replace only their visible forest
  // and source envelopes. Native nodes and original events remain immutable.
  store.db.exec('BEGIN IMMEDIATE')
  try {
    store.db.prepare('UPDATE dsh_shared_nodes SET visible=0 WHERE session=?').run(session)
    const visibility = store.db.prepare('INSERT INTO dsh_shared_nodes VALUES(?,?,?) ON CONFLICT(session,id) DO UPDATE SET visible=excluded.visible')
    for (const row of store.db.prepare("SELECT id FROM nodes WHERE session=? AND id LIKE 'dsh-native-%'").all(session)) visibility.run(session, row.id, 0)
    const insert = store.db.prepare('INSERT OR IGNORE INTO dsh_node_sources VALUES(?,?,?)')
    for (const node of derived) {
      const { id: nodeId, level, first, last, children, summary, digest, model } = node
      const fresh = store.db.prepare('INSERT OR IGNORE INTO nodes VALUES(?,?,?,?,?,?,?,?,?)').run(session, nodeId, level, first, last, JSON.stringify(children), summary, digest, model)
      if (fresh.changes) store.db.prepare('INSERT INTO node_fts(session,id,summary) VALUES(?,?,?)').run(session, nodeId, summary)
      store.db.prepare('UPDATE nodes SET level=?,first=?,last=?,children=? WHERE session=? AND id=?').run(level, first, last, JSON.stringify(children), session, nodeId)
      visibility.run(session, nodeId, 1)
      for (const seq of node.seqs) insert.run(session, nodeId, seq)
    }
    store.db.exec('COMMIT')
  } catch (error) { store.db.exec('ROLLBACK'); throw error }
}

export function dshCoverage(store, session, records) {
  const db = store.db,legacy=legacyDshSource(db,session),categories = recordCategories(store, session, records), revisions = legacy?new Map():recordRevisions(store, session, records, categories)
  const seqs = !legacy&&hasTable(db, 'dsh_node_sources') ? db.prepare(`SELECT DISTINCT s.seq FROM dsh_node_sources s WHERE s.session=? AND ${dshVisibleNodes(db, 's')} ORDER BY s.seq`).all(session).map(row => row.seq).filter(seq => seq < records && categories.get(seq) !== 'checkpoint') : []
  const selected = new Set(seqs)
  const originals = [], covered = [], uncovered = [], persistent = [], checkpoints = [], nonMessages = [], superseded = []
  for (const [seq, category] of [...categories].sort((a, b) => a[0] - b[0])) {
    if (category === 'original' && revisions.has(seq)) superseded.push(seq)
    else if (category === 'original') { originals.push(seq); (selected.has(seq) ? covered : uncovered).push(seq) }
    else if (category === 'persistent') persistent.push(seq)
    else if (category === 'checkpoint') checkpoints.push(seq)
    else nonMessages.push(seq)
  }
  const lastCovered = covered.at(-1) ?? -1, latest = uncovered.filter(seq => seq > lastCovered)
  return { ...(legacy?{historical_archive:legacy,sequence_mode:legacy.sequence_mode}:{}),coverage: 'selected-records', summarized_to: uncovered[0] ?? records,
    raw_records: originals.length, summarized_records: covered.length, unsummarized_records: uncovered.length,
    covered_ranges: ranges(covered), unsummarized_ranges: ranges(uncovered), selected_source_ranges: ranges(seqs),
    persistent_records: persistent.length, persistent_ranges: ranges(persistent),
    checkpoint_records: checkpoints.length, checkpoint_ranges: ranges(checkpoints),
    superseded_records: superseded.length, superseded_ranges: ranges(superseded),
    non_message_records: nonMessages.length, non_message_ranges: ranges(nonMessages),
    latest_tail: latest.length ? { from: latest[0], to: latest.at(-1), records: latest.length, ranges: ranges(latest) } : null }
}

export function dshNodeSources(db, session, node) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='dsh_node_sources'").get()) return node
  const seqs = db.prepare(`SELECT s.seq FROM dsh_node_sources s WHERE s.session=? AND s.id=? ${hasTable(db, 'dsh_record_kinds') ? "AND NOT EXISTS (SELECT 1 FROM dsh_record_kinds k WHERE k.session=s.session AND k.seq=s.seq AND k.category='checkpoint')" : ''} ORDER BY s.seq`).all(session, node.id).map(row => row.seq)
  return seqs.length ? { ...node, source_records: seqs, source_ranges: ranges(seqs), range_kind: 'reading-envelope' } : node
}
