import { prepareAsyncRegion, summarizeAsyncRegion } from './async-region.js'
import { assembleRegions, assembledCheckpointMessage } from './assembled-region.js'
import { markerFromSummary } from './marker.js'
import { nodeLevel } from './core.js'
import { selectionPricing } from './selection-pricing.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { plainSummaryBlocks } from './assembly-blocks.js'
import { currentPolicy } from './ratio-runtime.js'
import { saveDraft } from './draft-persistence.js'
import { semanticFrontier } from './tree-semantics.js'

export function summaryBudget(config) {
  return config.summaryPrefixTargetTokens > 0 ? config.summaryPrefixTargetTokens
    : Math.min(config.foldBatchTokens, Math.floor(config.softActiveTokens / 2))
}

export function draftBudget(engine, agent) {
  const config=currentPolicy(engine,agent)
  const final=summaryBudget(config)
  return config.budgetMode==='ratio' && engine.ctx.tokenMeter.measure(agent.session).totalTokens < config.prepareActiveTokens
    ? Math.max(final,Math.floor(config.inputBudget*0.15)) : final
}

// Existing checkpoints participate in the same budget as newly prepared leaves.
// Merely carrying them into a draft neither calls a model nor changes the surface.
export function carryPrefix(engine, agent, from, to) {
  const nodes = agent.session.surface.nodes, parts = []
  for (let i = from; i < to; i++) {
    const seq = nodes[i], event = agent.session.eventAt(seq)
    const marker = markerFromSummary(event.data?.content)
    const node = marker && engine.superLcmStore.getNode(agent.session.id, marker.id)
    if (!node) return []
    const prepared = prepareAsyncRegion(engine, agent, { start: seq, end: seq })
    for (const id of semanticFrontier(engine.superLcmStore, agent.session.id, marker.id)) {
      const member = engine.superLcmStore.getNode(agent.session.id, id)
      parts.push({ ...prepared, summary: member.summary,
        checkpointMessage: { ...event.data, content: [event.data.content[0], ...member.summary, event.data.content.at(-1)] },
        provider: member.provider, model: member.model,
        trustedChildNodeIds: [id], depth: nodeLevel(engine.superLcmStore, agent.session.id, id), carried: true })
    }
  }
  return parts
}

export function draftNode(part) {
  return { nodeId: markerFromSummary(part.summary).id, summary: part.summary,
    kind: part.treeKind ?? 'leaf',
    sourceSeqs: part.shadowedSeqs, childIds: part.trustedChildNodeIds,
    shadowedTokenCount: part.shadowedTokenCount, provider: part.provider ?? null, model: part.model ?? null }
}

export function draftTokens(engine, agent, frontier) {
  if (!frontier.length) return 0
  const factor = selectionPricing(engine.ctx.tokenMeter.measure(agent.session), agent.session.requestHeader()).factor
  return Math.ceil(engine.ctx.tokenMeter.estimateMessage(assembledCheckpointMessage(frontier).checkpointMessage) * factor)
}

function mergeGroup(frontier, fanout, overBudget, config, tokens) {
  for (let i = 0; i < frontier.length;) {
    let end = i + 1
    while (end < frontier.length && frontier[end].depth === frontier[i].depth) end++
    if (end - i >= fanout && (overBudget || (!config.routineMaxDepth || frontier[i].depth <= config.routineMaxDepth)
      && (!config.condensedMinSourceTokens || tokens(frontier.slice(i,i+fanout)) >= config.condensedMinSourceTokens))) return [i, i + fanout]
    i = end
  }
  // Budget pressure can merge uneven levels or condense one oversized summary.
  // Waiting for four equal-depth siblings would leave large old roots stuck.
  return overBudget && frontier.length ? [0, Math.min(frontier.length, fanout)] : null
}

export async function buildDraftTree(engine, agent, previous, leaf, signal, suffix = [], beforeMerge = () => {}) {
  const depth = leaf ? 1 + Math.max(0, ...leaf.trustedChildNodeIds.map(id => nodeLevel(engine.superLcmStore, agent.session.id, id))) : 0
  let frontier = [...(previous?.frontier ?? previous?.parts ?? []), ...(leaf ? [{ ...leaf, depth }] : []), ...suffix]
  const tree = [...(previous?.tree ?? []), ...(leaf ? [draftNode(leaf)] : [])]
  const config = currentPolicy(engine, agent)
  if (!config) throw Error('聊天模型已改变，准备的摘要需要重新核对')
  const target = draftBudget(engine,agent)
  const fanout = Math.max(2, config.condensedMinFanout)
  const tokens = parts => draftTokens(engine,agent,parts)
  const save = () => {
    const state = engine.backgroundFolds.get(agent)
    if (state && state.generation === engine.runtimeGeneration && currentPolicy(engine,agent)?.signature === state.signature) {
      const parts = [...(previous?.parts ?? []), ...(leaf ? [leaf] : [])]
      const ready = {...state,status:'ready',parts,frontier:[...frontier],tree:[...tree],summarized:assembleTree(engine,frontier,tree,parts.length)}
      state.recoveryReady = ready
      saveDraft(engine, agent, ready)
    }
  }
  save()
  const mergeLimit = frontier.length + 12
  for (let pass = 0; pass < mergeLimit; pass++) {
    const group = mergeGroup(frontier, fanout, tokens(frontier) > target, config, tokens)
    if (!group) return { frontier, tree }
    signal.throwIfAborted()
    if (currentPolicy(engine,agent)?.signature !== config.signature) throw Error('聊天模型已改变')
    const [from, to] = group, parts = frontier.slice(from, to)
    const coverage = assembleRegions(engine, parts)
    const inputTokens = engine.ctx.tokenMeter.estimateMessage(assembledCheckpointMessage(parts).checkpointMessage)
    const system = (leaf?.input ?? frontier.at(-1).input).messages.filter(message => message.role === 'system')
    beforeMerge()
    const merged = await summarizeAsyncRegion(engine, agent, { ...coverage,
      input: { messages: [...system, ...parts.map(part => createUserMessage({ content: [{type:'text',text:`Historical snapshot, recall node ${markerFromSummary(part.summary).id}. Physical source range #${part.start}–#${part.end}; use node ancestry for original sources.`},...plainSummaryBlocks(part.summary)] }))] },
      trustedChildNodeIds: parts.map(part => markerFromSummary(part.summary).id),
      summaryDepth: Math.max(...parts.map(part=>part.depth)),
      summaryTargetTokens: Math.max(256,Math.floor(config.budgetMode==='ratio' ? Math.min(target/fanout/2,inputTokens/2) : target/fanout/2)),
    }, signal)
    if (engine.ctx.tokenMeter.estimateMessage(merged.checkpointMessage) >= inputTokens) {
      engine.superLcmStore.blockSummary(agent.session.id,merged.attemptKey)
      const error=Error('summary tree merge made no progress');error.code='SUPERLCM_SUMMARY_NO_PROGRESS';throw error
    }
    merged.depth = 1 + Math.max(...parts.map(part => part.depth))
    merged.treeKind = 'condensed'
    tree.push(draftNode(merged))
    frontier = [...frontier.slice(0, from), merged, ...frontier.slice(to)]
    save()
  }
  if (!mergeGroup(frontier, fanout, tokens(frontier) > target, config, tokens)) return { frontier, tree }
  throw Error('summary tree did not reach its budget after bounded progressive merges')
}

export function assembleTree(engine, frontier, tree, batchCount) {
  const summarized = assembleRegions(engine, frontier)
  // The final root can itself be a previously merged draft. Do not index it twice.
  return { ...summarized, preparedTree: tree.filter(node => node.nodeId !== markerFromSummary(summarized.summary).id),
    summaryTreeKind: frontier.length === 1 ? frontier[0].treeKind ?? 'leaf' : 'assembled',
    preparedBatchCount: batchCount, summaryTreeDepth: Math.max(...frontier.map(part => part.depth)),
    trustedChildNodeIds: frontier.length === 1 ? frontier[0].trustedChildNodeIds : frontier.map(part => markerFromSummary(part.summary).id) }
}
