// Daily DSH compaction controls live beside Claude's takeover controls.
const dshControls={value:null,draft:null,busy:false,loading:false,error:''}
const dshNumeric=[['softActiveTokens','开始压缩门槛（K）',1000,1,4000],['minRetainTokens','最近原文至少保留（K）',1000,0,2000],['tailCount','近期消息至少保留（条）',1,1,10000]]
const dshAdvanced=[['hardActiveTokens','强制压缩门槛（K）',1000,1,8000],['foldBatchTokens','每批处理量（K）',1000,1,4000],['pressureFoldTokens','最小压缩批量（K）',1000,1,2000],['summaryPrefixTargetTokens','旧摘要预算（K，0 为自动）',1000,0,2000],['condensedMinFanout','旧摘要每组至少合并几段',1,2,100],['summaryTimeoutMs','压缩超时（秒）',1000,1,1800],['summaryRetryCooldownMs','失败后等待（秒）',1000,1,1800]]
function dshField([key,label,scale,min,max],draft,disabled) {
  return '<label class="field">'+t(label)+'<input type="number" id="dsh-'+key+'" data-dsh-field="'+key+'" data-scale="'+scale+'" min="'+min+'" max="'+max+'" step="'+(scale===1000?'0.001':'1')+'" value="'+draft[key]/scale+'"'+(disabled?' disabled':'')+'></label>'
}
function dshSettingsStatus() {
  const value=dshControls.value,node=$('#dshControlStatus');if(!node||!value)return
  const live=(admin.compression.runtimes||[]).filter(r=>r.live&&r.kind==='engine')
  const applied=value.controls_installed&&value.settings_revision&&live.length&&live.every(r=>r.settings_revision===value.settings_revision&&r.version===value.expected_version&&r.version===value.installed_version&&(admin.compression.runtimes||[]).some(a=>a.live&&a.kind==='archive'&&a.pid===r.pid&&a.profile===r.profile&&a.version===r.version))
  const acknowledged=applied&&live.every(r=>r.enabled===value.enabled&&r.route_ready!==false)
  const pending=value.archive_only?live.length>0:!acknowledged
  renderCompressionOwner('#dshCompressionOwner',value.enabled,pending)
  node.textContent=t(!value.controls_installed?'更新接入后，即可在这里管理压缩':value.archive_only&&!value.enabled?'当前使用 DSH 原生压缩；以下参数保存后仅用于 SuperLcm 接管':acknowledged?'设置已在运行中的 dsh harness 生效':pending?'压缩设置尚未应用，请重启或重新加载 DSH 插件':live.length?'设置已保存，等待 dsh harness 应用':'设置已保存，dsh harness 启动后自动应用')
}
function renderDshControls() {
  const root=$('#dshCompressionSettings'),value=dshControls.value,draft=dshControls.draft
  if(!value){root.innerHTML='<p class="muted">'+esc(dshControls.error||t('正在读取压缩设置…'))+'</p><button class="btn" type="button" id="dshSettingsConnect">'+t('去接入')+'</button>';root.querySelector('button').onclick=()=>show('connect');return}
  const disabled=dshControls.busy||!value.controls_installed,providers=value.catalog.providers,selected=providers.find(p=>p.ref===draft.provider_ref)
  const ratio=draft.softActiveTokens>0?Math.round(draft.minRetainTokens/draft.softActiveTokens*10000)/100:0
  root.innerHTML='<label class="toggle-row"><span><b>'+t('由 SuperLcm 接管压缩')+'</b><span>'+t('开启后由 SuperLcm 压缩；关闭后使用 DSH 原生压缩，后台摘要继续独立运行')+'</span></span><span class="switch"><input type="checkbox" id="dshControlsOn" role="switch"'+(draft.enabled?' checked':'')+(disabled?' disabled':'')+'><i></i></span></label>'+
    '<p class="desc">'+t('下方模型、门槛和保留量仅用于 SuperLcm 接管。关闭时保留 DSH 原生参数。')+'</p><div class="fields"><label class="field">'+t('压缩模型供应商')+'<select id="dshControlsProvider"'+(disabled?' disabled':'')+'><option value="">'+t('选择供应商')+'</option>'+providers.map(p=>'<option value="'+esc(p.ref)+'"'+(p.ref===draft.provider_ref?' selected':'')+(!p.models.length?' disabled':'')+'>'+esc(p.label)+'</option>').join('')+'</select></label><label class="field">'+t('压缩模型')+'<select id="dshControlsModel"'+(disabled?' disabled':'')+'><option value="">'+t('选择模型')+'</option>'+(selected?.models||[]).map(m=>'<option value="'+esc(m.id)+'"'+(m.id===draft.model?' selected':'')+'>'+esc(m.label)+'</option>').join('')+'</select></label></div>'+
    '<p class="desc">'+t('使用 dsh harness 已配置的模型和账号。生成摘要消耗所选模型额度，聊天模型保持原样。')+'</p><h3>'+t('压缩门槛与原文保留')+'</h3><p class="desc">'+t('K 表示一千个词元，即模型计量文字长度的单位。保留比例按压缩门槛换算，实际保留也会保护近期消息和完整工具调用。')+'</p>'+
    '<div class="choice" role="group" aria-label="'+t('压缩门槛')+'">'+[160000,200000,300000,500000].map(n=>'<button type="button" data-dsh-window="'+n+'" aria-checked="'+(draft.softActiveTokens===n)+'"'+(disabled?' disabled':'')+'>'+n/1000+'K</button>').join('')+'</div><div class="fields">'+dshNumeric.map(f=>dshField(f,draft,disabled)).join('')+'<label class="field">'+t('原文保留比例（%）')+'<input id="dshKeepPercent" type="number" min="0" max="99" step="0.01" value="'+ratio+'"'+(disabled?' disabled':'')+'></label></div>'+
    '<details class="how"><summary>'+t('高级压缩设置')+'</summary><div class="fields">'+dshAdvanced.map(f=>dshField(f,draft,disabled)).join('')+'</div></details>'+
    '<p id="dshControlStatus" class="notice calm" role="status"></p><div class="actions">'+(value.controls_installed?'<button type="button" class="btn primary" id="dshControlsSave"'+(dshControls.busy?' disabled':'')+'>'+t('保存压缩设置')+'</button>':'<button type="button" class="btn primary" id="dshSettingsUpdate">'+t(value.configured?'更新接入':'接入')+'</button>')+'<button type="button" class="btn" id="dshControlsRead"'+(dshControls.busy?' disabled':'')+'>'+t('重新读取')+'</button><span class="saved" id="dshControlsDirty"></span></div>'+(dshControls.error?'<p role="alert">'+esc(dshControls.error)+'</p>':'')
  root.querySelector('#dshSettingsUpdate')?.addEventListener('click',()=>openDshSetup())
  root.querySelector('#dshControlsRead').onclick=()=>act(loadDshControls)
  root.querySelector('#dshControlsOn').onchange=e=>{draft.enabled=e.target.checked;dirty()}
  root.querySelector('#dshControlsProvider').onchange=e=>{draft.provider_ref=e.target.value;draft.model='';renderDshControls();dirty()}
  root.querySelector('#dshControlsModel').onchange=e=>{draft.model=e.target.value;dirty()}
  for(const input of root.querySelectorAll('[data-dsh-field]'))input.oninput=()=>{
    const key=input.dataset.dshField,n=Math.round(Number(input.value)*Number(input.dataset.scale))
    if(key==='softActiveTokens')setDshWindow(n);else draft[key]=n
    if(key==='minRetainTokens')root.querySelector('#dshKeepPercent').value=Math.round(draft.minRetainTokens/draft.softActiveTokens*10000)/100
    dirty()
  }
  root.querySelector('#dshKeepPercent').oninput=e=>{draft.minRetainTokens=Math.round(draft.softActiveTokens*Number(e.target.value)/100);root.querySelector('#dsh-minRetainTokens').value=draft.minRetainTokens/1000;dirty()}
  for(const button of root.querySelectorAll('[data-dsh-window]'))button.onclick=()=>{setDshWindow(Number(button.dataset.dshWindow));renderDshControls();dirty()}
  root.querySelector('#dshControlsSave')?.addEventListener('click',()=>act(saveDshControls))
  dshSettingsStatus()
}
function dirty(){$('#dshControlsDirty').textContent=t('有未保存的修改')}
function setDshWindow(value){const draft=dshControls.draft,ratio=draft.softActiveTokens>0?draft.minRetainTokens/draft.softActiveTokens:0.2;draft.softActiveTokens=value;draft.minRetainTokens=Math.round(value*ratio);if(draft.hardActiveTokens<=value)draft.hardActiveTokens=Math.round(value*1.4);for(const key of ['softActiveTokens','minRetainTokens','hardActiveTokens']){const node=$('#dsh-'+key);if(node)node.value=draft[key]/1000}}
async function loadDshControls(){if(dshControls.loading)return;dshControls.loading=true;try{dshControls.value=await api('/api/dsh-compression');dshControls.draft={...dshControls.value};dshControls.error=''}catch(e){dshControls.value=null;dshControls.error=e.message}finally{dshControls.loading=false}renderDshControls()}
async function saveDshControls(){dshControls.busy=true;dshControls.error='';renderDshControls();try{dshControls.value=await api('/api/dsh-compression',Object.fromEntries(['revision','enabled','provider_ref','model',...dshNumeric.map(f=>f[0]),...dshAdvanced.map(f=>f[0])].map(k=>[k,dshControls.draft[k]])));dshControls.draft={...dshControls.value};toast(t(dshControls.value.restart_required?'接管设置已保存，请重新加载 DSH 使其生效':'压缩设置已保存'))}catch(e){dshControls.error=e.message}finally{dshControls.busy=false;renderDshControls()}}
