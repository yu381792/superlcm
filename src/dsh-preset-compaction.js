// Presets are dormant declarations, not ordinary host plugin children. Their
// private compaction realms must inherit the globally configured service.
import { isDshEngine } from './dsh-connection.js'
export function dshPresets(tree) {
  const found=[]
  const walk=rows=>{for(const row of rows||[]){
    if(row.disabled)continue
    if(/(?:^|\/)dsh-agent-preset$/.test(row.name||'')&&Array.isArray(row.config?.plugins))found.push(row)
    else if(Array.isArray(row.config))walk(row.config)
  }}
  walk(tree);return found
}
export function inheritGlobalCompaction(rows) {
  return rows.flatMap(row=>{
    if(isDshEngine(row)||row.name==='@deepseek-ai/dsh-compaction-tool-result-pruner')return []
    const next={...row}
    if(row.isolate?.compaction){next.isolate={...row.isolate};delete next.isolate.compaction}
    if(Array.isArray(row.config))next.config=inheritGlobalCompaction(row.config)
    return [next]
  })
}
export function presetCompactionLeaks(tree) {
  const leaks=[]
  const walk=rows=>{for(const row of rows||[]){if(row.disabled)continue
    if(isDshEngine(row)||row.isolate?.compaction||row.name==='@deepseek-ai/dsh-compaction-tool-result-pruner')leaks.push(row)
    if(Array.isArray(row.config))walk(row.config)
  }}
  for(const preset of dshPresets(tree))walk(preset.config.plugins)
  return leaks
}
