import { applyTakeover } from './takeover.js'

export function enableSummaryOnly(store,harness,env=process.env) {
  if(harness==='claude-code')applyTakeover(store,{enabled:false},env)
  const existing=store.harnessSetting(harness)
  if(harness==='dsh'&&(!existing||existing.mode!=='api'&&store.integrationRevision(harness).revision===0)) {
    const donor=store.harnessSetting('codex')
    const model=donor?.mode==='api'&&donor.api_ref?store.apiModel(donor.api_ref):store.apiModels()[0]
    // Reuse an archive API chosen by the user, never a chat/compaction route.
    if(model)store.setHarnessSetting(harness,'api',null,null,null,model.id)
    else if(store.globalSetting()?.mode!=='api')store.setHarnessSetting(harness,'off')
    else store.clearHarnessSetting(harness)
  } else if(!existing&&!store.globalSetting())store.setHarnessSetting(harness,'cli')
  store.setIntegrationEnabled(harness,true)
}
