import { createHash } from 'node:crypto'
import { currentPolicy, requestIdentity } from './ratio-runtime.js'
import { locateStableSpan } from './async-region.js'
import { SessionFoldRegistry } from './summary-guards.js'

const key = (engine, agent) => createHash('sha256').update(JSON.stringify([
  engine.rollingConfig, engine.summaryRouteFingerprint(), engine.controlRevision ?? '',
  currentPolicy(engine, agent)?.signature ?? requestIdentity(agent),
])).digest('hex')
export function saveDraft(engine, agent, state) {
  if (state.status !== 'ready') return
  const value = Object.fromEntries(['parts','frontier','tree','summarized','selection','cutoffEnd','revision','signature'].map(name => [name,state[name]]))
  // Originals already live in the durable session archive. Keep exact selected
  // node snapshots for validation, but don't duplicate model input transcripts.
  engine.superLcmStore.saveDraft(agent.session.id, key(engine,agent), JSON.stringify(value,(name,value) => ['input','rawOutput'].includes(name) ? undefined : value))
}
export function restoreDraft(engine, agent) {
  if (!currentPolicy(engine, agent) || engine.backgroundFolds.has(agent)) return false
  engine.draftRestoreAttempts ??= new SessionFoldRegistry()
  const fingerprint = key(engine,agent)
  if (engine.draftRestoreAttempts.get(agent) === fingerprint) return false
  engine.draftRestoreAttempts.set(agent,fingerprint)
  const row = engine.superLcmStore.loadDraft(agent.session.id)
  if (!row || row.fingerprint !== fingerprint) return false
  try {
    const state = JSON.parse(row.data)
    locateStableSpan(engine, agent.session, state.summarized)
    const system = agent.session.surface.nodes.map(seq => agent.session.eventAt(seq))
      .filter(event => event.type === 'system/message').map(event => agent.session.deriveEventMessage(event)).filter(Boolean)
    for (const part of [...state.frontier,...state.parts]) part.input = {messages:system}
    state.status = 'ready'; state.generation = engine.runtimeGeneration
    engine.backgroundFolds.set(agent,state)
    engine.compressionReporter.report(agent.session.id,'ready',state.summarized)
    return true
  } catch {
    engine.superLcmStore.finishDraft(agent.session.id,'discarded')
    return false
  }
}
export function finishDraft(engine, agent) { engine.superLcmStore.finishDraft(agent.session.id,'committed') }
