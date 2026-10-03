// Reuse the summaries already committed by the DSH compaction engine. No model
// calls, and no attempt to reinterpret an incomplete compaction as a success.
import { createHash } from 'node:crypto'
export function syncDshSummaries(store, session, id) {
  store.db.exec('CREATE TABLE IF NOT EXISTS dsh_node_sources(session TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(session,id,seq))')
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lcm_nodes'").get()) return
  const rows = store.db.prepare("SELECT * FROM lcm_nodes WHERE session_id=? AND status='ready' ORDER BY summary_seq").all(id)
  const nodes = new Map(rows.map(row => [row.node_id, row])), memo = new Map()
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
  const level = (key, seen = new Set()) => {
    if (seen.has(key)) throw Error('DSH summary graph contains a cycle')
    if (memo.has(key)) return memo.get(key)
    const node = nodes.get(key)
    if (!node) throw Error('DSH summary refers to a missing child')
    const children = JSON.parse(node.child_ids_json)
    const value = children.length ? 1 + Math.max(...children.map(child => level(child, new Set([...seen, key])))) : 0
    memo.set(key, value); return value
  }
  for (const row of rows) {
    const seqs = JSON.parse(row.source_seqs_json), children = JSON.parse(row.child_ids_json)
    if (!seqs.length || seqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)) continue
    if (!canShare(row.node_id)) continue
    const refs = `DSH native summary. Exact selected source records: ${seqs.join(', ')}. The range below is a reading envelope, not a claim that every intervening record was summarized.\n`
    const text = refs + row.summary_text
    const nodeId = 'dsh-native-' + row.node_id
    const existing = store.node(session, nodeId)
    if (existing && existing.summary !== text) throw Error('Previously archived DSH summary changed')
    store.addNode({ session, id: nodeId, level: level(row.node_id), first: Math.min(...seqs), last: Math.max(...seqs), children: children.map(child => 'dsh-native-' + child), summary: text, digest: createHash('sha256').update(JSON.stringify(row)).digest('hex'), model: 'dsh-native:' + (row.model || 'configured') })
    const insert = store.db.prepare('INSERT OR IGNORE INTO dsh_node_sources VALUES(?,?,?)')
    for (const seq of seqs) insert.run(session, nodeId, seq)
  }
}

export function dshCoverage(db, session, records) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='dsh_node_sources'").get()
  const seqs = exists ? db.prepare('SELECT DISTINCT seq FROM dsh_node_sources WHERE session=? ORDER BY seq').all(session).map(row => row.seq) : []
  const gaps = []; let from = 0
  for (const seq of seqs) { if (seq >= records) continue; if (seq > from) gaps.push({ from, to: seq - 1 }); from = seq + 1 }
  if (from < records) gaps.push({ from, to: records - 1 })
  return { coverage: 'selected-records', summarized_to: gaps[0]?.from ?? records, unsummarized_ranges: gaps }
}

export function dshNodeSources(db, session, node) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='dsh_node_sources'").get()) return node
  const seqs = db.prepare('SELECT seq FROM dsh_node_sources WHERE session=? AND id=? ORDER BY seq').all(session, node.id).map(row => row.seq)
  return seqs.length ? { ...node, source_records: seqs, range_kind: 'reading-envelope' } : node
}
