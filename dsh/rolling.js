/**
 * 滚动模式的表面选区策略 / Rolling-mode surface selection for SuperLcm compaction.
 *
 * 前缀稳定策略同时按表面节点数和 Token 预算保留最新原文尾部。
 * The prefix-stable policy keeps a fresh verbatim tail by both surface-node
 * count and token budget. Routine batches may be prepared early, while the engine
 * controls when they enter the active surface and which leading checkpoints freeze.
 */

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function tokenCountOf(node) {
  return Number.isFinite(node?.tokens) ? node.tokens : 0
}

function totalTokenCount(nodes) {
  return nodes.reduce((total, node) => total + tokenCountOf(node), 0)
}

function tailBoundary(pricedNodes, surfaceSeqs, options) {
  const firstFoldableIndex = options.firstFoldableIndex ?? 0
  let keepFromIdx = pricedNodes.length
  let keptNodes = 0
  let keptTokens = 0

  for (let index = pricedNodes.length - 1; index >= firstFoldableIndex; index -= 1) {
    keepFromIdx = index
    keptNodes += 1
    keptTokens += tokenCountOf(pricedNodes[index])
    if (keptNodes >= options.tailCount && keptTokens >= options.minRetainTokens) break
  }

  while (keepFromIdx > firstFoldableIndex && !(options.isBalancedBefore?.(surfaceSeqs[keepFromIdx]) ?? true)) {
    keepFromIdx -= 1
    keptNodes += 1
    keptTokens += tokenCountOf(pricedNodes[keepFromIdx])
  }

  return { keepFromIdx, keptNodes, keptTokens }
}

export function selectRollingRange(pricedNodes, surfaceSeqs, options = {}) {
  if (!Array.isArray(pricedNodes) || pricedNodes.length === 0) return null
  if (!Array.isArray(surfaceSeqs) || surfaceSeqs.length !== pricedNodes.length) {
    throw new Error('rolling selection: token-meter surface does not match the current session surface')
  }

  const tailCount = positiveInteger(options.tailCount, 24)
  const minRetainTokens = nonNegativeInteger(options.minRetainTokens, 32000)
  const foldBatchTokens = positiveInteger(options.foldBatchTokens, 64000)
  const pressureFoldTokens = Math.min(
    positiveInteger(options.pressureFoldTokens, 20000),
    foldBatchTokens,
  )
  const softActiveTokens = positiveInteger(options.softActiveTokens, 160000)
  const hardActiveTokens = Math.max(
    positiveInteger(options.hardActiveTokens, 220000),
    softActiveTokens + 1,
  )
  const activeTokens = nonNegativeInteger(options.activeTokens, totalTokenCount(pricedNodes))
  const hardPressure = activeTokens >= hardActiveTokens
  const firstFoldableIndex = Math.min(
    nonNegativeInteger(options.firstFoldableIndex, 0),
    pricedNodes.length,
  )

  let boundary = tailBoundary(pricedNodes, surfaceSeqs, {
    tailCount,
    minRetainTokens,
    firstFoldableIndex,
    isBalancedBefore: options.isBalancedBefore,
  })

  let tailCountRelaxed = false
  if (boundary.keepFromIdx <= firstFoldableIndex && hardPressure && tailCount > 1) {
    boundary = tailBoundary(pricedNodes, surfaceSeqs, {
      tailCount: 1,
      minRetainTokens,
      firstFoldableIndex,
      isBalancedBefore: options.isBalancedBefore,
    })
    tailCountRelaxed = boundary.keepFromIdx > firstFoldableIndex
  }

  if (boundary.keepFromIdx <= firstFoldableIndex) return null

  let foldTokens = 0
  for (let index = firstFoldableIndex; index < boundary.keepFromIdx; index += 1) {
    foldTokens += tokenCountOf(pricedNodes[index])
  }
  if (foldTokens <= 0) return null

  let reason
  if (hardPressure) {
    reason = 'hard-cap'
  } else if (activeTokens >= softActiveTokens && foldTokens >= pressureFoldTokens) {
    reason = 'soft-cap'
  } else if (foldTokens >= foldBatchTokens) {
    reason = 'background-batch'
  } else {
    return null
  }

  return {
    start: surfaceSeqs[firstFoldableIndex],
    end: surfaceSeqs[boundary.keepFromIdx - 1],
    foldTokens,
    tailNodes: pricedNodes.length - boundary.keepFromIdx,
    tailTokens: boundary.keptTokens,
    tailCountRelaxed,
    activeTokens,
    reason,
  }
}
