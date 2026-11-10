import {cappedRecentKeep} from './recent-retention.js'
import { createHash } from 'node:crypto'
import { estimateSummaryTokens } from './summary-tokens.js'
import { estimatePiRequest, measuredPiContextTokens } from './pi-request.js'

export const piDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const dialogueRoles = new Set(['user', 'assistant', 'toolResult', 'bashExecution', 'custom', 'branchSummary', 'compactionSummary'])
const visibleMessage = m => m.role !== 'bashExecution' || !m.excludeFromContext
export const dialogueMessage = m => dialogueRoles.has(m.role) && visibleMessage(m)
// Keep complete text and tool failure evidence. Binary content remains archived.
export function serializePiMessages(messages) {
  const blocks = content => typeof content === 'string' ? content : (content || []).map(block => {
    if (block.type === 'text') return block.text || ''
    if (block.type === 'toolCall') return `[Tool call ${block.name}; id=${block.id}; requested, not completed]\n${JSON.stringify(block.arguments)}`
    if (['thinking', 'redactedThinking'].includes(block.type)) return ''
    return `[${block.type || 'non-text'} block preserved in original archive]`
  }).filter(Boolean).join('\n')
  return messages.filter(visibleMessage).map((m, i) => {
    const shell = m.role === 'bashExecution' ? `[Command]\n${m.command || ''}\n[Output]\n${m.output || '(no output)'}\n[Exit code: ${m.exitCode ?? 'not reported'}; cancelled: ${!!m.cancelled}; truncated: ${!!m.truncated}]${m.fullOutputPath ? '\n[Full output: ' + m.fullOutputPath + ']' : ''}` : null
    return `[Pi message ${i}; ${m.role}; ${m.isError ? 'ERROR / failed' : 'read result for outcome'}${m.toolCallId ? '; toolCallId=' + m.toolCallId : ''}]\n${shell ?? (m.summary || blocks(m.content))}`
  }).join('\n\n')
}
const view = entries => entries.map(e => ({ id: e.sourceEntry.id, messages: e.messages }))
export const estimatePiMessages=(messages,model)=>Math.max(estimateSummaryTokens(serializePiMessages(messages)),estimatePiRequest(messages,{history:messages,model}))
// Pi 1.5 persists system prompts and tool declarations inside the projection.
// Pi retains that state across compaction; it is fixed overhead, not dialogue
// that the background branch may replace with a historical summary.
export const piDialogueMessages=entries=>entries.flatMap(e=>e.messages.filter(dialogueMessage))
export const snapshotPrefix = (entries, index) => piDigest(view(entries.slice(0, index)))
export function piSignature(ctx, policy, settings = {}) {
  return piDigest([policy, ctx.model?.provider, ctx.model?.id, ctx.model?.contextWindow, ctx.model?.maxTokens, ctx.model?.api, ctx.model?.baseUrl, settings.thinkingLevel, settings.compaction, !!settings.images?.blockImages])
}
export function snapshotMatches(snapshot, entries, signature) {
  const cut = entries.findIndex(e => e.sourceEntry.id === snapshot.firstKeptEntryId)
  return snapshot.signature === signature && cut > 0 && snapshotPrefix(entries, cut) === snapshot.prefixDigest
}
// Only cut before a user/assistant message with no pending tool results. This
// also supports a long autonomous turn without splitting an invocation/result pair.
export function makePiSnapshot(ctx, policy, settings = {}, {keepLimit=Infinity,sourceLimit=Infinity,firstKeptEntryId,beforeFirstKeptEntryId}={}) {
  const entries = ctx.sessionManager.buildSessionProjection().entries
  const sizes = entries.map(e => estimatePiMessages(piDialogueMessages([e]),ctx.model))
  const totalDialogue = sizes.reduce((a,b)=>a+b,0)
  const requestedKeep = policy.keep === undefined ? Math.max(512, settings.compaction?.keepRecentTokens ?? 20000) : cappedRecentKeep(policy.keep, totalDialogue)
  // In main-fork mode, preparation starts at ratio - 10% and runs in the background
  // while the foreground continues to accumulate up to 10% of the window before
  // replacement. Reserve only a small floor at the cut point when still below the
  // replacement threshold so the post-compaction tail does not double-retain.
  const uTokens = ctx.getContextUsage?.()?.tokens, uWindow = ctx.model?.contextWindow
  const naturalGrowthBuffer = policy.summaryMode === 'main-fork' && Number.isFinite(uWindow) && uWindow > 0 && Number.isFinite(uTokens) && uTokens < uWindow * (policy.ratio ?? .8)
    ? Math.max(0, Math.floor(uWindow * (policy.ratio ?? .8) - uTokens)) : 0
  const effectiveKeep = naturalGrowthBuffer > 0 ? Math.max(Math.min(requestedKeep, 10000), requestedKeep - naturalGrowthBuffer) : requestedKeep
  const keep=Math.min(effectiveKeep,keepLimit)
  let retain = 0, desired = entries.length
  for (let i = entries.length - 1; i >= 0; i--) {
    const newer=retain;retain+=sizes[i]
    if(retain>=keep){desired=newer>0&&keep-newer<retain-keep?i+1:i;break}
  }
  if (desired === entries.length) return null
  const pending = new Set(),safeCuts=[]; let cut = -1
  for (let i = 0; i <= desired; i++) {
    const e = entries[i], first = e.messages[0]
    if (i > 0 && !pending.size && e.sourceEntry.type !== 'compaction' && ['user', 'assistant'].includes(first?.role)) {cut = i;safeCuts.push(i)}
    for (const message of e.messages) {
      // A persisted native human turn can abandon an interrupted old call.
      // Custom notifications cannot authorize that boundary.
      if(e.sourceEntry.type==='message'&&message.role==='user')pending.clear()
      if (message.role === 'assistant') for (const block of message.content || []) if (block.type === 'toolCall') pending.add(block.id)
      if (message.role === 'toolResult') pending.delete(message.toolCallId)
    }
  }
  if (cut <= 0) return null
  if(beforeFirstKeptEntryId!==undefined){
    const boundary=entries.findIndex(e=>e.sourceEntry.id===beforeFirstKeptEntryId)
    cut=safeCuts.findLast(i=>i<boundary&&i<=cut)??-1
    if(cut<=0)return null
  }
  // A branch that cannot fit may summarize a smaller complete prefix. Everything
  // after this earlier safe boundary remains verbatim in the foreground.
  if(Number.isFinite(sourceLimit)){
    let total=0,earlier=-1
    for(let i=0;i<=cut;i++){
      if(total<=sourceLimit&&safeCuts.includes(i))earlier=i
      if(i<cut)total+=sizes[i]
    }
    cut=earlier
    if(cut<=0)return null
  }
  if(firstKeptEntryId!==undefined){
    cut=safeCuts.find(i=>i<=cut&&entries[i].sourceEntry.id===firstKeptEntryId)??-1
    if(cut<=0)return null
  }
  // The standalone text API cannot see binary/non-text content. Retain its
  // entire message group instead of claiming that an archive notice is vision.
  if(policy.summaryMode==='api'){
    const unsupported=entries.slice(0,cut).findIndex(e=>e.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>!['text','toolCall','thinking','redactedThinking'].includes(b.type))))
    if(unsupported>=0){cut=safeCuts.filter(i=>i<=unsupported).at(-1)??-1;if(cut<=0)return null}
  }
  const messages = piDialogueMessages(entries.slice(0, cut))
  if (!messages.some(m => !['compactionSummary', 'branchSummary'].includes(m.role))) return null
  const source = serializePiMessages(messages)
  if (!source.trim()) return null
  // A split autonomous turn keeps its latest complete human request verbatim.
  const latestUser = entries.findLastIndex(e => e.messages.some(m => m.role === 'user'))
  const protectedRequest = latestUser >= 0 && latestUser < cut ? serializePiMessages(entries[latestUser].messages.filter(m => m.role === 'user')) : ''
  const measured = measuredPiContextTokens(entries, ctx.model, ctx.getContextUsage?.()?.tokens, ctx.sessionManager.getBranch?.())
  const snapshot = {
    session_id: ctx.sessionManager.getSessionId(), session_file: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId(), firstKeptEntryId: entries[cut].sourceEntry.id,
    tokensBefore: measured || sizes.reduce((a, b) => a + b, 0), source, protectedRequest,
    sourceTokens:estimatePiMessages(messages,ctx.model),
    ...(policy.summaryMode === "main-fork" ? {summaryModel:policy.summaryModel||null,sourceMessages: messages,sourceEntryIds:entries.slice(0,cut).flatMap(e=>piDialogueMessages([e]).map(()=>e.sourceEntry.id)),summaryTuning:{targetTokens:policy.targetTokens||20000,fanout:policy.fanout||4}} : {}),
    prefixDigest: snapshotPrefix(entries, cut), signature: piSignature(ctx, policy, settings),
  }
  snapshot.draftKey = piDigest([snapshot.session_id, snapshot.firstKeptEntryId, snapshot.prefixDigest, snapshot.signature])
  return snapshot
}
