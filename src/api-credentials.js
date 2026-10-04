import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const keyFile=dir=>join(dir,'api-credentials.json')
const scopeValid=scope=>scope==='global'||/^harness:[a-z][a-z0-9-]{0,39}$/.test(scope)||/^model:[a-z0-9]{1,40}$/.test(scope)
function credentials(dir) {
  const file=keyFile(dir)
  if(!existsSync(file))return {}
  const stat=lstatSync(file)
  if(!stat.isFile() || stat.size>128*1024 || (process.platform!=='win32' && (stat.mode&0o077)!==0) || (typeof process.getuid==='function' && stat.uid!==process.getuid()))throw new Error('API credential file must be a private regular file owned by this user')
  const value=JSON.parse(readFileSync(file,'utf8'))
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid API credential file')
  return value
}
export function apiKeyEndpoint(dir,scope) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  const value=credentials(dir)[scope]
  return value && typeof value==='object' && typeof value.endpoint==='string' ? value.endpoint : null
}
export function readApiKey(dir,scope,endpoint) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  const value=credentials(dir)[scope]
  if(value && typeof value==='object') {
    if(endpoint !== undefined && value.endpoint !== endpoint)return null
    return typeof value.key==='string'&&value.key.length>=8?value.key:null
  }
  return typeof value==='string'&&value.length>=8?value:null
}
export function saveApiKey(dir,scope,key,endpoint=null) {
  if(!scopeValid(scope)||typeof key!=='string'||key.length<8||key.length>4096||/[\r\n\0]/.test(key)||!key.trim())throw new Error('API key must be 8–4096 nonempty characters without line breaks')
  if(endpoint!==null&&(typeof endpoint!=='string'||endpoint.length>2048))throw new Error('Invalid API credential endpoint')
  const next={...credentials(dir),[scope]:endpoint===null?key:{key,endpoint}}
  const file=keyFile(dir),temp=join(dir,`.api-credentials-${randomBytes(12).toString('hex')}.tmp`)
  try {writeFileSync(temp,JSON.stringify(next),{flag:'wx',mode:0o600});renameSync(temp,file)}
  catch(error){try{unlinkSync(temp)}catch{};throw error}
  return true
}
export function removeApiKey(dir,scope) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  const current=credentials(dir);if(!(scope in current))return false
  const {[scope]:_,...next}=current,file=keyFile(dir),temp=join(dir,`.api-credentials-${randomBytes(12).toString('hex')}.tmp`)
  try {writeFileSync(temp,JSON.stringify(next),{flag:'wx',mode:0o600});renameSync(temp,file)}
  catch(error){try{unlinkSync(temp)}catch{};throw error}
  return true
}
