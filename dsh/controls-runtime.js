import { readControls } from './controls-config.js'
import { summaryContext } from './summary-model.js'
export function watchControls(engine,ctx,file,initial) {
  if(!file)return
  engine.controlFile=file
  engine.controlRevision=initial?.revision||''
  if(initial)engine.compressionReporter.applied(initial.revision)
  // Keep the native plugin form out of the UI: this document is edited in
  // SuperLcm, so there is no second set of per-profile controls.
  ctx.inject(['settings'],child=>child.effect(()=>child.settings.configure({auto:false},ctx.fiber)))
  let busy=false,closed=false,current={ctx:engine.summaryContext,ready:engine.summaryModelReady,dispose:engine.disposeSummary,users:0},failed=''
  const retired=new Set()
  function dispose(slot){slot.dispose?.();retired.delete(slot)}
  engine.acquireSummary=()=>{
    const slot=current;slot.users++
    return {...slot,config:{...engine.config},fallback:{...engine.fallbackSummarizationRoute},release(){slot.users--;if(slot.retired&&!slot.users)dispose(slot)}}
  }
  engine.reloadControls=async()=>{
    if(busy||closed)return
    busy=true
    let pending
    try {
      const next=readControls(file)
      if(!next||next.revision===engine.controlRevision)return
      const changed=JSON.stringify(next.config.summaryAdapter)!==JSON.stringify(engine.controlAdapter)
      if(changed){pending=summaryContext(ctx,next.config.summaryAdapter);await pending.ready}
      if(closed){pending?.dispose();return}
      // A result prepared under old settings must never replace live context
      // after the user changes the model, retention or switch.
      for(const controller of engine.backgroundControllers)controller.abort(new Error('压缩设置已更新'))
      if(pending){const old=current;current={...pending,users:0};old.retired=true;retired.add(old);if(!old.users)dispose(old);engine.summaryContext=current.ctx;engine.summaryModelReady=current.ready}
      engine.config={...engine.config,auto:next.config.auto}
      engine.applyRuntimeConfig(next.config)
      engine.controlAdapter=next.config.summaryAdapter
      engine.controlRevision=next.revision
      engine.compressionReporter.applied(next.revision)
      failed=''
    } catch {
      pending?.dispose()
      if(!failed){ctx.logger?.warn?.('SuperLcm 压缩设置未能加载，继续保留原设置');failed='failed'}
    } finally {busy=false}
  }
  engine.controlAdapter=initial?.config.summaryAdapter
  const timer=setInterval(()=>engine.reloadControls(),1000);timer.unref()
  ctx.effect(()=>()=>{closed=true;clearInterval(timer);for(const slot of retired)dispose(slot);dispose(current)})
}
