import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'

const source=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8')
const plain=value=>JSON.parse(JSON.stringify(value))
const escape=value=>String(value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]))

function harness(overrides={},language='zh') {
  const settings={revision:'current',enabled:false,provider_ref:'fixture-provider',model:'summary-model',controls_installed:true,archive_only:true,
    foldBatchTokens:20000,condensedMinFanout:4,summaryTimeoutMs:180000,summaryRetryCooldownMs:30000,
    softActiveTokens:160000,hardActiveTokens:220000,minRetainTokens:32000,tailCount:24,pressureFoldTokens:20000,summaryPrefixTargetTokens:0,
    catalog:{providers:[{ref:'fixture-provider',label:'Fixture provider',models:[{id:'summary-model',label:'Summary model'}]}]},...overrides}
  let nodes=[]
  const root={
    get innerHTML(){return this.html||''},
    set innerHTML(html){
      this.html=html
      nodes=[...html.matchAll(/<(input|button|select|p|span)\b([^>]*)>/g)].map(([,tag,raw])=>{
        const attrs=Object.fromEntries([...raw.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,value]))
        const dataset=Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]))
        return {tag,attrs,dataset,id:attrs.id,value:attrs.value||'',checked:/\schecked(?:\s|$)/.test(raw),disabled:/\sdisabled(?:\s|$)/.test(raw),
          setAttribute(key,value){this.attrs[key]=value},addEventListener(event,callback){this['on'+event]=callback}}
      })
    },
    querySelector(selector){return selector==='button'?nodes.find(node=>node.tag==='button'):nodes.find(node=>selector==='#'+node.id)||null},
    querySelectorAll(selector){return nodes.filter(node=>selector==='[data-dsh-field]'?node.dataset.dshField:selector==='[data-dsh-batch]'?node.dataset.dshBatch:false)}
  }
  const calls=[],toasts=[],owners=[]
  const context={
    $:selector=>selector==='#dshCompressionSettings'?root:root.querySelector(selector),esc:escape,
    t:(text,vars={})=>text.replace(/\{(\w+)\}/g,(match,key)=>vars[key]??match),
    admin:{compression:{runtimes:[]}},renderCompressionOwner:(_selector,enabled,pending)=>owners.push({enabled,pending}),
    api:async(url,body)=>{calls.push({url,body});if(body)Object.assign(settings,body);return {...settings}},toast:message=>toasts.push(message),act:callback=>callback(),show(){},openDshSetup(){},
    localStorage:{getItem:()=>language},navigator:{language},document:{documentElement:{}}
  }
  runInNewContext((language==='en'?source('web-i18n.js')+'\n':'')+source('web-dsh-controls.js')+'\nthis.ui={controls:dshControls,load:loadDshControls,save:saveDshControls}',context)
  const input=(key,value)=>{const node=root.querySelector('#dsh-'+key);node.value=String(value);node.oninput()}
  return {root,context,ui:context.ui,input,calls,toasts,owners,settings}
}

test('普通区显示自动比例策略，固定门槛和原文保留表单已移除',async()=>{
  const {ui,root}=harness()
  await ui.load()
  const html=root.innerHTML
  for(const key of ['softActiveTokens','hardActiveTokens','minRetainTokens','tailCount','pressureFoldTokens','summaryPrefixTargetTokens'])assert.doesNotMatch(html,new RegExp('id="dsh-'+key+'"'))
  assert.doesNotMatch(html,/dshKeepPercent|data-dsh-window|开始压缩门槛|强制压缩门槛|原文保留比例/)
  assert.match(html,/平时按摘要粒度在后台准备摘要，并逐层合并/)
  assert.match(html,/已扣除输出预留/);assert.match(html,/比例可以自行调整/)
  for(const [key,value] of [['prepareRatio','70'],['switchRatio','80'],['emergencyRatio','90']])assert.equal(root.querySelector('#dsh-'+key).value,value)
  assert.match(html,/近期原文保留量与压缩后的总预算，按当前会话模型容量自动计算/)
  assert.match(html,/摘要模型供应商/)
  assert.match(html,/摘要粒度（K）/)
  assert.deepEqual(root.querySelectorAll('[data-dsh-batch]').map(node=>Number(node.dataset.dshBatch)),[10000,20000,40000])
  assert.equal(root.querySelectorAll('[data-dsh-batch]')[1].attrs['aria-checked'],'true')
  assert.equal(root.querySelector('#dsh-foldBatchTokens').attrs.step,'1')
})

test('旧后台缺少粒度时显示 20K，保存明确选择比例策略并保持接管关闭',async()=>{
  const {ui,root,calls}=harness({foldBatchTokens:undefined,condensedMinFanout:undefined,summaryTimeoutMs:undefined,summaryRetryCooldownMs:undefined})
  await ui.load()
  assert.equal(root.querySelector('#dsh-foldBatchTokens').value,'20')
  assert.equal(root.querySelector('#dshControlsOn').checked,false)
  await ui.save()
  assert.deepEqual(plain(calls[1].body),{revision:'current',enabled:false,provider_ref:'fixture-provider',model:'summary-model',budgetMode:'ratio',prepareRatio:0.7,switchRatio:0.8,emergencyRatio:0.9,foldBatchTokens:20000})
  assert.equal(root.querySelector('#dshControlsOn').checked,false)
})

test('摘要粒度预设与整数输入保存到粒度字段，普通调整保持原模型和开关',async()=>{
  const {ui,root,input,calls}=harness()
  await ui.load()
  root.querySelectorAll('[data-dsh-batch]').find(node=>node.dataset.dshBatch==='40000').onclick()
  assert.equal(root.querySelector('#dsh-foldBatchTokens').value,'40')
  await ui.save()
  assert.equal(calls[1].body.foldBatchTokens,40000)
  input('foldBatchTokens',25)
  assert.ok(root.querySelectorAll('[data-dsh-batch]').every(node=>node.attrs['aria-checked']==='false'))
  await ui.save()
  assert.deepEqual(plain(calls[2].body),{revision:'current',enabled:false,provider_ref:'fixture-provider',model:'summary-model',budgetMode:'ratio',prepareRatio:0.7,switchRatio:0.8,emergencyRatio:0.9,foldBatchTokens:25000})
  assert.equal(ui.controls.draft.softActiveTokens,160000)
  assert.equal(ui.controls.draft.minRetainTokens,32000)
  assert.equal(root.querySelector('#dshControlsOn').checked,false)
})

test('高级设置只回传用户改过的项，接管开关由用户明确操作',async()=>{
  const {ui,root,input,calls}=harness()
  await ui.load()
  input('summaryTimeoutMs',120)
  input('summaryRetryCooldownMs',45)
  input('condensedMinFanout',6)
  root.querySelector('#dshControlsOn').onchange({target:{checked:true}})
  await ui.save()
  assert.deepEqual(plain(calls[1].body),{revision:'current',enabled:true,provider_ref:'fixture-provider',model:'summary-model',budgetMode:'ratio',prepareRatio:0.7,switchRatio:0.8,emergencyRatio:0.9,foldBatchTokens:20000,condensedMinFanout:6,summaryTimeoutMs:120000,summaryRetryCooldownMs:45000})
  root.querySelector('#dshControlsOn').onchange({target:{checked:false}})
  await ui.save()
  assert.deepEqual(plain(calls[2].body),{revision:'current',enabled:false,provider_ref:'fixture-provider',model:'summary-model',budgetMode:'ratio',prepareRatio:0.7,switchRatio:0.8,emergencyRatio:0.9,foldBatchTokens:20000})
  assert.equal(root.querySelector('#dshControlsOn').checked,false)
  assert.equal(ui.controls.draft.summaryTimeoutMs,120000)
  assert.equal(ui.controls.draft.summaryRetryCooldownMs,45000)
  assert.equal(ui.controls.draft.condensedMinFanout,6)
})

test('空值、无效数值、小数和超出范围的输入会显示错误并阻止保存',async()=>{
  const cases=[...['','NaN','Infinity','1e309',0,-2,20.5,4001].map(value=>['foldBatchTokens',value]),
    ['condensedMinFanout',1],['condensedMinFanout',2.5],['summaryTimeoutMs',0],['summaryTimeoutMs',1.5],['summaryRetryCooldownMs',1801]]
  for(const [key,value] of cases){
    const {ui,root,input,calls}=harness()
    await ui.load()
    input(key,value)
    await ui.save()
    assert.equal(calls.length,1,key+': '+value)
    assert.match(root.innerHTML,/<p role="alert">请为.*输入 .*之间的整数/)
    assert.equal(ui.controls.busy,false)
    assert.equal(ui.controls.draft.enabled,false)
  }
})

test('保存失败显示错误并保留用户填写的粒度和接管状态',async()=>{
  const {ui,root,input,context}=harness()
  await ui.load()
  input('foldBatchTokens',35)
  context.api=async()=>{throw Error('保存失败，请重新读取后再试 <提示>')}
  await ui.save()
  assert.match(root.innerHTML,/<p role="alert">保存失败，请重新读取后再试 &lt;提示&gt;<\/p>/)
  assert.equal(root.querySelector('#dsh-foldBatchTokens').value,'35')
  assert.equal(root.querySelector('#dshControlsOn').checked,false)
  assert.equal(ui.controls.busy,false)
})

test('比例策略、普通输入和高级设置都有英文翻译',async()=>{
  const {ui,root,input}=harness({},'en')
  await ui.load()
  assert.doesNotMatch(root.innerHTML,/[一-龥]/)
  assert.match(root.innerHTML,/70%.*80%/)
  input('foldBatchTokens',20.5)
  await ui.save()
  assert.doesNotMatch(root.innerHTML,/[一-龥]/)
  assert.match(root.innerHTML,/Enter a whole number.*Summary granularity/)
})

test('用户自定百分比保存为模型比例，关闭接管时也能保存并读回',async()=>{
  const {ui,root,input,calls}=harness({prepareRatio:.55,switchRatio:.75,emergencyRatio:.92})
  await ui.load()
  assert.equal(root.querySelector('#dsh-prepareRatio').value,'55')
  assert.equal(root.querySelector('#dsh-switchRatio').value,'75')
  assert.equal(root.querySelector('#dsh-emergencyRatio').value,'92')
  input('prepareRatio',65);input('switchRatio',85);input('emergencyRatio',95)
  await ui.save()
  assert.equal(calls[1].body.prepareRatio,.65);assert.equal(calls[1].body.switchRatio,.85);assert.equal(calls[1].body.emergencyRatio,.95)
  assert.equal(calls[1].body.enabled,false)
  assert.equal(root.querySelector('#dsh-switchRatio').value,'85')
})
test('百分比越界、小数和逆序被拦截，模型与当前开关保留',async()=>{
  for(const [key,value] of [['prepareRatio',0],['switchRatio',100],['emergencyRatio',90.5],['prepareRatio',80],['switchRatio',90],['emergencyRatio',79]]){
    const {ui,root,input,calls}=harness();await ui.load();input(key,value);await ui.save()
    assert.equal(calls.length,1);assert.match(root.innerHTML,/role="alert"/)
    assert.equal(ui.controls.draft.model,'summary-model');assert.equal(ui.controls.draft.enabled,false)
  }
})
