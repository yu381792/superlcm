// Background preparation and lookup-only installation through Pi public hooks.
import { spawn } from 'node:child_process'
import { summarizePiFork,capturePiContext,piCompactedContext,normalizePiReasoning } from './pi-fork.js'
import { readPiPolicy } from './pi-compaction-policy.js'
import { makePiSnapshot, snapshotMatches, piSignature,piDigest, serializePiMessages,estimatePiMessages,piDialogueMessages } from './pi-snapshot.js'
import { estimateSummaryTokens } from './summary-tokens.js'
import { abortable, summaryAttempt } from './summary-attempt.js'
import { estimatePiRequest,estimatePiWireWithReceipt,measuredPiContextTokens,fixedPiRequestTokens, piOutputReserve,piWindowSafety,piCompletionBudget,limitPiOutput } from './pi-request.js'
import { checkedSummary } from './summary-policy.js'
import { piProviderBoundary, isPiAuxiliaryRequest } from './pi-provider-boundary.js'
export { serializePiMessages } from './pi-snapshot.js'
export { estimatePiRequest } from './pi-request.js'

const terminalFailure = error => ['SUPERLCM_PI_UNSUPPORTED_REQUEST','SUPERLCM_PI_UNSHRINKABLE_PREFIX','SUPERLCM_PI_INVALID_BUDGET','SUPERLCM_PI_REPLAY_REFUSED','SUPERLCM_PI_INVALID_SUMMARY'].includes(error.code)

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
  request = piCompactRequest, policy = () => readPiPolicy(options.home), makeSnapshot = makePiSnapshot, guardTimeoutMs = 180000,attemptTimeoutMs=600000,fork=summarizePiFork, createBoundary=piProviderBoundary,
} = {}) {
  let state = null, swapping = null, retryAfter = 0, failures = 0, retrySignature = null, capture = null, foregroundCapture = null, epoch = 0, sessionController = new AbortController()
  let activitySignal,activityCleanup,protectionAbort=false,activeModel=null
  let captureRecovery=false, pendingReplacement=null,pendingContextCompaction=null,blockedPayload=null
  const capacityWaiters=new Set(),rejectedPrepared=new Set()
  const boundary=createBoundary(finalRequest)
  const settings = () => ({...(pi.getSettings?.() || {}), thinkingLevel:pi.getThinkingLevel?.()})
  const modelIdentity = ctx => piDigest([ctx.model?.provider, ctx.model?.id, ctx.model?.contextWindow, ctx.model?.maxTokens, ctx.model?.api, ctx.model?.baseUrl])
  const entries = ctx => ctx.sessionManager.buildSessionProjection().entries
  const takeoverEnabled=ctx=>{
    const p=policy()
    if(!p.enabled)return false
    if(p.summaryMode==='api'&&entries(ctx).some(e=>e.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>!['text','toolCall','thinking','redactedThinking'].includes(b.type))))){
      ctx.ui?.setStatus?.('superlcm-compaction',undefined)
      return false
    }
    return true
  }
  const signature = ctx => piSignature(ctx, policy(), settings())
  const status = (ctx, text) => ctx.ui?.setStatus?.('superlcm-compaction', text)
  const notice = (ctx, text) => ctx.ui?.notify?.(text, 'warning')
  const info = (ctx, text) => {try{ctx.ui?.notify?.(text,'info')}catch{}}
  // Only a completed response to the current model can prove actual usage.
  const paidInputTokens=(message,ctx)=>{
    const u=message?.usage,parts=['input','output','cacheRead','cacheWrite'].map(k=>u?.[k]??0)
    if(message?.role!=='assistant'||message.provider!==ctx.model?.provider||message.model!==ctx.model?.id||
       ['aborted','error'].includes(message.stopReason)||parts.some(n=>!Number.isSafeInteger(n)||n<0)||parts[0]+parts[2]+parts[3]<=0)return null
    return parts[0]+parts[2]+parts[3]
  }
  const measuredUsage=(message,ctx)=>{
    const paid=paidInputTokens(message,ctx)
    if(paid===null)return null
    const current=ctx.getContextUsage?.()?.tokens
    return Number.isFinite(current)&&current>=paid+(message.usage?.output??0)?current:null
  }
  const afterCheckpoint=(ctx,checkpoint)=>{
    const branch=ctx.sessionManager.getBranch?.()
    if(!Array.isArray(branch))return null
    const index=branch.findIndex(e=>e.id===checkpoint.id&&e.type==='compaction')
    if(index<0)return null
    const last=branch.slice(index+1).findLast(e=>e.type==='message'&&e.message?.role==='assistant'&&!['aborted','error'].includes(e.message.stopReason))
    return last?measuredUsage(last.message,ctx):null
  }
  // At session_compact time, the next assistant turn has not run yet, so
  // character-based estimates would inflate Chinese/JSON contexts by ~50%.
  // Calibrate post-compaction size from exact pre-compaction provider receipts.
  const calibratedAfter=(ctx,checkpoint,before)=>{
    if(!Number.isFinite(before)||before<=0)return null
    const branch=ctx.sessionManager.getBranch?.()
    if(!Array.isArray(branch))return null
    const compIdx=branch.findIndex(e=>e?.id===checkpoint.id&&e?.type==='compaction')
    if(compIdx<=0)return null
    const pre=branch.slice(0,compIdx),cutIdx=pre.findIndex(e=>e?.id===checkpoint.firstKeptEntryId)
    if(cutIdx<=0||pre.slice(cutIdx).some(e=>['compaction','context_edit'].includes(e?.type)))return null
    const cutAsstIdx=pre.findIndex((e,i)=>i>=cutIdx&&e?.type==='message'&&paidInputTokens(e.message,ctx)!==null)
    if(cutAsstIdx<0)return null
    const gap=pre.slice(cutIdx,cutAsstIdx).filter(e=>e?.type==='message'&&e.message?.role&&e.message.role!=='system').map(e=>e.message)
    const prefixPlusFixed=paidInputTokens(pre[cutAsstIdx].message,ctx)-(gap.length?estimatePiRequest(gap,{history:gap,model:ctx.model}):0)
    if(!Number.isFinite(prefixPlusFixed)||prefixPlusFixed<=0||prefixPlusFixed>before)return null
    const firstBoundary=pre.findIndex(e=>['compaction','context_edit'].includes(e?.type))
    const initEnd=firstBoundary>=0?firstBoundary:pre.length
    const firstAsstIdx=pre.slice(0,initEnd).findIndex(e=>e?.type==='message'&&paidInputTokens(e.message,ctx)!==null)
    let fixed=null
    if(firstAsstIdx>=0){
      const initMsgs=pre.slice(0,firstAsstIdx).filter(e=>e?.type==='message'&&e.message?.role&&e.message.role!=='system').map(e=>e.message)
      const fromInit=paidInputTokens(pre[firstAsstIdx].message,ctx)-(initMsgs.length?estimatePiRequest(initMsgs,{history:initMsgs,model:ctx.model}):0)
      if(Number.isFinite(fromInit)&&fromInit>=0&&fromInit<=prefixPlusFixed)fixed=fromInit
    }
    for(let i=0;i<pre.length;i++){
      if(pre[i]?.type!=='compaction')continue
      const post=pre.slice(i+1).find(e=>['compaction','context_edit','message'].includes(e?.type)&&(e.type!=='message'||e.message?.role==='assistant'))
      if(post?.type==='message'&&paidInputTokens(post.message,ctx)!==null){
        const cached=post.message.usage?.cacheRead??0
        if(Number.isSafeInteger(cached)&&cached>0&&cached<=prefixPlusFixed)fixed=Math.max(fixed??0,cached)
      }
    }
    if(fixed===null)return null
    return fixed+(before-prefixPlusFixed)+estimateSummaryTokens(checkpoint.summary||'')
  }
  const estimatedAfter = (ctx, current) => {
    const active = pi.getActiveTools?.(), tools = (pi.getAllTools?.() || []).filter(t => !active || active.includes(t.name))
    const declared = Math.max(estimateSummaryTokens(ctx.getSystemPrompt?.() || '') + estimateSummaryTokens(JSON.stringify(tools)), estimatePiMessages(current.flatMap(e => e.messages.filter(m => m.role === 'system'))))
    return declared + estimatePiMessages(piDialogueMessages(current), ctx.model)
  }
  // Boundary drafts are only proposals until Pi has appended the checkpoint.
  // Report at the next public lifecycle hook, after checking the persisted view.
  const reportReplacement = ctx => {
    if(!pendingReplacement)return
    try{
      const current=entries(ctx),checkpoint=current.find(e=>e.sourceEntry.type==='compaction')?.sourceEntry
      if(!checkpoint||checkpoint.summary!==pendingReplacement.summary||checkpoint.firstKeptEntryId!==pendingReplacement.firstKeptEntryId)return
      const before=pendingReplacement.tokensBefore||checkpoint.details?.superlcmTokensBefore||checkpoint.tokensBefore
      const after=pendingReplacement.confirmedAfterTokens??afterCheckpoint(ctx,checkpoint)??calibratedAfter(ctx,checkpoint,before)??estimatedAfter(ctx,current)
      const prior=Number.isFinite(before)&&before>0?Math.round(before/1000):null
      const next=Math.max(1,Math.round(after/1000))
      const size=prior!==null?`（${prior}K-${next}K）`:`（${next}K）`
      pendingReplacement=null
      status(ctx,'SuperLCM：上下文已压缩')
      info(ctx,`上下文已压缩${size}`)
    }catch{} // A UI notification must never interrupt a model/tool request.
  }
  // Cancelling generation must not erase a replacement already used by a
  // foreground request. Only session invalidation or its boundary clears it.
  const stop = () => { state?.controller.abort(); state = null }
  const clearRetries = () => { retryAfter = 0; failures = 0; retrySignature = null;blockedPayload=null }
  const failed = ctx => {
    let current
    try { current = signature(ctx) } catch { current = 'unavailable-policy' }
    failures = retrySignature === current ? failures + 1 : 1; retrySignature = current
    retryAfter = Date.now() + 60000 * 2 ** Math.min(4, failures - 1)
  }
  const clearSnapshot = () => { stop(); clearRetries(); rejectedPrepared.clear();capture = null; foregroundCapture = null;captureRecovery=false;pendingContextCompaction=null }
  const reset = () => { epoch++;activeModel=null;boundary.disarm();pendingReplacement=null;capacityWaiters.clear(); activityCleanup?.();activitySignal=undefined;protectionAbort=false;sessionController.abort(Error('Pi 会话已切换或结束')); sessionController = new AbortController(); clearSnapshot(); swapping = null }
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
  const fixedRequestTokens=payload=>fixedPiRequestTokens(payload)
  const reached = (ctx, ratio) => { const u = usage(ctx),tokens=capacity(ctx)?.observed||0; return Number.isFinite(u.window) && u.window > 0 && tokens >= u.window * ratio }
  function capacity(ctx, current = entries(ctx)) {
    activeModel ??= modelIdentity(ctx)
    const u = usage(ctx)
    if (!Number.isFinite(u.window) || u.window <= 0) return null
    const reserve = Number.isFinite(ctx.model?.maxTokens) ? Math.max(0, ctx.model.maxTokens) : Math.min(16384, u.window * .1)
    const inputLimit = Math.max(0, u.window - piCompletionBudget(ctx.model,policy().ratio,reserve) - piWindowSafety(ctx.model,policy().ratio))
    const whole = estimatePiMessages(piDialogueMessages(current),ctx.model)
    const active = pi.getActiveTools?.(), tools = (pi.getAllTools?.() || []).filter(t => !active || active.includes(t.name))
    const declared = Math.max(estimateSummaryTokens(ctx.getSystemPrompt?.() || '') + estimateSummaryTokens(JSON.stringify(tools)),estimatePiMessages(current.flatMap(e=>e.messages.filter(m=>m.role==='system'))))
    const measured = measuredPiContextTokens(current, ctx.model, u.tokens, ctx.sessionManager.getBranch?.())
    // Fixed prompts/tools are not compressible. Never subtract them from the
    // summary budget or pretend that replacing old dialogue removes them.
    const fixed = Math.max(declared, (measured ?? 0) - whole, 0)
    const estimated=fixed+whole
    // Pi's public usage combines provider receipts with newly appended input.
    // JSON previews/details can substantially exceed the actual wire tokens;
    // reserve them for cold starts, rather than aborting a measured safe turn.
    const hasReceipt=current.some(e=>e.messages.some(m=>m.role==='assistant'&&!['error','aborted'].includes(m.stopReason)&&['input','output','cacheRead','cacheWrite'].some(k=>m.usage?.[k]>0)))
    const observed=hasReceipt&&Number.isFinite(measured)&&measured>0?Math.max(measured,declared):estimated
    return { inputLimit, guard: Math.min(u.window * Math.max(.9,policy().ratio), inputLimit), fixed, estimated,observed }
  }
  const danger = (ctx, current = entries(ctx)) => {
    const c = capacity(ctx, current)
    return c && (usage(ctx).tokens >= c.guard || c.observed >= c.inputLimit)
  }
  const wireInput = (ctx,payload,c=capacity(ctx),history=capture?.messages) => {
    const calibrated=foregroundCapture?.signature===signature(ctx)?estimatePiWireWithReceipt(payload,foregroundCapture,entries(ctx),c?.observed,ctx.model):null
    return calibrated??estimatePiRequest(payload,{history,model:ctx.model})
  }
  const pause = (ctx,reason='capacity') => {
    try{const c=capacity(ctx);pi.appendEntry?.('superlcm-compaction-pause',{reason,tokens:usage(ctx).tokens,observed:c?.observed,projection:c?.estimated,inputLimit:c?.inputLimit,capturedWire:capture?estimatePiRequest(capture.payload):null,attempt:state?.attempt||0,lastFailure:state?.lastFailure?.message||null})}catch{}
    status(ctx, 'SuperLCM：已暂停，防止上下文超限')
    const preparation=state?.promise?(state.retryAt>Date.now()?'后台摘要会自动重试。':'正在后台准备摘要。'):'后台摘要尚未就绪。'
    notice(ctx,reason==='fixed-overhead'?'系统提示或工具定义已超出模型窗口，请减少工具或更换大窗口模型。原文完整保留。':'上下文保护已暂停模型请求。'+preparation+'原文和当前请求已保留。')
    protectionAbort=!!ctx.signal;ctx.abort?.()
  }
  const staleSnapshot = (ctx, current, snap, summaryTokens = 0, forcePrefix = false) => {
    const u = usage(ctx), p = policy()
    if (!snap || !Number.isFinite(u.window) || u.window <= 0 || (forcePrefix && snap.leafId === ctx.sessionManager.getLeafId())) return false
    const cut = current.findIndex(e => e.sourceEntry.id === snap.firstKeptEntryId)
    if (cut <= 0) return true
    const tail = estimatePiMessages(piDialogueMessages(current.slice(cut)), ctx.model)
    const maxTail = Math.min(u.window * Math.max(.2, Math.round((p.ratio - .55) * 1e12) / 1e12), Math.max(90000, (p.keep || 20000) + u.window * .12))
    if (tail + summaryTokens < maxTail) return false
    const next = makeSnapshot(ctx, p, settings())
    return !!next && next.firstKeptEntryId !== snap.firstKeptEntryId && (next.sourceTokens ?? 0) - (snap.sourceTokens ?? 0) >= Math.min(u.window * .1, 40000)
  }
  function prepare(ctx, force = false) {
    try {
      reportReplacement(ctx)
      bindActivity(ctx)
      if(ctx.signal?.aborted)return
      const p = policy()
      if (!p.enabled&&!p.summaryEnabled) { stop(); status(ctx, undefined); return }
      if (state && (!valid(ctx) || (state.ready && staleSnapshot(ctx, entries(ctx), state.snapshot, estimateSummaryTokens(state.ready.compaction?.summary || ''), state.forcePrefix)))) {
        if (state.ready && state.snapshot?.draftKey) rejectedPrepared.add(state.snapshot.draftKey)
        stop()
      }
      if (retrySignature && retrySignature !== signature(ctx)) clearRetries()
      if(retryAfter===Infinity&&blockedPayload&&capture?.payload&&blockedPayload!==piDigest(capture.payload))clearRetries()
      if (state || Date.now() < retryAfter || (!force && !reached(ctx, Math.round((p.ratio-.1)*1e12)/1e12))) return
      const available=force?capacity(ctx):null
      const keepLimit=available?Math.max(0,Math.floor((available.inputLimit-available.fixed)/2)):Infinity
      let snapshot = makeSnapshot(ctx, p, settings(),{keepLimit})
      if (!snapshot) return
      let selectedCapture=capture
      const current = { snapshot, controller: new AbortController(), ready: null, promise: null,attempt:0 }
      state = current; status(ctx, undefined)
      const work = async (signal,progress) => {
        if (p.summaryMode !== 'main-fork') return request({ ...options, command: 'pi-prepare' }, snapshot, signal)
        let restored=null
        if(!current.ignorePrepared)try{
          restored=await request({ ...options, command: 'pi-ready' }, {session_id:snapshot.session_id,draftKey:snapshot.draftKey,allowEarlier:true}, signal)
          if(restored&&rejectedPrepared.has(restored.draftKey))restored=null
          if(restored?.snapshot){
            // A completed capacity-resized draft may have a different key from
            // the default selection after restart. Rebuild its exact boundary;
            // the stored prefix and current model/settings must still agree.
            const saved=restored.snapshot
            const aligned=restored.compaction?.firstKeptEntryId===saved.firstKeptEntryId&&snapshotMatches(saved,entries(ctx),signature(ctx))?makeSnapshot(ctx,p,settings(),{keepLimit,firstKeptEntryId:saved.firstKeptEntryId}):null
            if(aligned?.draftKey===restored.draftKey&&!staleSnapshot(ctx,entries(ctx),aligned,estimateSummaryTokens(restored.compaction?.summary||''),saved.leafId===snapshot.leafId)){snapshot=aligned;current.snapshot=aligned}
            else restored=null
          }
        }
        catch(error){if(signal.aborted||!(error instanceof SyntaxError))throw error;current.ignorePrepared=true}
        if (restored?.compaction) return restored
        if(!selectedCapture)selectedCapture=capture
        if(!selectedCapture||['id','provider','contextWindow','maxTokens','api','baseUrl'].some(key=>selectedCapture.model?.[key]!==ctx.model?.[key])||normalizePiReasoning(selectedCapture.reasoning)!==normalizePiReasoning(settings().thinkingLevel)||!!selectedCapture.blockImages!==!!settings().images?.blockImages)throw Object.assign(Error('Pi 等待捕获当前模型请求后恢复后台摘要'),{code:'SUPERLCM_PI_CAPTURE_INVALID'})
        // Generation and archive submission are separate phases. A transient
        // save failure retries the same completed output, never the model.
        if(!current.generated){
          let staged
          const forkSummary=await fork(ctx,snapshot,selectedCapture,{signal,progress,forcePrefix:!!current.forcePrefix,previousFailure:current.lastErrorKind||null,isCurrent:()=>state===current&&valid(ctx),
            stage:async()=>{
              staged=await request({...options,command:'pi-stage'},snapshot,signal)
              if(state!==current||!valid(ctx))throw Object.assign(Error('Pi 后台分支来源或设置已变化，原文保留'),{code:'SUPERLCM_PI_CAPTURE_INVALID'})
              return staged
            }})
          signal.throwIfAborted()
          if(state!==current||!valid(ctx))throw Object.assign(Error('Pi 后台分支已过期'),{code:'SUPERLCM_PI_CAPTURE_INVALID'})
          current.generated={forkSummary,forkRevision:staged.revision}
        }
        let prepared
        try{prepared=await request({ ...options, command: 'pi-prepare' }, { ...snapshot, sourceMessages: undefined, ...current.generated }, signal)}
        catch(error){
          // A root summary that exceeded the foreground budget shrinks the prefix;
          // a rejected tree/source will not become valid by resubmitting it.
          if(!signal.aborted){
            const msg=String(error.message||error)
            if(/摘要仍超出预算|没有缩短原文|未能缩短/.test(msg))error.code='SUPERLCM_PI_PREFIX_CAPACITY'
            else if(!/database is locked|SQLITE_BUSY|SQLITE_LOCKED|EAGAIN|EBUSY|超时|timed? ?out/i.test(msg))error.code='SUPERLCM_PI_INVALID_SUMMARY'
          }
          throw error
        }
        rejectedPrepared.delete(snapshot.draftKey)
        return prepared
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
            if(error.code==='SUPERLCM_PI_PREFIX_CAPACITY'&&p.summaryMode==='main-fork'&&!current.controller.signal.aborted&&state===current&&valid(ctx)){
              const sourceLimit=Math.floor(snapshot.sourceTokens*.8)
              let next=makeSnapshot(ctx,p,settings(),{keepLimit,sourceLimit})
              if(!next||next.firstKeptEntryId===snapshot.firstKeptEntryId||next.sourceTokens>=snapshot.sourceTokens)
                next=makeSnapshot(ctx,p,settings(),{keepLimit,beforeFirstKeptEntryId:snapshot.firstKeptEntryId})
              if(next&&next.firstKeptEntryId!==snapshot.firstKeptEntryId&&next.sourceTokens<snapshot.sourceTokens){
                try{pi.appendEntry?.('superlcm-summary-resize',{sourceLeaf:snapshot.leafId,previousCut:snapshot.firstKeptEntryId,firstKeptEntryId:next.firstKeptEntryId,sourceTokens:next.sourceTokens})}catch{}
                snapshot=next;current.snapshot=next;current.ignorePrepared=false;current.forcePrefix=true;current.generated=null
                continue // The rejected request never left the SDK; no timed retry.
              }
              error=Object.assign(Error('完整消息组与系统或工具定义无法放入后台摘要窗口。原文保留，请减少固定内容或选择更大窗口的摘要模型。'),{code:'SUPERLCM_PI_UNSHRINKABLE_PREFIX'})
            }
            if(selectedCapture||error.code!=='SUPERLCM_PI_CAPTURE_INVALID')try{pi.appendEntry?.('superlcm-summary-failure',{attempt:current.attempt,sourceLeaf:snapshot.leafId,code:error.code||null,message:String(error.message||error).slice(0,2000)})}catch{}
            if(error.code==='SUPERLCM_PI_CAPTURE_INVALID'){
              if(capture===selectedCapture)capture=null
              throw error
            }
            if(terminalFailure(error))throw error
            if(p.summaryMode!=='main-fork'||current.controller.signal.aborted||state!==current||!valid(ctx))throw error
            if(result?.compaction){current.ignorePrepared=true;current.generated=null}
            current.lastErrorKind=error instanceof SyntaxError?'invalid_json':error.code==='SUPERLCM_PI_INVALID_SUMMARY'?'invalid_summary':null
            current.lastFailure={attempt:current.attempt,message:String(error.message||error),at:Date.now()}
            failed(ctx)
            const delay=Math.min(300000,Math.max(0,retryAfter-Date.now()))
            current.retryAt=Date.now()+delay
            status(ctx,`SuperLCM：第 ${current.attempt} 次摘要未完成，${Math.ceil(delay/1000)} 秒后自动重试：${current.lastFailure.message.slice(0,160)}`)
            notice(ctx,`后台摘要失败：${current.lastFailure.message.slice(0,200)}。${Math.ceil(delay/1000)} 秒后重试。`)
            await retryDelay(delay,current.controller.signal)
          }
        }
      }
      current.promise = run().then(result => {
        if (state !== current) return
        if (!valid(ctx)) { stop(); return }
        if (!result?.compaction) throw Error('Pi 后台摘要未返回完整结果，原文保留')
        current.ready = result; clearRetries(); status(ctx, undefined)
        if (!capacityWaiters.size&&takeoverEnabled(ctx)&&ctx.isIdle() && (reached(ctx, policy().ratio) || danger(ctx))) void swapIdle(ctx)
      }).catch(error => {
        if (state !== current) return
        state = null
        if(error.code==='SUPERLCM_PI_CAPTURE_INVALID'){
          clearRetries();status(ctx,undefined)
          if(capture&&capture!==selectedCapture)prepare(ctx)
          return
        }
        if(terminalFailure(error)){
          retrySignature=signature(ctx);retryAfter=Infinity
          if(['SUPERLCM_PI_UNSHRINKABLE_PREFIX','SUPERLCM_PI_INVALID_BUDGET'].includes(error.code))blockedPayload=piDigest(selectedCapture?.payload||capture?.payload||null)
          status(ctx,'SuperLCM：后台摘要已停止自动重试');notice(ctx,error.message);return
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
    catch { rejectedPrepared.add(selected.snapshot.draftKey);stop(); failed(ctx); return null }
    if (compaction.firstKeptEntryId !== selected.snapshot.firstKeptEntryId || estimateSummaryTokens(compaction.summary) >= (selected.snapshot.sourceTokens??estimateSummaryTokens(selected.snapshot.source))) {
      rejectedPrepared.add(selected.snapshot.draftKey);stop(); failed(ctx); return null
    }
    const c = capacity(ctx, current), cut = current.findIndex(e => e.sourceEntry.id === selected.snapshot.firstKeptEntryId)
    const tail = estimatePiMessages(piDialogueMessages(current.slice(cut)),ctx.model), summaryTokens = estimateSummaryTokens(compaction.summary)
    if (!c || c.fixed + tail + summaryTokens + extra >= c.inputLimit || staleSnapshot(ctx, current, selected.snapshot, summaryTokens, selected.forcePrefix)) {
      rejectedPrepared.add(selected.snapshot.draftKey);stop(); status(ctx, 'SuperLCM：旧摘要覆盖不足，后台重新准备'); return null
    }
    const measuredBefore = measuredPiContextTokens(current, ctx.model, ctx.getContextUsage()?.tokens, ctx.sessionManager.getBranch?.())
    return { ...compaction, tokensBefore: measuredBefore || ctx.getContextUsage()?.tokens || compaction.tokensBefore,
      details: { ...compaction.details, backgroundPrepared: true, replacementModelCalls: 0 } }
  }
  async function guardedReady(ctx, current = entries(ctx), extra = 0,force=false) {
    const c = capacity(ctx, current)
    if (!force&&!danger(ctx, current) && (!c || c.observed + extra < c.inputLimit)) return null
    status(ctx, undefined)
    const selectedEpoch = epoch
    const waiter={};capacityWaiters.add(waiter)
    try {
      const run=async signal => {
        const waiting = state?.promise
        if (waiting) await abortable(waiting, signal)
        signal.throwIfAborted()
        let result = await ready(ctx, current, signal, extra)
        if (!result) {
          // A completed but insufficient draft may restage once. The wait is
          // cancellable and explicit non-replayable failures do not restart.
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
        try { ctx.compact({ onComplete: () => { if (epoch === selectedEpoch && !signal.aborted) { reportReplacement(ctx); if (state === selectedState) stop() }; resolve() },
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
      let compaction=await ready(ctx,entries(ctx),event.signal)
      if(epoch!==selectedEpoch)return {cancel:true}
      if(!compaction&&(event.reason==='overflow'||event.reason==='manual'||danger(ctx))){
        // Native overflow recovery runs after the failed foreground has ended.
        // Its own cancellation signal, not that old turn's signal, owns this wait.
        const signal=event.signal?AbortSignal.any([sessionController.signal,event.signal]):sessionController.signal
        const recovery={...ctx,signal}
        // A cold session has not exposed its complete request-processing chain.
        // Let its first foreground provider boundary capture and recover it;
        // never send an auxiliary request without those transformations.
        if(policy().summaryMode==='main-fork'&&!capture){
          if(event.reason==='manual')notice(ctx,'当前会话尚未捕获完整请求处理链；请先正常输入，发送前会安全准备摘要。原文保留。')
          return {cancel:true}
        }
        if(event.reason==='manual')clearRetries() // Explicit /compact may retry a stopped job once.
        prepare(recovery,true)
        compaction=await guardedReady(recovery,entries(ctx),0,true)
      }
      if (epoch !== selectedEpoch) return { cancel: true }
      if (compaction) {
        const before=event.preparation.tokensBefore
        pendingReplacement={...compaction,tokensBefore:before}
        return {compaction:{...compaction,tokensBefore:before,details:{...compaction.details,superlcmTokensBefore:before}}}
      }
      return { cancel: true }
    } catch (error) { if(epoch===selectedEpoch)notice(ctx, error.message);return { cancel: true } }
  })
  const boundaryDraft=(event,ctx,compaction,usedInRequest=false)=>{
    pendingReplacement={...compaction,confirmedAfterTokens:usedInRequest?measuredUsage(event.message,ctx):null}
    status(ctx,undefined)
    return {entries:[...(event.entries||[]),{type:'compaction',summary:compaction.summary,firstKeptEntryId:compaction.firstKeptEntryId,
      details:{...compaction.details,superlcmTokensBefore:compaction.tokensBefore},usage:compaction.usage}]}
  }
  pi.on('turn_end', async (event, ctx) => {
    const selectedEpoch = epoch
    try {
      // A request-time replacement is already in use. Finalize its durable
      // checkpoint even if that request was cancelled; never discard the tail.
      if(pendingContextCompaction){
        const selected=pendingContextCompaction;pendingContextCompaction=null
        if(snapshotMatches(selected.snapshot,event.context?.contextEntries||entries(ctx),signature(ctx)))
          return boundaryDraft(event,ctx,selected.compaction,true)
      }
      if(ctx.signal?.aborted)return
      const current=event.context?.contextEntries,pressure=current&&danger(ctx,current)
      if(takeoverEnabled(ctx)&&current&&(reached(ctx,policy().ratio)||pressure)){
        let compaction=await ready(ctx,current)
        if(epoch!==selectedEpoch)return
        if(!compaction&&pressure)compaction=await guardedReady(ctx,current)
        if(epoch!==selectedEpoch)return
        if(compaction)return boundaryDraft(event,ctx,compaction)
        if(pressure){pause(ctx);return}
      }
      prepare(ctx) // fire-and-forget while the foreground still fits
    } catch (error) { if (epoch !== selectedEpoch) return; notice(ctx, error.message); if (danger(ctx)) pause(ctx) }
  })
  for (const name of ['agent_settled', 'model_select', 'session_start']) pi.on(name, (_event, ctx) => {
    const nextModel = modelIdentity(ctx)
    if (name === 'session_start' || (name === 'model_select' && activeModel !== null && activeModel !== nextModel)) reset()
    activeModel = nextModel
    reportReplacement(ctx)
    if(_event?.aborted){if(protectionAbort){protectionAbort=false;return};stop();clearRetries();return}
    prepare(ctx); if (state?.ready) void swapIdle(ctx)
  })
  pi.on('input', async (event, ctx) => {
    // Queue ownership stays with Pi. A steering/follow-up message must not be
    // consumed as a custom archive entry while another turn is running.
    if(event.streamingBehavior)return
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
  // Arm the provider boundary, but never summarize or rewrite halfway through
  // Pi's context/payload handler chain. The effective provider calls finalRequest.
  pi.on('context_with_system', (_event, ctx) => {
    if(isPiAuxiliaryRequest())return
    try{if(policy().enabled||policy().summaryEnabled)return boundary.arm(ctx,_event.messages)}
    catch(error){notice(ctx,error.message);pause(ctx)}
  })
  async function finalRequest({raw,payload,model,messages,transformPayload,requestHeaders,signal},ctx){
    const selectedEpoch=epoch
    try{
      signal?.throwIfAborted()
      reportReplacement(ctx)
      const p=policy()
      if(!p.enabled&&!p.summaryEnabled)return payload
      if(p.summaryMode==='main-fork'){
        capture={payload:raw,messages,model:structuredClone(ctx.model),reasoning:normalizePiReasoning(pi.getThinkingLevel?.()),
          blockImages:!!settings().images?.blockImages,leafId:ctx.sessionManager.getLeafId(),signature:signature(ctx),transformPayload,requestHeaders}
      }
      const enabled=takeoverEnabled(ctx),c=capacity(ctx),safety=piWindowSafety(ctx.model,p.ratio)
      if(enabled)piOutputReserve(payload,ctx.model) // Reject invalid settings before purchasing background work.
      const input=Math.max(c?.observed||0,wireInput(ctx,payload,c,messages)),hardInput=ctx.model.contextWindow-safety-1024
      let finalMessages=messages
      if(enabled&&!p.summaryModel&&fixedRequestTokens(payload)>=hardInput)throw Object.assign(Error('Pi 固定请求内容超出窗口'),{pauseReason:'fixed-overhead'})
      const pressure=enabled&&input>=hardInput
      prepare(ctx,pressure||captureRecovery)
      captureRecovery=false
      if(enabled&&(pressure||reached(ctx,p.ratio))){
        const compaction=pressure?await guardedReady(ctx,entries(ctx),0,true):await ready(ctx)
        if(epoch!==selectedEpoch)throw Error('Pi 会话在请求准备期间已切换')
        signal?.throwIfAborted()
        if(compaction){
          const snapshot=state.snapshot
          const source=snapshot.sourceMessages?snapshot:{...snapshot,sourceMessages:piDialogueMessages(entries(ctx).slice(0,entries(ctx).findIndex(e=>e.sourceEntry.id===snapshot.firstKeptEntryId)))}
          const compacted=await piCompactedContext(source,compaction,messages,{converted:true,blockImages:!!settings().images?.blockImages})
          finalMessages=compacted
          const converted=await capturePiContext(ctx,compacted,settings().thinkingLevel,signal,{blockImages:!!settings().images?.blockImages})
          const field=value=>['messages','input','contents'].find(key=>Array.isArray(value?.[key]))||(Array.isArray(value?.context?.messages)?'context.messages':null)
          const name=field(raw)
          if(!name||field(converted.payload)!==name)throw Error('Pi 替换请求结构不兼容，原文保留')
          const rebuilt=name==='context.messages'?{...raw,context:{...raw.context,messages:converted.payload.context.messages}}:{...raw,[name]:converted.payload[name]}
          payload=await transformPayload(rebuilt)
          if(epoch!==selectedEpoch)throw Error('Pi 会话在请求替换期间已切换')
          signal?.throwIfAborted()
          pendingContextCompaction={snapshot,compaction}
        }else if(pressure)throw Error('Pi 摘要尚不可用，本次请求未发送，原文保留')
      }
      if(enabled){
        const requested=piOutputReserve(payload,ctx.model)
        const inputTokens=pendingContextCompaction?estimatePiRequest(payload,{history:finalMessages,model:ctx.model}):Math.max(c?.observed||0,wireInput(ctx,payload,c,finalMessages))
        const available=ctx.model.contextWindow-inputTokens-safety-1
        if(available<Math.min(1024,requested))throw Error('Pi 最终请求超出窗口，原文保留')
        payload=limitPiOutput(payload,ctx.model,Math.min(piCompletionBudget(ctx.model,p.ratio,requested),available))
        if(inputTokens+piOutputReserve(payload,ctx.model)+safety>=ctx.model.contextWindow)throw Error('Pi 最终请求超出窗口，原文保留')
      }
      if(capture&&!pendingContextCompaction)foregroundCapture={...capture,payload:structuredClone(payload)}
      return payload
    }catch(error){
      if(epoch===selectedEpoch&&!ctx.signal?.aborted){notice(ctx,error.message);pause(ctx,error.pauseReason)}
      throw error // Throw at the provider boundary, where Pi's hook runner cannot swallow it.
    }
  }
  pi.on('session_shutdown', () => {reset();boundary.close()})
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
