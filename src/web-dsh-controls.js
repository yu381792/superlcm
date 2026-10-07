// Daily DSH compaction controls live beside Claude's takeover controls.
const dshControls={value:null,draft:null,busy:false,loading:false,error:''}
const dshNumeric=[['foldBatchTokens','摘要粒度（K）',1000,1,4000,20000]]
const dshPercent=[['prepareRatio','摘要收口比例（%）',70],['switchRatio','上下文替换比例（%）',80],['emergencyRatio','安全等待比例（%）',90]]
const dshAdvanced=[['condensedMinFanout','旧摘要每组至少合并几段',1,2,100,4],['summaryTimeoutMs','摘要超时（秒）',1000,1,1800,180000],['summaryRetryCooldownMs','失败重试间隔（秒）',1000,1,1800,30000]]
function dshField([key,label,scale,min,max],draft,disabled) {
  const value=Number.isFinite(draft[key])?draft[key]/scale:''
  return '<label class="field">'+t(label)+'<input type="number" id="dsh-'+key+'" data-dsh-field="'+key+'" data-scale="'+scale+'" min="'+min+'" max="'+max+'" step="1" value="'+esc(value)+'"'+(disabled?' disabled':'')+'></label>'
}
function dshDraft(value){return {...value,...Object.fromEntries([...dshNumeric,...dshAdvanced].map(([key,,,,,fallback])=>[key,value[key]??fallback])),...Object.fromEntries(dshPercent.map(([key,,fallback])=>[key,value[key]??fallback/100]))}}
const dshPct=value=>Math.round(value*1e10)/1e8
function dshPercentField([key,label],draft,disabled){return '<label class="field">'+t(label)+'<input type="number" id="dsh-'+key+'" data-dsh-field="'+key+'" data-scale="0.01" min="1" max="99" step="1" value="'+esc(Number.isFinite(draft[key])?dshPct(draft[key]):'')+'"'+(disabled?' disabled':'')+'></label>'}
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
  root.innerHTML='<label class="toggle-row"><span><b>'+t('由 SuperLcm 接管压缩')+'</b><span>'+t('开启后由 SuperLcm 压缩；关闭后使用 DSH 原生压缩，后台摘要继续独立运行')+'</span></span><span class="switch"><input type="checkbox" id="dshControlsOn" role="switch"'+(draft.enabled?' checked':'')+(disabled?' disabled':'')+'><i></i></span></label>'+
    '<p class="desc">'+t('下方设置用于 SuperLcm 接管时的后台准备与上下文替换。')+'</p><div class="fields"><label class="field">'+t('摘要模型供应商')+'<select id="dshControlsProvider"'+(disabled?' disabled':'')+'><option value="">'+t('选择供应商')+'</option>'+providers.map(p=>'<option value="'+esc(p.ref)+'"'+(p.ref===draft.provider_ref?' selected':'')+(!p.models.length?' disabled':'')+'>'+esc(p.label)+'</option>').join('')+'</select></label><label class="field">'+t('摘要模型')+'<select id="dshControlsModel"'+(disabled?' disabled':'')+'><option value="">'+t('选择模型')+'</option>'+(selected?.models||[]).map(m=>'<option value="'+esc(m.id)+'"'+(m.id===draft.model?' selected':'')+'>'+esc(m.label)+'</option>').join('')+'</select></label></div>'+
    '<p class="desc">'+t('使用 dsh harness 已配置的模型和账号。生成摘要消耗所选模型额度，聊天模型保持原样。')+'</p><h3>'+t('自动压缩策略')+'</h3><p class="desc">'+t('平时按摘要粒度在后台准备摘要，并逐层合并。')+'</p><p class="desc">'+t('按本次聊天模型的可用输入容量计算，已扣除输出预留。摘要收口时完善草稿，达到替换比例后固定范围并在就绪时一次替换。')+'<div class="fields">'+dshPercent.map(f=>dshPercentField(f,draft,disabled)).join('')+'</div><p class="desc">'+t('三个比例可以自行调整，必须满足：摘要收口 < 上下文替换 < 安全等待。默认依次为 70%、80%、90%。')+'</p><p class="desc">'+t('近期原文保留量与压缩后的总预算，按当前会话模型容量自动计算。')+'</p><h3>'+t('摘要粒度')+'</h3><p class="desc">'+t('K 表示一千个词元，即模型计量文字长度的单位。默认按 20K 原文准备一段摘要，也可选择其他粒度或输入整数。')+'</p>'+
    '<div class="choice" role="radiogroup" aria-label="'+t('摘要粒度')+'">'+[10000,20000,40000].map(n=>'<button type="button" role="radio" data-dsh-batch="'+n+'" aria-checked="'+(draft.foldBatchTokens===n)+'"'+(disabled?' disabled':'')+'>'+n/1000+'K</button>').join('')+'</div><div class="fields">'+dshNumeric.map(f=>dshField(f,draft,disabled)).join('')+'</div>'+
    '<details class="how"><summary>'+t('高级压缩设置')+'</summary><div class="fields">'+dshAdvanced.map(f=>dshField(f,draft,disabled)).join('')+'</div></details>'+
    '<p id="dshControlStatus" class="notice calm" role="status"></p><div class="actions">'+(value.controls_installed?'<button type="button" class="btn primary" id="dshControlsSave"'+(dshControls.busy?' disabled':'')+'>'+t('保存压缩设置')+'</button>':'<button type="button" class="btn primary" id="dshSettingsUpdate">'+t(value.configured?'更新接入':'接入')+'</button>')+'<button type="button" class="btn" id="dshControlsRead"'+(dshControls.busy?' disabled':'')+'>'+t('重新读取')+'</button><span class="saved" id="dshControlsDirty"></span></div>'+(dshControls.error?'<p role="alert">'+esc(dshControls.error)+'</p>':'')
  root.querySelector('#dshSettingsUpdate')?.addEventListener('click',()=>openDshSetup())
  root.querySelector('#dshControlsRead').onclick=()=>act(loadDshControls)
  root.querySelector('#dshControlsOn').onchange=e=>{draft.enabled=e.target.checked;dirty()}
  root.querySelector('#dshControlsProvider').onchange=e=>{draft.provider_ref=e.target.value;draft.model='';renderDshControls();dirty()}
  root.querySelector('#dshControlsModel').onchange=e=>{draft.model=e.target.value;dirty()}
  for(const input of root.querySelectorAll('[data-dsh-field]'))input.oninput=()=>{
    const key=input.dataset.dshField
    draft[key]=input.value.trim()===''?NaN:input.dataset.scale==='0.01'?Number(input.value)/100:Number(input.value)*Number(input.dataset.scale)
    if(key==='foldBatchTokens')for(const button of root.querySelectorAll('[data-dsh-batch]'))button.setAttribute('aria-checked',String(draft.foldBatchTokens===Number(button.dataset.dshBatch)))
    dirty()
  }
  for(const button of root.querySelectorAll('[data-dsh-batch]'))button.onclick=()=>{draft.foldBatchTokens=Number(button.dataset.dshBatch);renderDshControls();dirty()}
  root.querySelector('#dshControlsSave')?.addEventListener('click',()=>act(saveDshControls))
  dshSettingsStatus()
}
function dirty(){$('#dshControlsDirty').textContent=t('有未保存的修改')}
function dshSettingsPayload(){
  const draft=dshControls.draft,before=dshDraft(dshControls.value)
  for(const [key,label,scale,min,max] of [...dshNumeric,...dshAdvanced]){
    const value=draft[key]/scale
    if(!Number.isSafeInteger(draft[key])||!Number.isInteger(value)||value<min||value>max)throw Error(t('请为{field}输入 {min} 到 {max} 之间的整数',{field:t(label),min,max}))
  }
  for(const [key,label] of dshPercent){
    const percent=dshPct(draft[key])
    if(!Number.isInteger(percent)||percent<1||percent>99)throw Error(t('请为{field}输入 {min} 到 {max} 之间的整数',{field:t(label),min:1,max:99}))
  }
  if(!(draft.prepareRatio<draft.switchRatio&&draft.switchRatio<draft.emergencyRatio))throw Error(t('比例顺序必须是：摘要收口 < 上下文替换 < 安全等待'))
  const payload={...Object.fromEntries(['revision','enabled','provider_ref','model'].map(key=>[key,draft[key]])),budgetMode:'ratio',foldBatchTokens:draft.foldBatchTokens,...Object.fromEntries(dshPercent.map(([key])=>[key,draft[key]]))}
  for(const [key] of dshAdvanced)if(draft[key]!==before[key])payload[key]=draft[key]
  return payload
}
async function loadDshControls(){if(dshControls.loading)return;dshControls.loading=true;try{dshControls.value=await api('/api/dsh-compression');dshControls.draft=dshDraft(dshControls.value);dshControls.error=''}catch(e){dshControls.value=null;dshControls.error=e.message}finally{dshControls.loading=false}renderDshControls()}
async function saveDshControls(){if(dshControls.busy)return;try{const payload=dshSettingsPayload();dshControls.busy=true;dshControls.error='';renderDshControls();dshControls.value=await api('/api/dsh-compression',payload);dshControls.draft=dshDraft(dshControls.value);toast(t(dshControls.value.restart_required?'接管设置已保存，请重新加载 DSH 使其生效':'压缩设置已保存'))}catch(e){dshControls.error=e.message}finally{dshControls.busy=false;renderDshControls()}}
