// All connections archive and summarize; DSH keeps its own compaction service.
async function openDshSetup() {
  let preview=null,busy=false,done=false,message=t('正在检查本机配置…')
  const render=()=>overlay('<div class="modal" role="dialog" aria-labelledby="dshSetupTitle"><div class="card"><div class="card-h"><div><h3 id="dshSetupTitle">'+t('接入 dsh harness')+'</h3><p>'+t('自动归档、后台摘要和查询，压缩由 dsh harness 自身负责。')+'</p></div><button type="button" class="x" data-close'+(busy?' disabled':'')+'>×</button></div><div class="card-b"><p>'+t('全局接入一次，所有启动方式共用。后台摘要使用接入页面选择的模型，聊天模型保持原样。')+'</p><p>'+t('原配置先备份。旧接入禁用过的原生压缩会恢复，已有档案和摘要保留。')+'</p><div class="notice calm">'+esc(message)+'</div><div class="actions">'+(!done?'<button type="button" class="btn primary" id="dshApply"'+(busy||!preview?.can_apply?' disabled':'')+'>'+t('确认接入')+'</button>':'')+'<button type="button" class="btn" data-close'+(busy?' disabled':'')+'>'+t(done?'完成':'取消')+'</button></div></div></div></div>',root=>{
    root.querySelector('#dshApply')?.addEventListener('click',async()=>{
      busy=true;message=t('正在接入…');render()
      try {
        const result=await api('/api/setup-apply',{harness:'dsh',revision:preview.revision,confirm:true})
        if(!result.configuration_verified)throw Error(t('接入验证未通过'))
        done=true;message=t('接入完成。重新加载 dsh harness 后生效；可在接入卡片设置后台摘要。');await loadSettings();await loadHarnesses()
      }catch(e){message=e.message}finally{busy=false;render()}
    })
  })
  render()
  try{preview=await api('/api/setup-preview',{harness:'dsh'});message=preview.blocker||t('确认后只接入归档和后台摘要，不接管压缩。')}catch(e){message=e.message}
  render()
}
async function openDisconnect(harness) {
  let preview=null,busy=false,done=false,message=t('正在检查接入配置…')
  const render=()=>overlay('<div class="modal" role="dialog" aria-labelledby="disconnectTitle"><div class="card"><div class="card-h"><h3 id="disconnectTitle">'+t('取消接入')+' · '+esc(toolName(harness))+'</h3><button type="button" class="x" data-close'+(busy?' disabled':'')+'>×</button></div><div class="card-b"><p>'+t('停止自动归档和后台摘要，撤销 SuperLcm 的查询入口。全部已存对话、原文和摘要保留。')+'</p><p class="muted">'+t('压缩继续由工具自身负责。已打开的会话需要重新加载。')+'</p><div class="notice calm">'+esc(message)+'</div><div class="actions">'+(!done?'<button type="button" class="btn primary" id="disconnectApply"'+(busy||!preview?.can_apply?' disabled':'')+'>'+t('确认取消接入')+'</button>':'')+'<button type="button" class="btn" data-close'+(busy?' disabled':'')+'>'+t(done?'完成':'返回')+'</button></div></div></div></div>',root=>{
    root.querySelector('#disconnectApply')?.addEventListener('click',async()=>{
      busy=true;message=t('正在取消接入…');render()
      try {
        const result=await api('/api/disconnect-apply',{harness,revision:preview.revision,confirm:true})
        if(!result.configuration_verified)throw Error(t('取消接入尚未验证通过'))
        done=true;message=t('已取消接入，已有档案和摘要保留。重新加载工具后，查询入口也会移除。');await loadSettings();await loadHarnesses();renderStatus()
      }catch(e){message=e.message}finally{busy=false;render()}
    })
  })
  render();try{preview=await api('/api/disconnect-preview',{harness});message=preview.blocker||t('原配置先备份，只撤销 SuperLcm 的接入。')}catch(e){message=e.message}render()
}
