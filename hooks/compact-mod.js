import { fitSummary, repairSummaryPrompt } from '../src/summary-fitting.js'
import { checkedSummary } from '../src/summary-policy.js'
// A Claude Code module (2.1.286+), two jobs:
// 接管压缩: when the main conversation compacts, SuperLcm answers with its own summaries plus the newest
// messages word for word (see src/compaction.js). Anything unexpected, the setting being off, a subagent, or
// summaries that lag behind, hands the compaction back to Claude Code. When it compacts is Claude Code's
// own threshold, which the console sets (src/takeover.js). The module does not start a compaction itself:
// Claude Code skips the calling plugin's hooks on a plugin's $.session.compact(), so one started here would
// always be Claude Code's own summary.
// 本工具后台写: throttled steps and completed turns write waiting pieces with $.model.complete, on the
// session's own login and without starting another Claude Code; the turn does not wait for it. What is left
// when the session ends, or after a failed call, goes to the separate `claude -p` worker as before.
const cli = ($, command, id, stdin, { flags = [], timeoutMs = 60000 } = {}) => $.process.run(['node', `${$.plugin.root}/src/launch.js`, command, id, ...flags], { stdin: stdin ?? '', timeoutMs })
  .then(r => JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}'))
const MAX_PIECES = 2000 // a whole backlog in one background run (one at a time per session); turns never wait for it
const writing = new Map(), ticked = new Map(), ticking = new Set(), ended = new Set()
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
  state={controller:new AbortController(),deadline:0,leafOnly:false,remaining:MAX_PIECES,requests:new Set(),cleanups:[],claim:null,timer:null}
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
      const { batch_id, claim_id, system, prompt, model, task = {}, maxTokens = 2048 } = claim.work
      state.claim={batch_id,claim_id}
      live(state)
      if(state.leafOnly&&task.level>0)return
      const use = model || await $.session.model()
      let overshoot=1
      const generate = async prompt => {
        live(state)
        if(state.leafOnly&&task.level>0)throw Error('Catch-up only writes leaves')
        const checked=await cli($,'summary-check',id,JSON.stringify(state.claim),{timeoutMs:timeout(state)})
        if(!checked.valid)throw Error('Summary settings changed or claim expired')
        live(state)
        const request=Promise.resolve().then(()=>{
          live(state)
          return $.model.complete({ model: use, system, prompt, maxTokens, timeoutMs: state.deadline?Math.max(1,Math.min(180000,state.deadline-Date.now())):180000 })
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
      const summary=await fitSummary(await generate(prompt),draft=>generate(repairSummaryPrompt(draft,task)),{task,onOvershoot:ratio=>{overshoot=ratio}})
      live(state)
      const saved = await cli($, 'summary-save', id, JSON.stringify({ ...state.claim, summary, overshoot, model: use, isAnswered: true, deadline_ms:state.deadline }),{timeoutMs:timeout(state)})
      if (!saved.saved) return
      state.claim=null;state.remaining--
      if (!saved.more) return
    }
  } catch { if(!state.controller.signal.aborted){state.handoff=true;try{await cli($,'summary-host-error',id,JSON.stringify(state.claim||{}))}catch{}} }
}
function summaryTick($,id) {
  const now=Date.now()
  if(ticking.has(id)||(ticked.has(id)&&now-ticked.get(id)<45000))return
  ticked.set(id,now);ticking.add(id)
  void cli($,'summary-tick',id).then(reply=>{if(reply.host&&!ended.has(id))return writeSummaries($,id)}).catch(()=>{}).finally(()=>ticking.delete(id))
}
const toInput = messages => messages.map(m => ({ role: m.role, text: m.text.slice(0, 2000), toolUses:(m.toolUses||[]).map(t=>({tool_use_id:t.tool_use_id||t.id||t.call_id})),toolResultIds:m.toolResultIds||(m.toolResults||[]).map(t=>t.tool_use_id||t.id||t.call_id).filter(Boolean),toolResults: m.toolResults?.length ? 1 : 0, size: m.text.length + JSON.stringify(m.toolUses || []).length + JSON.stringify(m.toolResults || []).length + 200 }))
async function packet($, id, messages, instructions, trigger, extra = {}) {
  const usage = await $.session.usage()
  const input = JSON.stringify({ messages: toInput(messages), instructions: instructions || '', trigger, tokens: usage.context.tokens || 0, window: usage.context.window || 0,...extra })
  const run = await $.process.run(['node', `${$.plugin.root}/src/launch.js`, 'compact-packet', id], { stdin: input, timeoutMs: extra.afterCatchup?60000:270000 })
  return JSON.parse(run.stdout.trim().split('\n').at(-1) || '{}')
}
export function register(on) {
  on('session.start', async ($, e, next) => {
    try { if (!e.agentId){const id=await $.session.id();ended.delete(id);await cli($, 'summary-host',id)} } catch {}
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) $.session.id().then(id => writeSummaries($, id)).catch(() => {})
    return next(e)
  })
  on('turn.step', ($, e, next) => {
    if(!e.agentId)try{Promise.resolve($.session.id()).then(id=>summaryTick($,id)).catch(()=>{})}catch{}
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    if(e.agentId)return next(e)
    try{
      const id=await $.session.id(),state=writing.get(id)
      ended.add(id)
      ticked.delete(id)
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
    let plan
    try {
      const id=await $.session.id()
      plan = await packet($, id, e.messages, e.instructions, e.trigger)
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
    } catch { plan = null;try{await cli($,'compact-diagnostic',await $.session.id())}catch{} }
    if (plan?.use && plan.start > 0 && plan.start < e.messages.length)
      return { messages: [{ role: 'user', text: plan.packet, toolUses: [] }, ...e.messages.slice(plan.start)] }
    return next(e)
  })
}
