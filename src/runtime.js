import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
export const runCommand = promisify(execFile)
export const cliScript = new URL('./cli.js', import.meta.url)
// Safety ceiling for one summary call, not a setting. Segments are bounded by the 字数 setting (at most 48,000) plus
// record labels, and merges by fanout × 3,600, so real inputs stay well below this.
export const MAX_SUMMARY_INPUT = 64000
export const validModel = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,127}$/.test(id)
export function paths(env=process.env) {
  const home=env.HOME || env.USERPROFILE || homedir()
  return {home,codex:resolve(env.CODEX_HOME || join(home,'.codex')),claude:resolve(env.CLAUDE_CONFIG_DIR || join(home,'.claude'))}
}
export function findCli(name,env=process.env) {
  const override=name==='codex'?env.SUPERLCM_CODEX_CLI_BIN:name==='claude'?env.SUPERLCM_CLAUDE_CLI_BIN:null
  const candidate=override||name
  const home=paths(env).home
  const dirs=(env.PATH||'').split(delimiter).filter(Boolean).concat([join(home,'.local','bin'),join(home,'.npm-global','bin'),'/opt/homebrew/bin','/usr/local/bin',...(env.APPDATA?[join(env.APPDATA,'npm')]:[])])
  const files=isAbsolute(candidate)?[candidate]:dirs.flatMap(dir=>process.platform==='win32'?[join(dir,candidate+'.exe'),join(dir,candidate+'.cmd'),join(dir,candidate)]:[join(dir,candidate)])
  for(const file of files)try{accessSync(file,constants.X_OK);return file}catch{}
  return null
}
export const commandOptions = env => ({env,timeout:12000,maxBuffer:2*1024*1024,windowsHide:true})
