import {readFileSync,writeFileSync,renameSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
export const defaultConsolePort=8791
const locationFile=store=>join(store.dir,'console-listener.json')
export function consoleLocation(store,env=process.env) {
  let port=defaultConsolePort
  try {const value=JSON.parse(readFileSync(locationFile(store),'utf8'));if(Number.isSafeInteger(value.port)&&value.port>0&&value.port<=65535)port=value.port}catch{}
  const configured=env.SUPERLCM_CONSOLE_URL
  if(configured) {
    const url=new URL(configured)
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search)throw Error('SuperLcm 后台地址必须是不含凭据的 HTTP 地址')
    url.hash='compression/dsh'
    return {url:url.href,port}
  }
  return {url:null,port}
}
export function recordConsoleLocation(store,port) {
  const file=locationFile(store),temp=file+'.'+randomUUID()
  writeFileSync(temp,JSON.stringify({port})+'\n',{flag:'wx',mode:0o600});renameSync(temp,file)
}
