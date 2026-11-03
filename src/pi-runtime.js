// Background preparation and lookup-only installation through Pi public hooks.
import { spawn } from 'node:child_process'
import { summarizePiFork } from './pi-fork.js'
import { readPiPolicy } from './pi-compaction-policy.js'
import { makePiSnapshot, snapshotMatches, piSignature, serializePiMessages,estimatePiMessages,piDialogueMessages } from './pi-snapshot.js'
import { estimateSummaryTokens } from './summary-tokens.js'
import { abortable, summaryAttempt } from './summary-attempt.js'
import { estimatePiRequest, piOutputReserve,piWindowSafety,piCompletionBudget,limitPiOutput } from './pi-request.js'
import { checkedSummary } from './summary-policy.js'
export { serializePiMessages } from './pi-snapshot.js'
export { estimatePiRequest } from './pi-request.js'

export function piCompactRequest({ node, script, home, command = 'pi-prepare' }, input, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Pi 后台摘要已取消')); return }
    const child = spawn(node, [script, command, '--home', home], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    child.stdout.setEncoding('utf8')
    let output = '', bytes = 0, settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) {
        child.kill()
        if(child.exitCode===null&&child.signalCode===null){
          const killer=setTimeout(()=>child.kill('SIGKILL'),500);killer.unref()
          child.once('close',()=>clearTimeout(killer))
        }
        reject(error)
      } else resolve(value)
    }
    const abort = () => finish(new Error('Pi 后台摘要已取消'))
    const timer = setTimeout(() => finish(new Error('Pi 后台摘要服务超时，原文保留')), command === 'pi-ready' ? 10000 : 15 * 60 * 1000)
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', error => finish(error))
    child.stdin.on('error', error => finish(error))
    child.stdout.on('data', data => { if(settled)return;bytes+=Buffer.byteLength(data);if(bytes>2*1024*1024){finish(new Error('Pi 摘要结果过大'));return};output+=data })
    child.on('close', code => {
      try { const value = JSON.parse(output); if (code !== 0 || value.error) throw Error(value.error || 'Pi 后台摘要服务失败'); finish(null, value.prepared || null) }
      catch (error) { finish(error) }
    })
    try { child.stdin.end(JSON.stringify(input)) } catch (error) { finish(error) }
  })
}

export function registerPiCompaction(pi, options, {
  request = piCompactRequest, policy = () => readPiPolicy(options.home), makeSnapshot = makePiSnapshot, guardTimeoutMs = 180000,attemptTimeoutMs=600000,fork=summarizePiFork,
} = {}) {
  let state = null, swapping = null, retryAfter = 0, failures = 0, retrySignature = null, capture = null, requestMessages = null, epoch = 0, sessionController = new AbortController()
  let activitySignal,activityCleanup,protectionAbort=false
  let captureRecovery=false, pendingReplacement=null
  const capacityWaiters=new Set()
  const settings = () => ({...(pi.getSettings?.() || {}), thinkingLevel:pi.getThinkingLevel?.()})
  const entries = ctx => ctx.sessionManager.buildSessionProjection().entries
  const takeoverEnabled=ctx=>{
    const p=policy()
    if(!p.enabled)return false
    if(p.summaryMode==='api'&&entries(ctx).some(e=>e.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>!['text','toolCall','thinking','redactedThinking'].includes(b.type))))){
      ctx.ui?.setStatus?.('superlcm-compaction','SuperLCM：图片或附件由原生压缩处理')
      return false
    }
    return true
  }
  const signature = ctx => piSignature(ctx, policy(), settings())
  const status = (ctx, text) => ctx.ui?.setStatus?.('superlcm-compaction', text)
  const notice = (ctx, text) => ctx.ui?.notify?.(text, 'warning')
  const info = (ctx, text) => {try{ctx.ui?.notify?.(text,'info')}catch{}}
  // Boundary drafts are only proposals until Pi has appended the checkpoint.
  // Report at the next public lifecycle hook, after checking the persisted view.
  const reportReplacement = ctx => {
    if(!pendingReplacement)return
    try{
      const current=entries(ctx),checkpoint=current.find(e=>e.sourceEntry.type==='compaction')?.sourceEntry
      if(!checkpoint||checkpoint.summary!==pendingReplacement.summary||checkpoint.firstKeptEntryId!==pendingReplacement.firstKeptEntryId)return
      const before=checkpoint.tokensBefore,after=estimatePiMessages(current.flatMap(e=>e.messages))
      const size=Number.isFinite(before)&&before>0?`（约 ${Math.round(before/1000)}K → ${Math.round(after/1000)}K）`:`（当前约 ${Math.round(after/1000)}K）`
      pendingReplacement=null
      status(ctx,'SuperLCM：上下文已替换为后台摘要')
      info(ctx,`上下文已替换为后台摘要${size}。原文和最近内容已保留。`)
    }catch{} // A UI notification must never interrupt a model/tool request.
  }
  const stop = () => { state?.controller.abort(); state = null }
  const clearRetries = () => { retryAfter = 0; failures = 0; retrySignature = null }
  const failed = ctx => {
    let current
    try { current = signature(ctx) } catch { current = 'unavailable-policy' }
    failures = retrySignature === current ? failures + 1 : 1; retrySignature = current
    retryAfter = Date.now() + 60000 * 2 ** Math.min(4, failures - 1)
  }
  const clearSnapshot = () => { stop(); clearRetries(); capture = null; requestMessages = null;captureRecovery=false }
  const reset = () => { epoch++;pendingReplacement=null;capacityWaiters.clear(); activityCleanup?.();activitySignal=undefined;protectionAbort=false;sessionController.abort(Error('Pi 会话已切换或结束')); sessionController = new AbortController(); clearSnapshot(); swapping = null }
  const bindActivity=ctx=>{
    const signal=ctx.signal
    if(!signal||signal===activitySignal)return
    activityCleanup?.();activitySignal=signal;protectionAbort=false
    const cancel=()=>{if(!protectionAbort)stop()}
    signal.addEventListener('abort',cancel,{once:true});activityCleanup=()=>signal.removeEventListener('abort',cancel)
    if(signal.aborted)cancel()
  }
  const valid = (ctx, current = entries(ctx)) => state && snapshotMatches(state.snapshot, current, signature(ctx))
  const usage = ctx => ({ tokens: ctx.getContextUsage()?.tokens, window: ctx.model?.contextWindow })
  const reached = (ctx, ratio) => { const u = usage(ctx),tokens=capacity(ctx)?.observed||0; return Number.isFinite(u.window) && u.window > 0 && tokens >= u.window * ratio }
  function capacity(ctx, current = entries(ctx)) {
    const u = usage(ctx)
    if (!Number.isFinite(u.window) || u.window <= 0) return null
    const reserve = Number.isFinite(ctx.model?.maxTokens) ? Math.max(0, ctx.model.maxTokens) : Math.min(16384, u.window * .1)
    const inputLimit = Math.max(0, u.window - piCompletionBudget(ctx.model,policy().ratio,reserve) - piWindowSafety(ctx.model,policy().ratio))
    const whole = estimatePiMessages(piDialogueMessages(current))
    const active = pi.getActiveTools?.(), tools = (pi.getAllTools?.() || []).filter(t => !active || active.includes(t.name))
    const declared = Math.max(estimateSummaryTokens(ctx.getSystemPrompt?.() || '') + estimateSummaryTokens(JSON.stringify(tools)),estimatePiMessages(current.flatMap(e=>e.messages.filter(m=>m.role==='system'))))
    // Fixed prompts/tools are not compressible. Never subtract them from the
    // summary budget or pretend that replacing old dialogue removes them.
    const fixed = Math.max(declared, (u.tokens || 0) - whole, 0)
    const estimated=fixed+whole
    // Pi's public usage combines provider receipts with newly appended input.
    // JSON previews/details can substantially exceed the actual wire tokens;
    // reserve them for cold starts, rather than aborting a measured safe turn.
    const hasReceipt=current.some(e=>e.messages.some(m=>m.role==='assistant'&&!['error','aborted'].includes(m.stopReason)&&['input','output','cacheRead','cacheWrite'].some(k=>m.usage?.[k]>0)))
    const observed=hasReceipt&&Number.isFinite(u.tokens)&&u.tokens>0?Math.max(u.tokens,declared):estimated
    return { inputLimit, guard: Math.min(u.window * Math.max(.9,policy().ratio), inputLimit), fixed, estimated,observed }
  }
  const danger = (ctx, current = entries(ctx)) => {
    const c = capacity(ctx, current)
    return c && (usage(ctx).tokens >= c.guard || c.observed >= c.inputLimit)
  }
  const pause = (ctx,reason='capacity') => {
    try{const c=capacity(ctx);pi.appendEntry?.('superlcm-compaction-pause',{reason,tokens:usage(ctx).tokens,observed:c?.observed,projection:c?.estimated,inputLimit:c?.inputLimit,capturedWire:capture?estimatePiRequest(capture.payload):null,attempt:state?.attempt||0,lastFailure:state?.lastFailure?.message||null})}catch{}
    status(ctx, 'SuperLCM：已暂停，防止上下文超限')
    const preparation=state?.promise?(state.retryAt>Date.now()?'后台摘要会自动重试。':'正在后台准备摘要。'):'后台摘要尚未就绪。'
    notice(ctx,reason==='fixed-overhead'?'系统提示或工具定义已超出模型窗口，请减少工具或更换大窗口模型。原文完整保留。':'上下文保护已暂停模型请求。'+preparation+'原文和当前请求已保留。')
    protectionAbort=!!ctx.signal;ctx.abort?.()
  }
  function prepare(ctx, force = false) {
    try {
      reportReplacement(ctx)
      bindActivity(ctx)
      if(ctx.signal?.aborted)return
      const p = policy()
      if (!p.enabled&&!p.summaryEnabled) { stop(); status(ctx, undefined); return }
      if (state && !valid(ctx)) stop()
      if (retrySignature && retrySignature !== signature(ctx)) clearRetries()
      if (state || Date.now() < retryAfter || (!force && !reached(ctx, Math.round((p.ratio-.1)*1e12)/1e12))) return
      const available=force?capacity(ctx):null
      const keepLimit=available?Math.max(0,Math.floor((available.inputLimit-available.fixed)/2)):Infinity
      const snapshot = makeSnapshot(ctx, p, settings(),{keepLimit})
      if (!snapshot) return
      let selectedCapture=capture
      const current = { snapshot, controller: new AbortController(), ready: null, promise: null,attempt:0 }
      state = current; status(ctx, p.summaryMode === 'main-fork' ? 'SuperLCM：主模型后台分支摘要' : 'SuperLCM：Luna 后台准备摘要')
      const announcePreparation=()=>{if(!current.announced){current.announced=true;info(ctx,p.enabled?'正在后台准备上下文摘要。摘要准备完成后，将在需要时替换上下文。':'正在后台生成归档摘要，完成后保存到 SuperLcm。')}}
      const work = async (signal,progress) => {
        if (p.summaryMode !== 'main-fork') {announcePreparation();return request({ ...options, command: 'pi-prepare' }, snapshot, signal)}
        let restored=null
        if(!current.ignorePrepared)try{restored=await request({ ...options, command: 'pi-ready' }, {session_id:snapshot.session_id,draftKey:snapshot.draftKey}, signal)}
        catch(error){if(signal.aborted||!(error instanceof SyntaxError))throw error;current.ignorePrepared=true}
        if (restored?.compaction) return restored
        if(!selectedCapture)selectedCapture=capture
        if(!selectedCapture||['id','provider','contextWindow','maxTokens','api','baseUrl'].some(key=>selectedCapture.model?.[key]!==ctx.model?.[key])||selectedCapture.reasoning!==settings().thinkingLevel)throw Object.assign(Error('Pi 等待捕获当前模型请求后恢复后台摘要'),{code:'SUPERLCM_PI_CAPTURE_INVALID'})
        let staged
        const forkSummary = await fork(ctx, snapshot, selectedCapture, { signal, progress,
          stage: async () => { staged = await request({ ...options, command: 'pi-stage' }, snapshot, signal);announcePreparation();return staged } })
        signal.throwIfAborted()
        if (state !== current || !valid(ctx)) throw Error('Pi 后台分支已过期')
        return request({ ...options, command: 'pi-prepare' }, { ...snapshot, sourceMessages: undefined, forkSummary, forkRevision: staged.revision }, signal)
      }
      const run=async()=>{
        for(;;){
          current.controller.signal.throwIfAborted()
          if(state!==current||!valid(ctx))throw Error('Pi 后台分支已过期')
          current.attempt++;current.retryAt=null
          if(current.lastFailure)status(ctx,`SuperLCM：第 ${current.attempt} 次后台摘要，上次失败：${current.lastFailure.message.slice(0,160)}`)
          let result
          try{
            result=await summaryAttempt(work,current.controller.signal,attemptTimeoutMs)
            if(!result?.compaction)throw Error('Pi 后台摘要未返回完整结果，原文保留')
            {
              checkedSummary(result.compaction.summary,{requireHeading:true,maxChars:null})
              if(result.compaction.firstKeptEntryId!==snapshot.firstKeptEntryId||estimateSummaryTokens(result.compaction.summary)>=(snapshot.sourceTokens??estimateSummaryTokens(snapshot.source)))throw Error('Pi 后台摘要覆盖或长度无效，原文保留')
            }
            return result
          }catch(error){
            if(error.code==='SUPERLCM_PI_CAPTURE_INVALID'){
              if(capture===selectedCapture)capture=null
              throw error
            }
            if(p.summaryMode!=='main-fork'||current.controller.signal.aborted||state!==current||!valid(ctx))throw error
            if(result?.compaction)current.ignorePrepared=true
            current.lastFailure={attempt:current.attempt,message:String(error.message||error),at:Date.now()}
            failed(ctx)
            const delay=Math.min(300000,Math.max(0,retryAfter-Date.now()))
            current.retryAt=Date.now()+delay
            status(ctx,`SuperLCM：第 ${current.attempt} 次摘要未完成，${Math.ceil(delay/1000)} 秒后自动重试：${current.lastFailure.message.slice(0,160)}`)
            await retryDelay(delay,current.controller.signal)
          }
        }
      }
      current.promise = run().then(result => {
        if (state !== current) return
        if (!valid(ctx)) { stop(); return }
        if (!result?.compaction) throw Error('Pi 后台摘要未返回完整结果，原文保留')
        current.ready = result; clearRetries(); status(ctx, takeoverEnabled(ctx) ? `SuperLCM：摘要已准备，${Math.round(policy().ratio*100)}% 时替换` : 'SuperLCM：后台摘要已保存')
        if (!capacityWaiters.size&&takeoverEnabled(ctx)&&ctx.isIdle() && (reached(ctx, policy().ratio) || danger(ctx))) void swapIdle(ctx)
      }).catch(error => {
        if (state !== current) return
        state = null
        if(error.code==='SUPERLCM_PI_CAPTURE_INVALID'){
          clearRetries();status(ctx,'SuperLCM：等待当前模型的有效请求')
          if(capture&&capture!==selectedCapture)prepare(ctx)
          return
        }
        failed(ctx)
        status(ctx, 'SuperLCM：后台准备失败，原文保留'); notice(ctx, error.message)
      }).finally(() => { current.promise = null })
    } catch (error) { stop(); notice(ctx, error.message) }
  }
  async function ready(ctx, current = entries(ctx), signal, extra = 0) {
    if (!takeoverEnabled(ctx) || !state?.ready || !valid(ctx, current)) return null
    const selected = state
    // This command only reads a completed result and validates model settings.
    // Cache misses never generate a summary here.
    const result = await request({ ...options, command: 'pi-ready' }, {
      session_id: ctx.sessionManager.getSessionId(), draftKey: selected.snapshot.draftKey,
    }, signal)
    if (state !== selected) return null
    if (!valid(ctx, current) || !result?.compaction) { stop(); return null }
    const compaction = result.compaction
    try { checkedSummary(compaction.summary, { requireHeading: true, maxChars: null }) }
    catch { stop(); failed(ctx); return null }
    if (compaction.firstKeptEntryId !== selected.snapshot.firstKeptEntryId || estimateSummaryTokens(compaction.summary) >= (selected.snapshot.sourceTokens??estimateSummaryTokens(selected.snapshot.source))) {
      stop(); failed(ctx); return null
    }
    const c = capacity(ctx, current), cut = current.findIndex(e => e.sourceEntry.id === selected.snapshot.firstKeptEntryId)
    const tail = estimatePiMessages(piDialogueMessages(current.slice(cut)))
    if (!c || c.fixed + tail + estimateSummaryTokens(compaction.summary) + extra >= c.inputLimit) {
      stop(); status(ctx, 'SuperLCM：旧摘要覆盖不足，后台重新准备'); return null
    }
    return { ...compaction, tokensBefore: ctx.getContextUsage()?.tokens || compaction.tokensBefore,
      details: { ...compaction.details, backgroundPrepared: true, replacementModelCalls: 0 } }
  }
  async function guardedReady(ctx, current = entries(ctx), extra = 0) {
    const c = capacity(ctx, current)
    if (!danger(ctx, current) && (!c || c.observed + extra < c.inputLimit)) return null
    status(ctx, 'SuperLCM：预留空间不足，暂停下一轮并等待后台摘要')
    const selectedEpoch = epoch
    const waiter={};capacityWaiters.add(waiter)
    try {
      const run=async signal => {
        const waiting = state?.promise
        if (waiting) await abortable(waiting, signal)
        signal.throwIfAborted()
        let result = await ready(ctx, current, signal, extra)
        if (!result) {
          // A completed but insufficient draft may restage once. Native branch
          // retries have no overall deadline; session cancellation still wins.
          signal.throwIfAborted()
          prepare(ctx, true)
          const next = state?.promise
          if (next && next !== waiting) { await abortable(next, signal); signal.throwIfAborted(); result = await ready(ctx, current, signal, extra) }
        }
        return result
      }
      const signal=ctx.signal?AbortSignal.any([sessionController.signal,ctx.signal]):sessionController.signal
      return policy().summaryMode==='main-fork'?await run(signal):await summaryAttempt(run,signal,guardTimeoutMs)
    } catch (error) { if (epoch === selectedEpoch) { if (state) failed(ctx); stop() }; throw error }
    finally{capacityWaiters.delete(waiter)}
  }
  async function swapIdle(ctx, force = false) {
    if (!takeoverEnabled(ctx) || swapping || !ctx.isIdle() || !state?.ready || (!force && !reached(ctx, policy().ratio) && !danger(ctx))) return false
    const selectedEpoch = epoch, selectedState = state, token = {}; swapping = token
    try {
      await summaryAttempt(signal => abortable(new Promise((resolve, reject) => {
        try { ctx.compact({ onComplete: () => { if (epoch === selectedEpoch && !signal.aborted) { reportReplacement(ctx); if (state === selectedState) stop(); status(ctx, 'SuperLCM：已替换为后台摘要') }; resolve() },
          onError: reject }) }
        catch (error) { reject(error) }
      }), signal), sessionController.signal, guardTimeoutMs)
      return epoch === selectedEpoch && signature(ctx) === selectedState.snapshot.signature
    } catch (error) {
      if (epoch === selectedEpoch && state === selectedState) { failed(ctx); notice(ctx, error.message); pause(ctx) }
      return false
    } finally { if (swapping === token) swapping = null }
  }
  pi.on('session_before_compact', async (event, ctx) => {
    const selectedEpoch = epoch
    try {
      if (!takeoverEnabled(ctx)) return
      if(event.reason==='threshold'&&!reached(ctx,policy().ratio)&&!danger(ctx))return {cancel:true}
      const compaction = await ready(ctx, entries(ctx), event.signal)
      if (epoch !== selectedEpoch) return { cancel: true }
      if (compaction) {pendingReplacement=compaction;return { compaction: { ...compaction, tokensBefore: event.preparation.tokensBefore } }}
      status(ctx, 'SuperLCM：后台摘要尚未准备好，保留原文')
      return { cancel: true }
    } catch (error) { notice(ctx, error.message); return { cancel: true } }
  })
  pi.on('turn_end', async (event, ctx) => {
    const selectedEpoch = epoch
    // The capacity gate deliberately aborts the foreground request after
    // capturing it. Its aborted turn must not cancel the recovery branch.
    if(ctx.signal?.aborted)return
    try {
      if (takeoverEnabled(ctx) && event.context?.contextEntries && reached(ctx, policy().ratio)) {
        let compaction = await ready(ctx, event.context.contextEntries)
        if (epoch !== selectedEpoch) return
        if (!compaction && danger(ctx, event.context.contextEntries)) {
          compaction = await guardedReady(ctx, event.context.contextEntries)
          if (epoch !== selectedEpoch) return
          if (!compaction) { pause(ctx); return }
        }
        if (compaction) {
          pendingReplacement=compaction
          status(ctx, 'SuperLCM：直接替换后台摘要')
          return { entries: [...(event.entries || []), { type: 'compaction', summary: compaction.summary,
            firstKeptEntryId: compaction.firstKeptEntryId, details: compaction.details }] }
        }
      }
      if (takeoverEnabled(ctx) && event.context?.contextEntries && danger(ctx, event.context.contextEntries)) {
        const compaction = await guardedReady(ctx, event.context.contextEntries)
        if (epoch !== selectedEpoch) return
        if (compaction) {pendingReplacement=compaction;return { entries: [...(event.entries || []), { type: 'compaction', summary: compaction.summary, firstKeptEntryId: compaction.firstKeptEntryId, details: compaction.details }] }}
        pause(ctx); return
      }
      prepare(ctx) // deliberately fire-and-forget; the main tool loop continues
    } catch (error) { if (epoch !== selectedEpoch) return; notice(ctx, error.message); if (danger(ctx)) pause(ctx) }
  })
  for (const name of ['agent_settled', 'model_select', 'session_start']) pi.on(name, (_event, ctx) => {
    if(name==='model_select'||name==='session_start')reset()
    reportReplacement(ctx)
    if(_event?.aborted){if(protectionAbort){protectionAbort=false;return};stop();clearRetries();return}
    prepare(ctx); if (state?.ready) void swapIdle(ctx)
  })
  pi.on('input', async (event, ctx) => {
    const selectedEpoch = epoch
    const pending = estimatePiRequest({ text: event.text, images: event.images })
    const unsafeInput = () => { const c = capacity(ctx); return danger(ctx) || (c && c.observed + pending >= c.inputLimit) }
    let preserved = false
    const preserve = () => { if (!preserved) { pi.appendEntry?.('superlcm-deferred-input', { text: event.text, images: event.images, reason: 'context-capacity' }); preserved = true } }
    const defer = () => {
      preserve()
      notice(ctx, '上下文保护已拦住本次模型请求。输入已保留，后台摘要恢复后可继续。')
      return { action: 'handled' }
    }
    try {
    prepare(ctx)
    if (takeoverEnabled(ctx) && unsafeInput()) {
      preserve() // Preserve the input before any cancellable capacity wait.
      const c = capacity(ctx)
      if (c && pending + c.fixed >= c.inputLimit) return defer()
      let result
      try { result = await guardedReady(ctx, entries(ctx), pending) } catch (error) { notice(ctx, error.message) }
      if (epoch !== selectedEpoch) return { action: 'handled' }
      if (result) await swapIdle(ctx, true)
      if (epoch !== selectedEpoch) return { action: 'handled' }
      if (!result || unsafeInput()) {
        if(!result&&policy().summaryMode==='main-fork'&&!capture&&!ctx.signal?.aborted){captureRecovery=true;return}
        // A handled input never reaches the provider. Keep its exact text in
        // the append-only native transcript instead of silently dropping it.
        return defer()
      }
      return
    }
    if (takeoverEnabled(ctx) && state?.ready && (reached(ctx, policy().ratio) || danger(ctx))) {
      preserve(); const swapped = await swapIdle(ctx)
      if (epoch !== selectedEpoch) return { action: 'handled' }
      if (!swapped) return defer()
    }
    } catch (error) { notice(ctx, error.message); return defer() }
  })
  // Final public request-time hook also sees newly expanded user input, prompt
  // sections, images and tool declarations that were absent from the input hook.
  pi.on('context_with_system', (event, ctx) => {
    try {
      if (!policy().enabled&&!policy().summaryEnabled) return
      if (policy().summaryMode === 'main-fork') requestMessages = structuredClone(event.messages)
      if(!takeoverEnabled(ctx))return
      // Native branches need the exact final wire request. Its later hook is
      // the capacity gate; aborting here would prevent cold-resume capture.
      if(policy().summaryMode==='main-fork')return
      const c = capacity(ctx)
      if (!c || estimatePiRequest(event.messages) >= c.inputLimit) pause(ctx)
    } catch (error) { notice(ctx, error.message); pause(ctx) }
  })
  pi.on('before_provider_request', (event, ctx) => {
    try {
      reportReplacement(ctx)
      const p = policy()
      if (!p.enabled && !p.summaryEnabled) {captureRecovery=false;return}
      let unsafe=false
      if (takeoverEnabled(ctx)) {
        const c = capacity(ctx),payload=limitPiOutput(event.payload,ctx.model,piCompletionBudget(ctx.model,p.ratio,piOutputReserve(event.payload,ctx.model)))
        const limit = c && Math.min(c.inputLimit, ctx.model.contextWindow - piOutputReserve(payload,ctx.model) - piWindowSafety(ctx.model,p.ratio))
        unsafe=!c||estimatePiRequest(payload)>=limit
        const fixedPayload={...payload}
        for(const key of ['messages','input'])if(Array.isArray(fixedPayload[key]))fixedPayload[key]=fixedPayload[key].filter(m=>['system','developer'].includes(m.role))
        if(unsafe&&!p.summaryModel&&estimatePiRequest(fixedPayload)>=ctx.model.contextWindow-piWindowSafety(ctx.model,p.ratio)-1024){captureRecovery=false;pause(ctx,'fixed-overhead');return}
        event={...event,payload}
      }
      if (p.summaryMode === 'main-fork'){
        capture = { payload: structuredClone(event.payload), messages: requestMessages, model: structuredClone(ctx.model), reasoning: pi.getThinkingLevel?.() }
        prepare(ctx,unsafe||captureRecovery)
      }
      captureRecovery=false
      // A cold capture is useful even when the final request turns out to fit.
      // If it does not fit, keep the captured prefix so the background branch
      // can summarize an earlier complete boundary while the foreground waits.
      if(takeoverEnabled(ctx)&&unsafe){pause(ctx);return}
      return event.payload
    } catch (error) { notice(ctx, error.message); pause(ctx) }
  })
  pi.on('session_shutdown', () => reset())
  pi.on('session_before_switch', () => reset())
  pi.on('session_before_fork', () => reset())
  pi.on('session_tree', () => reset())
  pi.on('session_compact', (_event,ctx) => {reportReplacement(ctx);pendingReplacement=null;clearSnapshot()})
  pi.registerCommand('compact-policy', { description: 'Show SuperLCM background compaction policy', handler: async (_args, ctx) => {
    const p = policy()
    ctx.ui?.notify?.(`SuperLCM：${p.enabled ? '开启' : '关闭'}。提前后台准备${p.summaryMode === 'main-fork' ? '主模型分支' : 'Luna'}摘要，到 ${Math.round(p.ratio * 100)}% 直接替换。当前${state?.ready ? '已准备' : state ? '准备中' : '等待准备'}。`, 'info')
  } })
  return { prepare, ready, getState: () => state }
}

function retryDelay(ms,signal){
  signal.throwIfAborted()
  return new Promise((resolve,reject)=>{
    const finish=(fn,value)=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);fn(value)}
    const cancel=()=>finish(reject,signal.reason)
    const timer=setTimeout(()=>finish(resolve),ms);timer.unref?.()
    signal.addEventListener('abort',cancel,{once:true})
    if(signal.aborted)cancel()
  })
}
