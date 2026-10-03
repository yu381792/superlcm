// One global connection, with choices from DSH's own provider/model catalog.
async function openDshSetup() {
  const h=state.harnesses.find(h=>h.harness==='dsh')
  let preview=null,busy=false,done=false,message=''
  function render() {
    const providers=preview?.catalog?.providers||[],selected=providers.find(p=>p.ref===preview?.provider_ref)
    overlay('<div class="modal" role="dialog" aria-labelledby="dshSetupTitle"><div class="card"><div class="card-h"><div><h3 id="dshSetupTitle">'+t('接入 dsh harness')+'</h3><p>'+t('全局接入一次，SuperLcm 接管压缩、自动存档和跨载体接续。')+'</p></div><button type="button" class="x" data-close'+(busy?' disabled':'')+'>×</button></div><div class="card-b">'+
      (!h?.bin?'<p>'+t('请先安装并启动 dsh harness，再回来接入。')+'</p><a href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noopener">'+t('dsh harness 官方安装说明')+'</a>':
      '<p>'+t('供应商和模型读取自 dsh harness 当前配置，无需安装旧压缩插件。')+'</p>'+
      (preview?'<div class="fields"><label class="field">'+t('压缩模型供应商')+'<select id="dshProvider"'+(busy||done?' disabled':'')+'><option value=""'+(!selected?' selected':'')+' disabled>'+t('选择供应商')+'</option>'+providers.map(p=>'<option value="'+esc(p.ref)+'"'+(p.ref===selected?.ref?' selected':'')+(!p.models.length?' disabled':'')+'>'+esc(p.label)+(p.models.length?'':' · '+t('暂无模型'))+'</option>').join('')+'</select></label><label class="field">'+t('压缩模型')+'<select id="dshModel"'+(busy||done||!selected?' disabled':'')+'><option value=""'+(!preview.model?' selected':'')+' disabled>'+t('选择模型')+'</option>'+(selected?.models||[]).map(m=>'<option value="'+esc(m.id)+'"'+(m.id===preview.model?' selected':'')+'>'+esc(m.label)+'</option>').join('')+'</select></label></div><p>'+t('生成压缩摘要会使用所选模型的调用额度，聊天模型保持原样。')+'</p><details><summary>'+t('接入内容')+'</summary><p>'+t('写入 dsh harness 全局接入配置，所有启动方式和之后新增的使用方式共用 SuperLcm 压缩与会话档案。原配置先备份，不自动重启 dsh harness。')+'</p></details>':''))+
      (message?'<div class="notice calm"><span>'+esc(message)+'</span></div>':'')+
      '<div class="actions">'+(!done&&preview?'<button type="button" class="btn" id="dshPreview"'+(busy?' disabled':'')+'>'+t('重新读取模型')+'</button><button type="button" class="btn primary" id="dshApply"'+(busy||!preview.can_apply?' disabled':'')+'>'+t('安装并启用 SuperLcm 压缩')+'</button>':'')+'<button type="button" class="btn" data-close'+(busy?' disabled':'')+'>'+t('关闭')+'</button></div></div></div></div>',root=>{
      root.querySelector('#dshProvider')?.addEventListener('change',e=>refresh({provider_ref:e.target.value,model:null}))
      root.querySelector('#dshModel')?.addEventListener('change',e=>refresh({provider_ref:preview.provider_ref,model:e.target.value}))
      root.querySelector('#dshPreview')?.addEventListener('click',()=>refresh({provider_ref:preview.provider_ref,model:preview.model}))
      root.querySelector('#dshApply')?.addEventListener('click',apply)
    })
  }
  async function refresh(route={}) {
    busy=true;message=t('正在读取 dsh harness 模型配置…');render()
    try {preview=await api('/api/setup-preview',{harness:'dsh',...route});message=preview.blocker||t('确认后将全局启用 SuperLcm 压缩接管和共享会话档案。')}
    catch(error){preview=null;message=error.message}
    finally{busy=false;render()}
  }
  async function apply() {
    busy=true;message=t('正在全局接入…');render()
    try {
      const result=await api('/api/setup-apply',{harness:'dsh',provider_ref:preview.provider_ref,model:preview.model,revision:preview.revision,confirm:true})
      if(!result.configuration_verified)throw Error(t('接入验证未通过'))
      done=true;message=t('全局接入完成。重新加载 dsh harness 后即可使用，无需逐个界面安装。');await loadHarnesses()
    }catch(error){message=error.message}
    finally{busy=false;render()}
  }
  render();if(h?.bin)await refresh()
}
