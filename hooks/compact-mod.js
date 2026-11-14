import { fitSummary, repairSummaryPromptParts } from '../src/summary-fitting.js'
import { checkedSummary, joinSummaryPrompt } from '../src/summary-policy.js'
import {rescueClaude,discardClaudeRescue} from './claude-rescue.js'
import {bodies} from '../src/claude-live-messages.js'
// A Claude Code module (2.1.286+), two jobs:
// 接管压缩: when the main conversation compacts, SuperLcm answers with its own summaries plus the newest
// messages word for word (see src/compaction.js). Anything unexpected, the setting being off, a subagent, or
// summaries that lag behind, hands the compaction back to Claude Code. When it compacts is Claude Code's
// own threshold, which the console sets (src/takeover.js), except after the cache expired (below). The
// module never calls $.session.compact(): Claude Code skips the calling plugin's hooks there, so that one
// would always be Claude Code's own summary.
// 缓存过期压缩: the main thread's prompt cache lasts an hour after a request last read it. A session left
// idle longer writes its whole context to the cache again on the next prompt, so the module compacts it
// first with /compact ($.command.run, answered by this module's session.compact like a manual one) and
// only the smaller packet is written. One SuperLcm cannot answer is skipped, never handed to Claude Code.
// 回合末压缩: a takeover inside a turn shows its packet in the Claude app as if the person typed it (Claude Code
// streams a module's packet as a plain user message; a /compact goes out as a replay, which the app does not
// draw). So when the next turn would likely cross the threshold, the module compacts at the end of this one with
// /compact, the same way. One still needed inside a turn is answered by the takeover as before.
// 本工具后台写: throttled steps and completed turns write waiting pieces with $.model.complete, on the
// session's own login and without starting another Claude Code; the turn does not wait for it. What is left
// when the session ends, or after a failed call, goes to the separate `claude -p` worker as before.
const cli = ($, command, id, stdin, { flags = [], timeoutMs = 60000 } = {}) => $.process.run(['node', `${$.plugin.root}/src/launch.js`, command, id, ...flags], { stdin: stdin ?? '', timeoutMs })
  .then(r => JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}'))
// Keep SDK capability calls in this module; Claude's loader does not follow
// its $ context into imported helpers. The rescue worker gets plain callbacks.
const rescueHost = $ => ({
  root: $.plugin.root,
  run: (args, options) => $.process.run(args, options),
  usage: () => $.session.usage(),
  model: () => $.session.model(),
  complete: options => $.model.complete(options),
})
const MAX_PIECES = 2000 // a whole backlog in one background run (one at a time per session); turns never wait for it
// $.model.complete sends a string prompt with no cache breakpoint. As blocks, the shared policy and the piece's
// source are cached, so every piece reuses the policy and a retry or re-claim of the same piece reads its source.
// A Claude Code without prompt blocks refuses them; it then gets the same text as one string.
let plainPrompt = false
const hostPrompt = parts => typeof parts === 'string' ? parts : plainPrompt ? joinSummaryPrompt(parts)
  : [{ text: parts.prefix, cache: true }, { text: parts.source, cache: true }, { text: parts.tail + parts.closing }]
const refusedBlocks = error => /model\.complete: takes/.test(String(error?.message))
// $ may only appear at a call site, so $.model.fork cannot be probed. A Claude Code without it throws a
// TypeError on the first fork; this process then stops offering forks and that one goes to `claude --resume`.
let forkMissing = false
const writing = new Map(), ticked = new Map(), ticking = new Set(), ended = new Set(), busy = new Set()
const outputs = new Map()
function live(state) {
  state.controller.signal.throwIfAborted()
  if(state.deadline&&Date.now()>=state.deadline){state.controller.abort(Error('Summary catch-up deadline reached'));state.controller.signal.throwIfAborted()}
}
const timeout = state => { live(state);return state.deadline?Math.max(1,Math.min(60000,state.deadline-Date.now())):60000 }
function limitWriter(state, { deadline = 0, maxPieces = 4, signal } = {}) {
  if(deadline){
    state.deadline=state.deadline?Math.min(state.deadline,deadline):deadline
    state.leafOnly=true;state.remaining=Math.min(state.remaining,maxPieces)
    clearTimeout(state.timer)
    state.timer=setTimeout(()=>state.controller.abort(Error('Summary catch-up deadline reached')),Math.max(0,state.deadline-Date.now()))
  }
  if(signal){
    const cancel=()=>state.controller.abort(Error('Summary catch-up cancelled'))
    if(signal.aborted)cancel()
    else {signal.addEventListener('abort',cancel,{once:true});state.cleanups.push(()=>signal.removeEventListener('abort',cancel))}
  }
}
async function waitModel(request,state) {
  live(state)
  const timer=setTimeout(()=>state.controller.abort(Error('Host summary request timed out')),180000)
  let cancel
  const stopped=new Promise((_,reject)=>{cancel=()=>reject(state.controller.signal.reason);state.controller.signal.addEventListener('abort',cancel,{once:true})})
  try{return await Promise.race([request,stopped])}
  finally{clearTimeout(timer);state.controller.signal.removeEventListener('abort',cancel)}
}
function writeSummaries($, id, options = {}) {
  if(ended.has(id))return Promise.resolve()
  let state=writing.get(id)
  if(state){limitWriter(state,options);return state.run}
  state={controller:new AbortController(),deadline:0,leafOnly:false,remaining:MAX_PIECES,requests:new Set(),cleanups:[],claim:null,timer:null,saving:false}
  limitWriter(state,options)
  writing.set(id,state)
  state.run=writeLoop($,id,state).finally(()=>{
    clearTimeout(state.timer)
    for(const cleanup of state.cleanups)cleanup()
    // A provider can ignore its timeout. Keep the slot until it actually settles,
    // while the compaction caller is already free to fall back at its deadline.
    const cleanup=async()=>{
      if(state.claim)try{await cli($,'summary-release',id,JSON.stringify(state.claim))}catch{}
      if(state.handoff)try{await cli($,'summary-handoff',id,JSON.stringify(state.claim||{}))}catch{}
      if(writing.get(id)===state)writing.delete(id)
    }
    if(state.requests.size)void Promise.allSettled([...state.requests]).then(cleanup)
    else void cleanup()
  })
  return state.run
}
async function writeLoop($, id, state) {
  try {
    while(state.remaining>0) {
      live(state)
      const flags=[...(state.leafOnly?['--leaf']:[]),...(state.deadline?['--deadline',String(state.deadline)]:[])]
      const claim = await cli($, 'summary-claim', id, '', {flags,timeoutMs:timeout(state)})
      if (!claim.work) return
      const { batch_id, claim_id, system, prompt, parts, model, task = {}, maxTokens = 2048 } = claim.work
      state.claim={batch_id,claim_id}
      live(state)
      if(state.leafOnly&&task.level>0)return
      const use = model || await $.session.model()
      const key=JSON.stringify([batch_id,claim.work.revision,use])
      let cached=outputs.get(id)
      if(cached?.key!==key){outputs.delete(id);cached=null}
      if(!cached&&claim.work.ready?.model===use)cached={key,...claim.work.ready}
      let overshoot=1
      const generate = async prompt => {
        live(state)
        if(state.leafOnly&&task.level>0)throw Error('Catch-up only writes leaves')
        const checked=await cli($,'summary-check',id,JSON.stringify(state.claim),{timeoutMs:timeout(state)})
        if(!checked.valid)throw Error('Summary settings changed or claim expired')
        live(state)
        const ask=()=>{
          live(state)
          return $.model.complete({ model: use, system, prompt: hostPrompt(prompt), maxTokens, timeoutMs: state.deadline?Math.max(1,Math.min(180000,state.deadline-Date.now())):180000 })
        }
        const request=Promise.resolve().then(ask).catch(error=>{
          if(plainPrompt||typeof prompt==='string'||!refusedBlocks(error))throw error
          plainPrompt=true;return ask()
        })
        state.requests.add(request)
        request.then(()=>state.requests.delete(request),()=>state.requests.delete(request))
        const r = await waitModel(request,state)
        live(state)
        const current=await cli($,'summary-check',id,JSON.stringify(state.claim),{timeoutMs:timeout(state)})
        if(!current.valid)throw Error('Summary settings changed or claim expired')
        live(state)
        if (!r.isAnswered) throw Error('Summary generation was incomplete')
        return checkedSummary(r.text,{...task,finishReason:r.stopReason ?? r.stop_reason ?? r.finishReason ?? r.finish_reason,maxChars:null})
      }
      const summary=cached?.summary||await fitSummary(await generate(parts||prompt),draft=>generate(repairSummaryPromptParts(draft,task)),{task,onOvershoot:ratio=>{overshoot=ratio}})
      if(cached)overshoot=cached.overshoot||1
      live(state)
      outputs.set(id,{key,summary,overshoot,model:use})
      const valid=await cli($,'summary-check',id,JSON.stringify(state.claim),{timeoutMs:timeout(state)})
      if(!valid.valid){outputs.delete(id);return}
      live(state);state.saving=true
      let saved
      for(let attempt=0;attempt<2;attempt++){
        try{saved=await cli($,'summary-save',id,JSON.stringify({...state.claim,summary,overshoot,model:use,isAnswered:true,deadline_ms:state.deadline}),{timeoutMs:timeout(state)});break}
        catch(error){live(state);if(attempt===1)throw error}
      }
      if(!saved.saved){if(!saved.retrySave)outputs.delete(id);return}
      outputs.delete(id);state.saving=false
      state.claim=null;state.remaining--
      if (!saved.more) return
    }
  } catch {
    if(state.controller.signal.aborted)outputs.delete(id)
    else if(!state.saving){outputs.delete(id);state.handoff=true;try{await cli($,'summary-host-error',id,JSON.stringify(state.claim||{}))}catch{}}
  }
}
// 主模型分支: $.model.fork sends the main thread's own last request (its model, system prompt, tools and
// messages) with the plan after it, so the whole history is read from the prompt cache, the way Claude Code's
// own compaction summarizes. A separate `claude --resume` may differ in model, effort or the app's tools, and
// then reads everything uncached; it remains the fallback. The wait stays inside the claim's lease.
const FORK_WAIT_MS = 840000
const forking = new Map()
async function forkSummaries($, id) {
  if (forking.has(id) || ended.has(id)) return
  const state = { claim: null }
  forking.set(id, state)
  const settle = reply => cli($, 'fork-settle', id, JSON.stringify({ claim_id: state.claim.claim_id, run_id: state.claim.run_id, ...reply }), { timeoutMs: 120000 })
  try {
    const claim = await cli($, 'fork-claim', id)
    if (!claim.directive) return
    state.claim = claim
    let timer
    const late = new Promise(resolve => { timer = setTimeout(() => resolve({ isAnswered: false, reason: 'timeout' }), FORK_WAIT_MS) })
    const reply = await Promise.race([Promise.resolve().then(() => $.model.fork({ prompt: claim.directive })), late])
      .catch(error => { if (error?.name === 'TypeError') forkMissing = true; return { isAnswered: false, reason: forkMissing ? 'unsupported' : 'error' } })
      .finally(() => clearTimeout(timer))
    if (!state.claim) return
    if (!reply.isAnswered) await settle({ reason: reply.reason })
    else await settle({ text: reply.text, usage: reply.usage, model: await Promise.resolve().then(() => $.session.model()).catch(() => null) })
    state.claim = null
  } catch {
    if (state.claim) try { await settle({ reason: 'error' }) } catch {}
  } finally {
    if (forking.get(id) === state) forking.delete(id)
    // The fork read the main thread's cache.
    const watch = idle.get(id)
    if (watch) watch.touchedAt = Date.now()
  }
}
// 缓存过期压缩: `cold-check` (src/summary-background.js) decides from evidence whether the main cache expired:
// the transcript's last main-thread response and the cache lifetime it wrote, plus every request this module saw
// billed to the session while it was idle. A $.model.fork (SuperLcm's own, another mod's keep-warm ping, Claude
// Code's) leaves nothing in the transcript but raises the session's cost, so a rise counts as a read of the main
// cache at that look. The module looks once a minute and asks `cold-check` only after such a read, or once the
// cache would have run out.
const COLD_LOOK_MS = 60000
// ownRuns: the /compact this module is running for a session ('cold' or 'turn-end').
const idle = new Map(), ownRuns = new Map()
function stopIdle(id) { const state = idle.get(id); state?.timer?.cancel(); state?.first?.cancel(); idle.delete(id) }
function watchIdle($, id, firstMs = 0) {
  stopIdle(id)
  if (ended.has(id) || busy.has(id)) return
  const state = { timer: null, first: null, cost: null, touchedAt: 0, dueAt: 0, looking: false }
  idle.set(id, state)
  // The cost now is the baseline: the turn that just ended is in the transcript.
  void Promise.resolve().then(() => $.session.usage()).then(u => { if (state.cost === null) state.cost = u?.cost?.usd ?? null }, () => {})
  try {
    state.timer = $.clock.every(COLD_LOOK_MS, () => lookIdle($, id, state))
    if (firstMs) state.first = $.clock.after(firstMs, () => lookIdle($, id, state))
  } catch { stopIdle(id) }
}
async function lookIdle($, id, state) {
  if (idle.get(id) !== state || state.looking || busy.has(id) || ended.has(id) || forking.has(id) || ownRuns.has(id) || ending.has(id)) return
  state.looking = true
  try {
    const u = await $.session.usage()
    const cost = u?.cost?.usd
    // Without the session's cost no fork can be seen, so nothing shows the cache expired.
    if (typeof cost !== 'number') return stopIdle(id)
    if (state.cost !== null && cost > state.cost) state.touchedAt = Date.now()
    state.cost = cost
    // Summaries still being written go into the packet; the next look goes on.
    if (writing.has(id) || (!state.touchedAt && Date.now() < state.dueAt)) return
    const touched = state.touchedAt
    const due = await cli($, 'cold-check', id, '', { flags: ['--tokens', String(u.context?.tokens || 0), '--window', String(u.context?.window || 0), ...(touched ? ['--touched', String(touched)] : [])] })
    if (idle.get(id) !== state) return
    if (state.touchedAt === touched) state.touchedAt = 0
    if (due.dueAt) { state.dueAt = due.dueAt; return }
    if (!due.compact) return stopIdle(id)
    if (state.touchedAt || busy.has(id) || ended.has(id) || forking.has(id)) return
    stopIdle(id)
    ownRuns.set(id, 'cold')
    try { await $.command.run({ command: 'compact' }) } finally { ownRuns.delete(id) }
  } catch {} finally { state.looking = false }
}
// 回合末压缩: `end-check` (src/summary-background.js) decides from the context now and what this turn added. A dry
// run of the packet comes first: a /compact SuperLcm then declines would show the person a skipped compaction.
const turnStart = new Map(), ending = new Set()
async function compactAtTurnEnd($, id) {
  const stale = () => busy.has(id) || ended.has(id) || forking.has(id) || ownRuns.has(id)
  if (stale() || ending.has(id)) return
  ending.add(id)
  try {
    const u = await $.session.usage(), tokens = u?.context?.tokens || 0, start = turnStart.get(id)
    const grew = typeof start === 'number' ? Math.max(0, tokens - start) : 0
    const due = await cli($, 'end-check', id, '', { flags: ['--tokens', String(tokens), '--window', String(u?.context?.window || 0), '--grew', String(grew)] })
    if (!due.compact || stale()) return
    const plan = await packet($, id, await $.session.messages(), '', 'turn-end', { dry: true })
    if (!plan?.use || stale()) return
    ownRuns.set(id, 'turn-end')
    try { await $.command.run({ command: 'compact' }) } finally { ownRuns.delete(id) }
  } catch {} finally { ending.delete(id) }
}
function summaryTick($,id) {
  const now=Date.now()
  if(ticking.has(id)||(ticked.has(id)&&now-ticked.get(id)<45000))return
  ticked.set(id,now);ticking.add(id)
  void Promise.resolve().then(()=>$.session.usage()).then(u=>['--tokens',String(u?.context?.tokens||0),'--window',String(u?.context?.window||0)],()=>[])
    .then(flags=>cli($,'summary-tick',id,'',{flags:forkMissing?flags:[...flags,'--fork']})).then(reply=>{if(ended.has(id))return;if(reply.fork)return forkSummaries($,id);if(reply.host)return writeSummaries($,id)}).catch(()=>{}).finally(()=>ticking.delete(id))
}
// A message's size as the model reads it: text, tool inputs and tool output text. A tool result's `result`
// (the tool's raw toolUseResult) is left out: it can hold an image's base64 or an edited file's whole
// original, which the model never reads, and made a short tail look too large to keep. An image counts as
// about 1,600 tokens.
const IMAGE_CHARS = 6400
const images = (value, depth = 0) => !value || typeof value !== 'object' || depth > 3 ? 0 : value.type === 'image' ? 1 : Object.values(value).reduce((n, v) => n + images(v, depth + 1), 0)
const sizeOf = m => m.text.length + 200 + (m.toolUses || []).reduce((n, t) => n + JSON.stringify(t.input ?? '').length, 0)
  + (m.toolResults || []).reduce((n, t) => n + String(t.text ?? '').length + images(t.result) * IMAGE_CHARS, 0)
const toInput = messages => messages.map(m => ({ role: m.role, text: m.text, toolUses:(m.toolUses||[]).map(t=>({tool_use_id:t.tool_use_id||t.id||t.call_id})),toolResultIds:m.toolResultIds||(m.toolResults||[]).map(t=>t.tool_use_id||t.id||t.call_id).filter(Boolean),toolBodies:bodies(m),toolResults: m.toolResults?.length ? 1 : 0, size: sizeOf(m) }))
async function packet($, id, messages, instructions, trigger, extra = {}) {
  const usage = await $.session.usage()
  const input = JSON.stringify({ messages: toInput(messages), instructions: instructions || '', trigger, tokens: usage.context.tokens || 0, window: usage.context.window || 0,...extra })
  const run = await $.process.run(['node', `${$.plugin.root}/src/launch.js`, 'compact-packet', id], { stdin: input, timeoutMs: extra.afterCatchup?60000:270000 })
  return JSON.parse(run.stdout.trim().split('\n').at(-1) || '{}')
}
export function register(on) {
  on('session.start', async ($, e, next) => {
    try { if (!e.agentId){const id=await $.session.id();ended.delete(id);await cli($, 'summary-host',id,'',{flags:forkMissing?[]:['--fork']})
      // A resumed session may have been idle past its cache already.
      watchIdle($,id,5000)} } catch {}
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) Promise.resolve().then(() => $.session.id()).then(id => {
      busy.add(id); stopIdle(id); turnStart.delete(id)
      return Promise.resolve().then(() => $.session.usage()).then(u => { if (busy.has(id) && typeof u?.context?.tokens === 'number') turnStart.set(id, u.context.tokens) })
    }).catch(() => {})
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    // The summaries this turn left go into the packet, so the turn-end check waits for them.
    if (!e.agentId) $.session.id().then(id => { busy.delete(id); watchIdle($, id); return writeSummaries($, id).catch(() => {}).then(() => compactAtTurnEnd($, id)) }).catch(() => {})
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    if(!e.agentId)try{Promise.resolve($.session.id()).then(id=>summaryTick($,id)).catch(()=>{})}catch{}
    return yield* next(e)
  })
  on('session.end', async ($, e, next) => {
    if(e.agentId)return next(e)
    try{
      const id=await $.session.id(),state=writing.get(id),fork=forking.get(id)
      ended.add(id)
      outputs.delete(id);discardClaudeRescue(id)
      ticked.delete(id);stopIdle(id);busy.delete(id);turnStart.delete(id)
      if(fork?.claim){const {claim_id,run_id}=fork.claim;fork.claim=null;try{await cli($,'fork-settle',id,JSON.stringify({claim_id,run_id,reason:'session-ended'}))}catch{}}
      if(state){state.handoff=true;state.controller.abort(Error('Session ended'))}
      else await cli($,'summary-handoff',id)
    }catch{}
    return next(e)
  })
  on('session.compact', async ($, e, next) => {
    // Subagents stay with Claude Code. Precompute (Claude Code preparing the compaction ahead of time,
    // kept and swapped in at the threshold without asking again) is answered too: when the summaries are
    // ready, ours is what gets kept; when they are not, Claude Code prepares its own as usual.
    if (e.agentId) return next(e)
    // The /compact this module ran after the cache expired (lookIdle) or at the end of a turn (compactAtTurnEnd).
    let plan,id,own=e.trigger==='manual'&&ownRuns.size>0?'unknown':null
    try {
      id=await $.session.id()
      own&&=ownRuns.get(id)||null
      plan = await packet($, id, e.messages, e.instructions, own || e.trigger)
      // Native precompute is kept until the threshold without dispatching this
      // hook again. Defer only eligible, active summary work and never rescue
      // merely for precompute. Actual pressure still has bounded native handoff.
      if(e.trigger==='precompute'&&plan?.retry&&!plan.use&&!ended.has(id)&&!e.signal?.aborted){
        if(plan.retry==='host')void writeSummaries($,id).catch(()=>{})
        return {skip:'SuperLcm summaries are catching up'}
      }
      if(plan?.catchup?.host){
        const ms=Math.min(Math.max(0,Number(plan.catchup.deadlineMs)||0),240000),started=Date.now()
        let timer,cancel
        const stopped=new Promise(resolve=>{
          timer=setTimeout(resolve,ms)
          if(e.signal){cancel=resolve;if(e.signal.aborted)resolve();else e.signal.addEventListener('abort',cancel,{once:true})}
        })
        try{await Promise.race([writeSummaries($,id,{deadline:started+ms,maxPieces:4,signal:e.signal}),stopped])}
        finally{clearTimeout(timer);if(cancel)e.signal.removeEventListener('abort',cancel)}
        plan=await packet($,id,e.messages,e.instructions,e.trigger,{afterCatchup:true,catchupMs:Date.now()-started})
      }
      if(!own&&e.trigger!=='precompute'&&!plan?.use&&plan?.rescue&&!ended.has(id)&&!e.signal?.aborted)plan=await rescueClaude(rescueHost($),id,e)||plan
    } catch { plan = null;if(!own)try{await cli($,'compact-diagnostic',await $.session.id())}catch{} }
    if (!ended.has(id)&&!e.signal?.aborted&&plan?.use && plan.start > 0 && plan.start < e.messages.length)
      return { messages: [{ role: 'user', text: plan.packet, toolUses: [] }, ...e.messages.slice(plan.start)] }
    if (own) return { skip: `SuperLcm: ${plan?.reason || 'no compaction needed'}` }
    return next(e)
  })
}
