// DSH connection wizard; shares console helpers and state.
async function openDshSetup() {
  const h = state.harnesses.find(h=>h.harness==='dsh'), profiles=h?.dsh?.profiles || []
  let profile=profiles.some(p=>p.profile==='web')?'web':profiles[0]?.profile, preview=null, busy=false, done=false, message=''
  function render() {
    overlay('<div class="modal" role="dialog" aria-labelledby="dshSetupTitle"><div class="card"><div class="card-h"><div><h3 id="dshSetupTitle">'+t('接入 DSH')+'</h3><p>'+t('原生压缩、自动存档和跨载体接续，一次接好。')+'</p></div><button type="button" class="x" data-close'+(busy?' disabled':'')+'>×</button></div><div class="card-b">'+
      (!h?.bin || !profiles.length ? '<p>'+t('请先安装 DSH，并启动一次你要使用的界面，然后回来重新检测。')+'</p><p><a href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noopener">'+t('DSH 官方安装说明')+'</a></p>' :
        '<label class="field">'+t('使用界面')+'<select id="dshProfile"'+(busy||done?' disabled':'')+'>'+profiles.map(p=>'<option value="'+esc(p.profile)+'"'+(p.profile===profile?' selected':'')+'>'+esc(p.profile)+'</option>').join('')+'</select></label>'+
        '<p>'+t('只接入所选界面，其他界面的设置保持原样。')+'</p>'+
        (preview ? '<div class="fields"><label class="field">'+t('压缩模型提供方')+'<input id="dshProvider" value="'+esc(preview.provider)+'"'+(busy||done?' disabled':'')+'></label><label class="field">'+t('压缩模型')+'<input id="dshModel" value="'+esc(preview.model)+'"'+(busy||done?' disabled':'')+'></label></div><p>'+t('已填入 DSH 原来使用的模型。生成压缩摘要会使用该模型的调用额度。')+'</p><details><summary>'+t('接入内容')+'</summary><p>'+t('安装本地插件副本，启用 DSH 原生自动压缩，并将原文和摘要存入当前 SuperLcm 档案。原配置先备份；不会自动重启 DSH。')+'</p><div class="packet">'+esc(Object.values(preview.files).join('\n'))+'</div></details>' : ''))+
      (message?'<div class="notice calm"><span>'+esc(message)+'</span></div>':'')+
      '<div class="actions">'+(!done&&preview?'<button type="button" class="btn" id="dshPreview"'+(busy?' disabled':'')+'>'+t('更新预览')+'</button><button type="button" class="btn primary" id="dshApply"'+(busy||!preview.can_apply?' disabled':'')+'>'+t('安装并启用压缩')+'</button>':'')+'<button type="button" class="btn" data-close'+(busy?' disabled':'')+'>'+t('关闭')+'</button></div></div></div></div>',root=>{
        root.querySelector('#dshProfile')?.addEventListener('change',e=>{profile=e.target.value;refresh()})
        for(const field of ['#dshProvider','#dshModel']) root.querySelector(field)?.addEventListener('input',()=>{root.querySelector('#dshApply').disabled=true})
        root.querySelector('#dshPreview')?.addEventListener('click',()=>refresh({provider:root.querySelector('#dshProvider').value,model:root.querySelector('#dshModel').value}))
        root.querySelector('#dshApply')?.addEventListener('click',apply)
      })
  }
  async function refresh(route={}) {
    busy=true;message=t('正在检查…');render()
    try { preview=await api('/api/setup-preview',{harness:'dsh',profile,...route});message=preview.blocker||t('确认后，安装本地插件并启用原生压缩。') }
    catch(error){preview=null;message=error.message}
    finally {busy=false;render()}
  }
  async function apply() {
    busy=true;message=t('正在安装本地插件…');render()
    try {
      const result=await api('/api/setup-apply',{harness:'dsh',profile,provider:preview.provider,model:preview.model,revision:preview.revision,confirm:true})
      if(!result.configuration_verified) throw Error(t('接入验证未通过'))
      done=true;message=t('接入完成。重新加载所选 DSH 界面后，压缩、存档和查档工具即可使用。')
      await loadHarnesses()
    } catch(error){message=error.message}
    finally {busy=false;render()}
  }
  render();if(h?.bin&&profile)await refresh()
}

// Claude Code connects as a plugin: how it is connected, whether compaction can be taken over, and leftovers.
const kfmt = n => Math.round(n / 1000) + 'K'
