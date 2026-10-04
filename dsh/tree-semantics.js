import { isDeepStrictEqual } from 'node:util'
import { stripRecallMetadata } from './marker.js'

const withoutEnvelope = blocks => blocks.flatMap(block => {
  if (block.type !== 'text') return [block]
  const value = stripRecallMetadata(block.text)
  return value ? [{ ...block, text: value }] : []
})

export function isTransparentAssembly(summary, childSummaries) {
  return isDeepStrictEqual(withoutEnvelope(summary), childSummaries.flatMap(withoutEnvelope))
}

// An envelope is not another summarization. Older releases labelled envelopes
// as condensed; recognize them only by reproducing their exact concatenation.
export function semanticKind(store, sessionId, id) {
  const node = store.getNode(sessionId, id)
  if (!node) throw Error('missing summary tree node: ' + id)
  if (node.childIds.length > 1) {
    const children = node.childIds.map(child => store.getNode(sessionId, child))
    if (children.every(Boolean)) {
      if (isTransparentAssembly(node.summary, children.map(child => child.summary))) return 'assembled'
    }
  }
  if (node.kind === 'assembled') throw Error('assembled summary does not match its members')
  return node.childIds.length ? 'condensed' : 'leaf'
}

export function semanticFrontier(store, sessionId, id, seen = new Set()) {
  if (seen.has(id)) throw Error('summary tree cycle')
  if (semanticKind(store, sessionId, id) !== 'assembled') return [id]
  const next = new Set([...seen, id])
  return store.getNode(sessionId, id).childIds.flatMap(child => semanticFrontier(store, sessionId, child, next))
}

export function semanticLevel(store, sessionId, id) {
  const memo = new Map(), seen = new Set()
  const visit = key => {
    if (memo.has(key)) return memo.get(key)
    if (seen.has(key)) throw Error('summary tree cycle')
    seen.add(key)
    const node = store.getNode(sessionId, key)
    if (!node) throw Error('missing summary tree node: ' + key)
    const lower = Math.max(0, ...node.childIds.map(visit))
    const value = semanticKind(store, sessionId, key) === 'assembled' ? lower : lower + 1
    seen.delete(key); memo.set(key, value); return value
  }
  return visit(id)
}
