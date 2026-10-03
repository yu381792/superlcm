import { cpSync,existsSync,mkdirSync,readFileSync,symlinkSync } from 'node:fs'
import { dirname,join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
export const packageRoot=fileURLToPath(new URL('../',import.meta.url))
export const packageInfo=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'))
export function packageDirectory(require,name) {
  let path=dirname(require.resolve(name))
  while(dirname(path)!==path){if(existsSync(join(path,'package.json'))&&JSON.parse(readFileSync(join(path,'package.json'),'utf8')).name===name)return path;path=dirname(path)}
  throw Error('DSH 缺少运行时依赖：'+name)
}
export function installDshPackage(store,host) {
  const stage=join(store.dir,'dsh-packages',packageInfo.version+'-'+randomUUID())
  mkdirSync(stage,{recursive:true,mode:0o700})
  for(const file of ['package.json',...packageInfo.files])if(existsSync(join(packageRoot,file)))cpSync(join(packageRoot,file),join(stage,file),{recursive:true})
  for(const name of Object.keys(packageInfo.peerDependencies)){const target=join(stage,'node_modules',name);mkdirSync(dirname(target),{recursive:true});symlinkSync(packageDirectory(host.require,name),target,process.platform==='win32'?'junction':'dir')}
  return stage
}
export function removeManagedBlock(text,begin,end) {
  const start=text.indexOf(begin),finish=text.indexOf(end)
  if(start<0&&finish<0)return text
  if(start<0||finish<start||text.indexOf(begin,start+begin.length)>=0)throw Error('SuperLcm 托管配置段不完整，请先核对')
  return text.slice(0,start)+text.slice(finish+end.length).replace(/^\r?\n/,'')
}
