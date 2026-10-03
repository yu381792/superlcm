// Condense only contiguous checkpoints of the same depth. Ordinary compaction
// keeps its cache-stable prefix; this pass runs when that prefix exceeds its
// budget or the host has reported real pressure. Source DAG nodes remain intact.
export function selectSummaryCondensation(pricedNodes, surfaceSeqs, depths, options = {}) {
  if (pricedNodes.length !== surfaceSeqs.length || pricedNodes.some((node, i) => node.seq !== surfaceSeqs[i])) throw Error('summary selection: token-meter surface mismatch')
  const start = options.systemEnd ?? 0, end = options.prefixEnd ?? start
  const tokens = index => Math.max(0, Number.isFinite(pricedNodes[index]?.tokens) ? pricedNodes[index].tokens : 0)
  const prefixTokens = pricedNodes.slice(start, end).reduce((sum, _, index) => sum + tokens(start + index), 0)
  const hard = options.forceHard === true || options.activeTokens >= options.hardActiveTokens
  const target = options.summaryPrefixTargetTokens > 0 ? options.summaryPrefixTargetTokens : Math.min(options.foldBatchTokens, Math.floor(options.softActiveTokens / 2))
  if (!hard && prefixTokens <= target) return null
  const fanout = hard ? 2 : options.condensedMinFanout ?? 4
  const minSource = Math.min(options.pressureFoldTokens, Math.floor(options.foldBatchTokens / 4))
  const depthAt = typeof depths === 'function' ? depths : index => depths[index]
  const candidates = []
  for (let first = start; first < end;) {
    const depth = depthAt(first)
    let last = first, foldTokens = 0
    if (!Number.isSafeInteger(depth) || depth < 1) { first++; continue }
    while (last < end && depthAt(last) === depth) {
      foldTokens += tokens(last); last++
      if (last - first >= fanout && foldTokens >= minSource) break
    }
    if (last - first >= fanout && foldTokens > 0 && (hard || foldTokens >= minSource)
      && (options.isBalancedBefore?.(surfaceSeqs[first]) ?? true)
      && (options.isBalancedAfter?.(surfaceSeqs[last - 1]) ?? true)) candidates.push({ first, last, depth, foldTokens })
    first = last
  }
  candidates.sort((a, b) => a.depth - b.depth || a.first - b.first)
  const best = candidates[0]
  if (!best) return null
  return { start: surfaceSeqs[best.first], end: surfaceSeqs[best.last - 1], foldTokens: best.foldTokens, tailNodes: surfaceSeqs.length - end, tailTokens: pricedNodes.slice(end).reduce((sum, _, i) => sum + tokens(end + i), 0), tailCountRelaxed: false, activeTokens: options.activeTokens, reason: 'summary-prefix', summaryKind: 'condensed', sourceDepth: best.depth, sourceCount: best.last - best.first, prefixTokens, prefixTargetTokens: target }
}
