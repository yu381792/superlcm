import { isDshEngine,isDshArchive } from './dsh-connection.js'

const ids = new Set(['SuperLcm-compaction','superlcm-native-compaction','superlcm-archive','mcp-superlcm-archive'])

export function retireLegacyDshRows(raw, host) {
  if (!raw) return raw
  const rows = host.parse(raw)
  if (!Array.isArray(rows)) return raw
  let changed = false
  const owned = row => ids.has(row?.id) && (!row.name ||
    (row.name !== '@deepseek-ai/dsh-compaction-basic' && (isDshEngine(row) || isDshArchive(row))))
  const next = rows.flatMap(row => {
    if (owned(row)) { changed = true; return [] }
    if (Array.isArray(row.insert)) {
      const insert = row.insert.filter(child => !owned(child))
      if (insert.length !== row.insert.length) {
        changed = true
        return insert.length ? [{ ...row, insert }] : []
      }
    }
    return [row]
  })
  return changed ? host.yaml.dump(next, { schema: host.schema, noRefs: true, lineWidth: -1 }) : raw
}
