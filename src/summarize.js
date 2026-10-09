import {legacyDshSource} from './dsh-evidence.js'
import { profileKey, readSummaryProfile, updateSummaryProfile, visibleOutputRoom, adaptiveSummaryTask, repairSummaryPrompt, fitSummary, isReducedSummary, reducedNotice } from './summary-generation.js'
import { readOpenAICompletion, summaryFailure, STREAM_COMPLETE } from './summary-response.js'
import { createHash, randomUUID } from 'node:crypto'
import { summaryEvents } from './summary-source.js'
import {selectSummaryMerge,mergeContent} from './summary-merge.js'
import { nodeId } from './store.js'
import { normalizeApiEndpoint, loopbackEndpoint, EFFORTS } from './api-endpoint.js'
import { MAX_SUMMARY_INPUT } from './runtime.js'
import { SUMMARY_POLICY_VERSION, SUMMARY_SYSTEM, buildSummaryPrompt, summaryInstructions, checkedSummary } from './summary-policy.js'
import { estimateSummaryTokens,takeTokenPrefix,takeTokenSuffix } from './summary-tokens.js'
const hash = value => createHash('sha256').update(value).digest('hex')
const head = (text, chars) => String(text || '').replace(/\s+/g,' ').slice(0,chars)
const THINKING={low:2048,medium:6144,high:16384,xhigh:32768}
export async function summarizeWithModel(text, { model, apiKey, baseURL, apiURL, apiProvider='anthropic', effort=null, fetchImpl=fetch, timeoutMs=90000, summaryTask={}, profileStore, onQuality, shouldContinue } = {}) {
  const endpoint=normalizeApiEndpoint(apiProvider,apiURL||baseURL||(apiProvider==='openai'?'https://api.openai.com':'https://api.anthropic.com'))
  if (!model || (!apiKey && !loopbackEndpoint(endpoint))) throw new Error('Explicit summary model ID and API credential required; no agent fallback')
  if (effort!==null && !EFFORTS.includes(effort)) throw new Error('Unknown reasoning effort')
  const openai=apiProvider==='openai', key=profileKey(endpoint,model,effort), profile=readSummaryProfile(key,profileStore)
  const task=adaptiveSummaryTask(summaryTask,profile), visible=visibleOutputRoom(text)
  const signal=AbortSignal.timeout(timeoutMs)
  let reasoningRoom=Math.max(THINKING[effort]||0,profile.reasoning_room), retried=false, completionParam='max_tokens'
  const headers=openai?{'content-type':'application/json',...(apiKey?{authorization:`Bearer ${apiKey}`}:{})}:{'content-type':'application/json',...(apiKey?{'x-api-key':apiKey}:{}),'anthropic-version':'2023-06-01'}
  const detail=async r=>{try{return (await r.text()).replace(/\s+/g,' ').slice(0,300)}catch{return ''}}
  const generate=async prompt=>{
    for (;;) {
      signal.throwIfAborted()
      if(shouldContinue&&!shouldContinue())throw Error('Summary setting changed; additional generation cancelled')
      const cap=Math.min(49152,visible+reasoningRoom)
      const body={model,[completionParam]:cap,messages:[{role:'user',content:prompt}]}
      if(openai&&effort)body.reasoning_effort=effort
      if(!openai&&THINKING[effort])body.thinking={type:'enabled',budget_tokens:THINKING[effort]}
      const post=async()=>{
        signal.throwIfAborted()
        if(shouldContinue&&!shouldContinue())throw Error('Summary setting changed; additional generation cancelled')
        try{return await fetchImpl(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal})}
        catch{throw summaryFailure(signal.aborted?'Summary request timed out':'Summary request transport failed',model,null)}
      }
      let response=await post()
      if(!response.ok&&openai&&response.status===400){
        const why=await detail(response)
        if(completionParam!=='max_tokens'||!/max_completion_tokens|max_tokens/.test(why))throw summaryFailure('Summarization HTTP 400: request rejected; check model and endpoint configuration',model,null)
        completionParam='max_completion_tokens';body.max_completion_tokens=body.max_tokens;delete body.max_tokens;response=await post()
      }
      if(!response.ok)throw summaryFailure(`Summarization HTTP ${Number.isSafeInteger(response.status)?response.status:0}: request failed; check endpoint, credential and model configuration`,model,null)
      let result
      try { result=openai?await readOpenAICompletion(response,model):await response.json() }
      catch(error){if(error.summaryDiagnostic)throw error;throw summaryFailure('Malformed summary response; original content retained',model,null)}
      if(!result||typeof result!=='object')throw summaryFailure('Malformed summary response; original content retained',model,null)
      const choice=result.choices?.find(c=>c.index===0)??result.choices?.[0]
      const output=openai?choice?.message?.content:result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')
      const summary=typeof output==='string'?output:Array.isArray(output)?output.filter(x=>x?.type==='text').map(x=>x.text).join('\n'):''
      const finishReason=openai?choice?.finish_reason:result.stop_reason
      const number=n=>Number.isSafeInteger(n)&&n>=0?Math.min(10000000,n):0
      const evidence={reasoning_tokens:number(result.usage?.completion_tokens_details?.reasoning_tokens),completion_tokens:number(result.usage?.completion_tokens)}
      const reasoningSeen=openai&&(evidence.reasoning_tokens>0||result.reasoningSeen||choice?.message?.reasoning_content||choice?.message?.reasoning)
      const incomplete=['length','max_tokens','max_output_tokens'].includes(finishReason)
      if(reasoningSeen) {
        const room=Math.min(32768,Math.max(reasoningRoom,evidence.reasoning_tokens+2048,incomplete?Math.max(8192,cap*2):2048))
        updateSummaryProfile(key,{reasoning_room:room},profileStore)
        if(incomplete&&!retried&&visible+room>cap){retried=true;reasoningRoom=room;continue}
        reasoningRoom=room
      }
      try {
        if(finishReason==null&&!(openai&&result[STREAM_COMPLETE]))throw Error('Summary generation was incomplete; no terminal finish reason, original content retained')
        if(finishReason!=null&&!['stop','end_turn','stop_sequence'].includes(finishReason))throw Error('Summary generation was incomplete or used an unsupported finish reason; original content retained, retry required')
        return checkedSummary(summary,{finishReason,maxChars:null})
      }catch(error){throw summaryFailure(error.message,model,finishReason,evidence)}
    }
  }
  const initial=await generate(SUMMARY_SYSTEM+'\n\n'+buildSummaryPrompt(text,task))
  return fitSummary(initial,draft=>generate(repairSummaryPrompt(draft,task)),{task,onQuality,onOvershoot:overshoot=>updateSummaryProfile(key,{overshoot},profileStore)})
}
// Deterministic work planner shared by background workers and in-conversation agents.
// Merges come first so the layered outline grows while the conversation is still running.
const visibleEvent = e => e.summaryText.trim()
// Token budgets include the rendered record labels; saved character settings
// remain supported. The message cap is only a wide safety net, not a trigger
// for lots of small summaries.
// SUPERLCM_SEGMENT_MESSAGES lowers it for tests with tiny fixtures.
export const segmentMessages = (env = process.env) => { const n = Number(env.SUPERLCM_SEGMENT_MESSAGES); return Number.isSafeInteger(n) && n >= 2 && n <= 10000 ? n : 10000 }
export const summaryLimits = { targetTokens: 20000, fanout: 4 }
const textLength = e => e.summaryText.length
const eventPrefix=e=>`[event ${e.ordinal}] `
const budgetFor=(saved,options={})=>{
  const tokens=options.targetTokens===undefined?(options.targetChars===undefined?saved.target_tokens:null):options.targetTokens
  return tokens!=null?{target:tokens,tokens:true}:{target:options.targetChars??saved.target_chars,tokens:false}
}
// Index of the last event in the segment starting at `from`, or -1 while the segment is still open.
// A segment closes before the message that would push it past the target, so it never exceeds the
// target unless one message alone is longer (that message then forms its own segment).
function segmentEnd(events, from, budget, batchSize) {
  let size = 0, count = 0
  for (let i = from; i < events.length; i++) {
    if (!visibleEvent(events[i])) continue
    const len = budget.tokens?estimateSummaryTokens(eventPrefix(events[i])+events[i].summaryText+'\n'):textLength(events[i])
    if (count && size + len > budget.target) return i - 1
    size += len; count++
    if (size >= budget.target || count >= batchSize) return i
  }
  return -1
}
// Full text of one record; only a record longer than the whole segment keeps its head and tail.
function recordText(e, budget) {
  const text = e.summaryText
  if(budget.tokens) {
    const target=budget.target-estimateSummaryTokens(eventPrefix(e)+'\n')
    if(estimateSummaryTokens(text)<=target)return text
    const marker=` …[middle omitted; lcm_read event ${e.ordinal} for the full text]… `
    const room=target-estimateSummaryTokens(marker),headBudget=Math.floor(room*0.6)
    return takeTokenPrefix(text,headBudget)+marker+takeTokenSuffix(text,room-headBudget)
  }
  const targetChars=budget.target
  if (text.length <= targetChars) return text
  const keep = targetChars - 200, headLen = Math.ceil(keep * 0.6)
  return text.slice(0, headLen) + ` …[${text.length - keep} characters omitted; lcm_read event ${e.ordinal} for the full text]… ` + text.slice(text.length - (keep - headLen))
}
export function summaryWork(store, session, options = {}) {
  if (!store.source(session)) throw new Error('Unknown session')
  if(legacyDshSource(store.db,session))return null
  const saved = store.tuning()
  const { batchSize = segmentMessages(), fanout = saved.fanout } = options
  const budget=budgetFor(saved,options)
  for (let level = 1; level <= 12; level++) {
    const lower = store.nodeRows(session, level - 1)
    if (lower.length < fanout) break
    const owned = new Set(store.nodeRows(session, level).flatMap(n => JSON.parse(n.children)))
    const batch=selectSummaryMerge(lower,owned,{fanout,targetTokens:budget.tokens?budget.target:null})
    if(!batch)continue
    const digest = hash(JSON.stringify([SUMMARY_POLICY_VERSION,...batch.map(n => [n.id,n.digest,hash(n.summary)])]))
    const content = mergeContent(batch)
    if (content.length > MAX_SUMMARY_INPUT) throw new Error('Complete child summaries exceed the input limit; refusing to truncate them')
    const task = { reducedSources:batch.some(n=>isReducedSummary(n.summary)), level, kind:'condensed', first:batch[0].first, last:batch.at(-1).last,
      ...(budget.tokens?{targetTokens:Math.max(128,Math.min(1200,Math.floor(estimateSummaryTokens(content)/2)))}:{}) }
    const sources=store.metadata(session).harness==='dsh'?store.db.prepare('SELECT DISTINCT seq FROM dsh_node_sources WHERE session=? AND id IN ('+batch.map(()=>'?').join(',')+') ORDER BY seq').all(session,...batch.map(n=>n.id)).map(r=>r.seq):undefined
    return { session, batch_id: nodeId(session, level, task.first, task.last, digest), ...task, children: batch.map(n => n.id), digest,source_records:sources,
      content, notice:summaryInstructions(task), policy_version:SUMMARY_POLICY_VERSION }
  }
  const done = store.nodeRows(session, 0)
  const start = done.length ? Math.max(...done.map(n => n.last)) + 1 : 0
  const events = summaryEvents(store, session, start)
  const end = segmentEnd(events, 0, budget, batchSize)
  if (end < 0) return null // wait for a complete batch; the unsummarized tail stays readable as raw events
  const batch = events.slice(0, end + 1), digest = hash(JSON.stringify([SUMMARY_POLICY_VERSION,...batch.map(e => e.digest)]))
  const base = { session, batch_id: nodeId(session, 0, batch[0].ordinal, batch.at(-1).ordinal, digest), level: 0, first: batch[0].ordinal, last: batch.at(-1).ordinal, children: [], digest,
    ...(store.metadata(session).harness==='dsh'?{source_records:batch.filter(visibleEvent).map(e=>e.ordinal)}:{}) }
  const previous=done.filter(n=>n.last<base.first).at(-1)
  const task={...base,kind:'leaf',policy_version:SUMMARY_POLICY_VERSION,
    ...(previous?{previousSummary:`[${previous.id}, events ${previous.first}-${previous.last}]\n${previous.summary}`}:{})}
  // The conversation's own AI, asked right after this part happened and with no compaction since, still has
  // it in context: send only where it starts and ends instead of the text again.
  if (options.recent && batch[0].ordinal >= store.lastCompaction(session)) {
    const shown = batch.filter(visibleEvent), anchor = e => ({ event: e.ordinal, text: head(e.summaryText, 160) })
    return { ...task, from_memory: true, starts: anchor(shown[0]), ends: anchor(shown.at(-1)), messages: shown.length,
      notice: summaryInstructions(task)+'\nFrom memory: use only this source range in your own context, identified by starts and ends. If any required detail is uncertain or absent, use lcm_read instead of guessing.' }
  }
  return { ...task,
    content: batch.filter(visibleEvent).map(e => eventPrefix(e)+recordText(e, budget)).join('\n'),
    notice: summaryInstructions(task)+'\nUse lcm_read when a truncated excerpt needs verification.' }
}
// Dry-run estimate of a background pass: how many records it covers and how many model calls it makes.
export function summaryEstimate(store, session, options={}) {
  const tuning=store.tuning(),{fanout}=tuning,budget=budgetFor(tuning,options)
  const done = store.nodeRows(session, 0)
  const start = done.length ? Math.max(...done.map(n => n.last)) + 1 : 0
  const events = summaryEvents(store, session, start)
  let segments = 0, from = 0
  for (let end; (end = segmentEnd(events, from, budget, options.batchSize??segmentMessages())) >= 0; from = end + 1) segments++
  const pending = events.length - from, chars = events.slice(from).filter(visibleEvent).reduce((a, e) => a + textLength(e), 0), records = from
  let calls = segments, below = done.length + segments
  for (let level = 1; level <= 12 && below >= fanout; level++) {
    const total = Math.floor(below / fanout)
    calls += Math.max(0, total - store.nodeRows(session, level).length)
    below = total
  }
  if(!segments&&!summaryWork(store,session,options))calls=0
  const tokens=events.slice(from).filter(visibleEvent).reduce((a,e)=>a+estimateSummaryTokens(eventPrefix(e)+e.summaryText+'\n'),0)
  return { records, segments, calls, tail: pending, tail_chars: chars, tail_tokens:tokens, target_chars:tuning.target_chars,target_tokens:tuning.target_tokens??null,tokens_estimated:true,calls_upper_bound:budget.tokens }
}
export function summarySettingsRevision(store, session, env = process.env) {
  const setting = store.effectiveSetting(session, env)
  return hash(JSON.stringify([setting,store.tuning(),store.integrationRevision(setting.harness), setting.mode === 'api' ? store.apiCredential(session, env) : null]))
}
export async function buildHierarchy(store, session, { model, apiKey, baseURL, apiURL, apiProvider, effort = null, batchSize = segmentMessages(), targetChars, targetTokens, fanout = store.tuning().fanout, summarize = summarizeWithModel, fetchImpl, shouldContinue = null, leaseDurationMs = 330000, leaseHeartbeatMs = 30000 } = {}) {
  if (!model || (apiKey == null && summarize === summarizeWithModel)) throw new Error('Explicit summarizer model and API key required')
  if (!Number.isSafeInteger(batchSize) || batchSize < 2 || batchSize > 10000) throw new Error('batchSize must be 2–10000')
  if (!Number.isSafeInteger(fanout) || fanout < 2 || fanout > 8) throw new Error('fanout must be 2–8')
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 20 || !Number.isSafeInteger(leaseHeartbeatMs) || leaseHeartbeatMs < 1 || leaseHeartbeatMs >= leaseDurationMs) throw new Error('Invalid summary lease timing')
  const owner = `worker:${process.pid}:${randomUUID()}`
  const revision = summarySettingsRevision(store, session)
  const mayContinue = shouldContinue || (() => summarySettingsRevision(store, session) === revision)
  if (!store.lease(session, leaseDurationMs, owner)) return { session, busy:true }
  let created = 0
  let lostLease = false
  const checkLease = () => { if (lostLease || !store.ownsLease(session, owner)) throw new Error('Summary writer lost its lease; result not saved') }
  const timer = setInterval(() => {
    try { if (!store.renewLease(session, leaseDurationMs, owner)) lostLease = true }
    catch { lostLease = true }
  }, leaseHeartbeatMs)
  timer.unref()
  try {
    for (let work; (work = summaryWork(store, session, { batchSize, targetChars,targetTokens, fanout })); ) {
      if (!mayContinue()) return { session, created, stopped: 'settings-changed' }
      checkLease()
      // Fail closed if the on-disk original changed after indexing or during model execution.
      const verify = () => { if (work.level === 0) for (let i = work.first; i <= work.last; i++) store.exact(session, i) }
      verify()
      const cliKey=profileKey('cli',model,null),task=summarize===summarizeWithModel?work:adaptiveSummaryTask(work,readSummaryProfile(cliKey,store))
      const options={model,apiKey,baseURL,apiURL,apiProvider,effort,fetchImpl,profileStore:store,shouldContinue:()=>{checkLease();return mayContinue()},summaryTask:{...task,allowOversize:true}}
      const generateCli=async(content,repairDraft=false)=>{
        checkLease()
        if(!mayContinue())throw Error('Summary setting changed; additional generation cancelled')
        return summarize(content,{...options,summaryTask:{...options.summaryTask,repairDraft}})
      }
      let summary = summarize===summarizeWithModel ? await summarize(work.content,options) : await fitSummary(await generateCli(work.content),draft=>generateCli(draft,true),{task,onOvershoot:overshoot=>updateSummaryProfile(cliKey,{overshoot},store)})
      if(work.reducedSources&&!isReducedSummary(summary))summary=checkedSummary(reducedNotice(work)+'\n'+summary.slice(0,5600))
      checkLease()
      if (!mayContinue()) return { session, created, stopped: 'settings-changed' }
      verify()
      store.addNode({ session, id: work.batch_id, level: work.level, first: work.first, last: work.last, children: work.children, summary, digest: work.digest, model,sourceRecords:work.source_records }, { leaseOwner: owner,validate:mayContinue })
      if (!store.renewLease(session, leaseDurationMs, owner)) throw new Error('Summary writer lost its lease')
      created++
    }
    return { session, created, overview: store.overview(session) }
  } finally { clearInterval(timer); store.release(session, owner) }
}
