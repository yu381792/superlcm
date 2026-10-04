import { markerFromSummary, stripRecallMetadata } from './marker.js'

export const plainSummaryBlocks = summary => summary.flatMap(block => {
  if (block.type !== 'text') return [block]
  const text=stripRecallMetadata(block.text)
  return text ? [{...block,text}] : []
})
// Deterministic labels add chronology and recall identity, not another model
// condensation. Rebuild can reproduce them byte-for-byte from child summaries.
export function orderedSummaryBlocks(summaries) {
  return summaries.flatMap((summary,index)=>{
    const id=markerFromSummary(summary)?.id
    if (!id) throw new Error('Ordered summary member has no recall identity')
    return [{type:'text',text:`Historical snapshot ${index+1}, recall node ${id}. State is as of its own source range; later snapshots may explicitly supersede it.`},...plainSummaryBlocks(summary)]
  })
}
