import { Buffer } from 'node:buffer'

export const MARKER_VERSION = 1
export const MARKER_PREFIX = 'dsh-lcm:v1:'
const MARKER_RE = /<!--\s*dsh-lcm:v1:([A-Za-z0-9_-]+)\s*-->/g
const VISIBLE_RE = /\n?(?:\[SuperLcm:[^\]]+\]|\[SuperLcm recall node [^\]]+\]|\[Lossless recall node [^\]]+\]|\[LCM:[^\]]+\])\n?/g

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))]
}

function assertNodeId(value, label = 'node id') {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new TypeError(`${label} must be an ASCII identifier between 8 and 128 characters`)
  }
  return value
}

export function encodeMarker({ id, children = [] }) {
  const payload = {
    v: MARKER_VERSION,
    id: assertNodeId(id),
    children: uniqueStrings(children).map(child => assertNodeId(child, 'child id')),
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `<!-- ${MARKER_PREFIX}${encoded} -->`
}

export function decodeMarkerPayload(encoded) {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (parsed?.v !== MARKER_VERSION) return null
    return {
      id: assertNodeId(parsed.id),
      children: uniqueStrings(Array.isArray(parsed.children) ? parsed.children : [])
        .map(child => assertNodeId(child, 'child id')),
    }
  } catch {
    return null
  }
}

export function extractMarkersFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const markers = []
  MARKER_RE.lastIndex = 0
  for (const match of text.matchAll(MARKER_RE)) {
    const marker = decodeMarkerPayload(match[1])
    if (marker !== null) markers.push(marker)
  }
  return markers
}

function visitStrings(value, visit, seen) {
  if (typeof value === 'string') {
    visit(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, visit, seen)
    return
  }
  for (const item of Object.values(value)) visitStrings(item, visit, seen)
}

export function extractMarkers(value) {
  const byId = new Map()
  visitStrings(value, text => {
    for (const marker of extractMarkersFromText(text)) byId.set(marker.id, marker)
  }, new WeakSet())
  return [...byId.values()]
}

export function extractChildNodeIds(value) {
  return uniqueStrings(extractMarkers(value).map(marker => marker.id))
}

export function contentBlocksToText(blocks) {
  const parts = []
  const seen = new WeakSet()

  function visit(value) {
    if (typeof value === 'string') {
      parts.push(value)
      return
    }
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value.text === 'string') {
      parts.push(value.text)
      return
    }
    if ('content' in value) visit(value.content)
  }

  visit(blocks)
  return parts.join('\n')
}

export function stripRecallMetadata(text) {
  if (typeof text !== 'string') return ''
  MARKER_RE.lastIndex = 0
  return text.replace(MARKER_RE, '').replace(VISIBLE_RE, '\n').trim()
}

export function appendRecallEnvelope(blocks, { id, children = [] }) {
  if (!Array.isArray(blocks)) throw new TypeError('summary must be an array of content blocks')
  const marker = encodeMarker({ id, children })
  const childLabel = children.length === 0 ? '0' : `${children.length}`
  const text = [
    '',
    `[SuperLcm:${id}; children=${childLabel}; exact=lcm_expand]`,
    marker,
  ].join('\n')
  return [...blocks, { type: 'text', text }]
}

export function markerFromSummary(summary) {
  const markers = extractMarkers(summary)
  return markers.length === 0 ? null : markers[markers.length - 1]
}
