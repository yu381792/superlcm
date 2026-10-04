// Read the old native index without modifying it. Summaries keep their original
// IDs, provenance and selected seqs; they are never generated a second time.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'

export function migrateLegacyIndex(target, env = process.env) {
  const root = env.DSH_HOME || join(homedir(), '.dsh')
  const candidates = [env.DSH_SUPERLCM_LEGACY_DB, join(root, 'SuperLcm', 'lcm.sqlite'), join(root, 'lossless-context', 'lcm.sqlite')].filter(Boolean)
  let added = 0
  const conflicts = []
  for (const path of new Set(candidates.map(p => resolve(p)))) {
    if (!existsSync(path) || path === target.path) continue
    const source = new DatabaseSync(path, { readOnly: true })
    try {
      if (!source.prepare("SELECT 1 FROM sqlite_master WHERE name='lcm_nodes'").get()) continue
      for (const row of source.prepare('SELECT * FROM lcm_nodes').iterate()) {
        const prior = target.getNode(row.session_id, row.node_id)
        const node = { sessionId: row.session_id, nodeId: row.node_id, compactionId: row.compaction_id ?? null, summarySeq: row.summary_seq ?? null, createdAt: row.created_at, summary: JSON.parse(row.summary_json), summaryText: row.summary_text, childIds: JSON.parse(row.child_ids_json), sourceSeqs: JSON.parse(row.source_seqs_json), shadowedTokenCount: row.shadowed_token_count, provider: row.provider, model: row.model, status: row.status }
        if (prior) {
          const fields = ['summary', 'summaryText', 'sourceSeqs', 'childIds', 'compactionId', 'summarySeq'].filter(field => !isDeepStrictEqual(prior[field], node[field]))
          // A reindexed clone can preserve the same node/body while remapping
          // its event numbers. Keep both existing archives; an older migration
          // is never authority to overwrite the shared index or stop its host.
          if (fields.length) conflicts.push({ path, sessionId: row.session_id, nodeId: row.node_id, fields })
          continue
        }
        target.upsertNode(node)
        added++
      }
      // A cold log is scanned again before the new archive declares coverage.
      // Migrating a scan cursor alone could skip native checkpoints.
    } finally { source.close() }
  }
  return { added, conflicts }
}
