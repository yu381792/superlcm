// The console owns this private document. Native engines consume it at boot
// and while running; there is one document for every DSH launch mode.
import { readFileSync, existsSync } from 'node:fs'
export const controlFields = {
  tailCount:[1,10000,24], minRetainTokens:[0,2000000,32000],
  softActiveTokens:[1000,4000000,160000], hardActiveTokens:[1001,8000000,220000],
  pressureFoldTokens:[1,2000000,20000], foldBatchTokens:[1,4000000,64000],
  summaryPrefixTargetTokens:[0,2000000,0], condensedMinFanout:[2,100,4],
  summaryTimeoutMs:[1000,1800000,180000], summaryRetryCooldownMs:[1000,1800000,30000],
}
export function controlsConfig(raw) {
  if(!raw||typeof raw!=='object'||typeof raw.auto!=='boolean')throw Error('压缩开关无效')
  const out={auto:raw.auto}
  for(const [key,[min,max,fallback]] of Object.entries(controlFields)) {
    const value=raw[key]??fallback
    if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('压缩参数无效：'+key)
    out[key]=value
  }
  if(out.hardActiveTokens<=out.softActiveTokens)throw Error('强制压缩门槛必须大于开始压缩门槛')
  if(out.minRetainTokens>=out.softActiveTokens)throw Error('原文保留量必须小于开始压缩门槛')
  if(out.pressureFoldTokens>out.foldBatchTokens)throw Error('最小压缩批量不能超过每批处理量')
  if(raw.auto&&(typeof raw.summarizationProvider!=='string'||!raw.summarizationProvider||typeof raw.summarizationModel!=='string'||!raw.summarizationModel||!raw.summaryAdapter?.plugin))throw Error('请选择 DSH 已配置的压缩模型')
  return {...out,summarizationProvider:raw.summarizationProvider||'',summarizationModel:raw.summarizationModel||'',summaryAdapter:raw.summaryAdapter||null}
}
export function readControls(file) {
  if(!file||!existsSync(file))return null
  const value=JSON.parse(readFileSync(file,'utf8'))
  if(value.format!==1||typeof value.revision!=='string'||!value.revision)throw Error('压缩设置文件无效')
  return {...value,config:controlsConfig(value.config)}
}
