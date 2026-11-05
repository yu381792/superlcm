function recoverUsageBaseline(measurement, header, session, tools) {
  if (!session?.eventAt || !Array.isArray(measurement?.nodes) || !measurement.nodes.length) return null
  let sawInterruptedAssistant = false, anchorSeq = -1, usage = null
  for (let seq = (session.seq ?? 0) - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'request/header') {
      const h = event.data?.header
      if (h?.config?.provider !== header?.config?.provider || h?.config?.model !== header?.config?.model
        || JSON.stringify(h?.tools ?? []) !== JSON.stringify(header?.tools ?? [])) return null
      if (anchorSeq >= 0) break
      continue
    }
    if (anchorSeq < 0) {
      if (event.surfaceOp && event.surfaceOp !== 'append') return null
      if (event.type === 'assistant/message') {
        if (!event.data?.usage) { sawInterruptedAssistant = true; continue }
        if (!sawInterruptedAssistant) return null
        anchorSeq = seq; usage = event.data.usage
      }
    }
  }
  if (anchorSeq < 0 || !usage) return null
  const tokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0)
  const anchorSurface = measurement.nodes.filter(node => node.seq <= anchorSeq).reduce((sum, node) => sum + node.tokens, 0)
  const anchorEstimate = anchorSurface + tools
  if (anchorEstimate <= 0 || tokens < anchorEstimate) return null
  return { tokens, anchorEstimate, surfaceDeltaTokens: measurement.surfaceTokens - anchorSurface }
}

// DSH's text nodes use a four-characters-per-token heuristic, while pressure
// uses the provider's usage. Calibrate selection budgets against that same
// observed request so a 40K tail does not silently retain 80K+ on Chinese text.
// This is an estimate, not a replacement for the provider's tokenizer.
export function selectionPricing(measurement, header, session) {
  const tools = header?.tools?.length ? Math.ceil(JSON.stringify(header.tools).length / 4) + 4 : 0
  const recovered = measurement.baseline?.kind === 'usage' ? null : recoverUsageBaseline(measurement, header, session, tools)
  const anchorSurface = recovered ? measurement.surfaceTokens - recovered.surfaceDeltaTokens : measurement.surfaceTokens - measurement.surfaceDeltaTokens
  const anchorEstimate = recovered ? recovered.anchorEstimate : anchorSurface + tools
  const baselineTokens = recovered ? recovered.tokens : measurement.baseline?.tokens
  const surfaceDeltaTokens = recovered ? recovered.surfaceDeltaTokens : measurement.surfaceDeltaTokens
  const hasUsage = (measurement.baseline?.kind === 'usage' || recovered !== null) && anchorEstimate > 0
  const factor = hasUsage ? Math.max(1, baselineTokens / anchorEstimate) : 1
  const activeTokens = hasUsage && factor > 1
    ? (surfaceDeltaTokens >= 0
      ? baselineTokens + Math.ceil(surfaceDeltaTokens * factor)
      : Math.max(measurement.surfaceTokens + tools, Math.ceil((measurement.surfaceTokens + tools) * factor)))
    : Math.max(measurement.totalTokens, Math.ceil((measurement.surfaceTokens + tools) * factor))
  return {
    factor,
    activeTokens,
    nodes: measurement.nodes.map(node => ({ ...node, tokens: Math.ceil(node.tokens * factor) })),
  }
}
