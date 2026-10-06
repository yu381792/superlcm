// Read DSH's composed tree, using its own installed YAML reader. !!js stays
// inert; --dump-config does not mount plugins, evaluate expressions or boot DSH.
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname,join, resolve } from 'node:path'
import {fileURLToPath} from 'node:url'
import { paths, findCli, runCommand as run, commandOptions } from './runtime.js'
import { compressionSnapshot } from './compression-status.js'
import { readControls } from '../dsh/controls-config.js'
import { presetCompactionLeaks } from './dsh-preset-compaction.js'
export function dshHome(env = process.env) { return resolve(env.DSH_HOME || join(paths(env).home, '.dsh')) }
export function dshHost(env = process.env) {
  const bin = findCli('dsh',env)
  if (!bin) throw Error('未找到 DSH，请先安装并启动一次 DSH')
  const shim=/\.(cmd|bat)$/i.test(bin)
  const entry=shim?join(resolve(bin,'..'),'node_modules','@deepseek-ai','dsh','lib','bin.js'):realpathSync(bin)
  const require = createRequire(entry), yaml = require('js-yaml')
  class Expression {constructor(value){this.value=value}}
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind:'scalar',
    construct:value=>new Expression(value),instanceOf:Expression,represent:value=>value.value })])
  return { bin:shim?process.execPath:bin,argsPrefix:shim?[entry]:[],require, yaml, schema, parse: text => yaml.load(text,{schema}) }
}
export function dshEntries(tree) {
  if (!Array.isArray(tree)) throw Error('无法识别 DSH 配置树')
  const entries=[]
  const walk = rows => { for (const row of rows || []) {
    if (row.disabled) continue
    entries.push(row)
    if (Array.isArray(row.config)) walk(row.config)
    if (Array.isArray(row.config?.plugins) && !/preset/.test(row.name || '')) walk(row.config.plugins)
  } }
  walk(tree); return entries
}
function ownDshFile(name,file){
  if(!new RegExp('/dsh/'+file+'\\.js$').test(String(name).replaceAll('\\','/')))return false
  try{const path=String(name).startsWith('file:')?fileURLToPath(name):name;return JSON.parse(readFileSync(join(dirname(dirname(path)),'package.json'),'utf8')).name==='superlcm-mcp'}catch{return false}
}
export const isDshEngine=e=>(!e.config?.archiveOnly&&['superlcm','superlcm/runtime'].includes(e.name))||['superlcm-mcp/dsh-engine','SuperLcm','@deepseek-ai/dsh-compaction-basic'].includes(e.name)||ownDshFile(e.name,'engine')
export const isDshArchive=e=>['superlcm','superlcm/runtime','superlcm-mcp/dsh'].includes(e.name)||ownDshFile(e.name,'archive')
export function inspectDshTree(tree) {
  const entries = dshEntries(tree)
  const engines = entries.filter(isDshEngine)
  const archives = entries.filter(isDshArchive)
  const entry = engines.find(x => x.name!=='@deepseek-ai/dsh-compaction-basic')
  const engine=entry?{...entry,config:{...entry.config,...readControls(entry.config?.controlFile)?.config}}:undefined
  const presetLeaks=presetCompactionLeaks(tree).length
  const archiveOnly=archives.some(e=>e.config?.archiveOnly===true)
  if(archiveOnly)return {configured:archives.length===1&&!entry&&engines.some(e=>e.name==='@deepseek-ai/dsh-compaction-basic'&&e.config?.auto!==false),archive_only:true,preset_compaction_leaks:0,engines:engines.length,archives:archives.length,enabled:false,route_ready:true,model:null}
  return { configured: engines.length === 1 && !!engine && archives.length === 1 && presetLeaks===0,
    preset_compaction_leaks:presetLeaks,
    engines: engines.length, archives: archives.length, enabled: engine?.config?.auto === true,
    route_ready: typeof engine?.config?.summarizationProvider === 'string' && !!engine.config.summarizationProvider.trim() && typeof engine?.config?.summarizationModel === 'string' && !!engine.config.summarizationModel.trim(),
    model: engine?.config?.summarizationModel || null }
}
export async function inspectDsh(store, { env = process.env, runCommand = run, parse } = {}) {
  const root = dshHome(env), bin = findCli('dsh', env), profilesRoot = join(root, 'profiles')
  const files = { profiles: profilesRoot, transcripts: join(root, 'sessions') }
  const snapshot = compressionSnapshot(store), profiles = []
  let command=bin,argsPrefix=[]
  let names = []; try { names = readdirSync(profilesRoot).filter(n => /^[\w.-]+$/.test(n) && existsSync(join(profilesRoot,n,'package.json'))) } catch {}
  if (bin && !parse) try {
    const host=dshHost(env);parse=host.parse;command=host.bin;argsPrefix=host.argsPrefix
  } catch {}
  await Promise.all(names.map(async name => {
    try {
      const folder = join(profilesRoot,name), manifest = JSON.parse(readFileSync(join(folder,'package.json'),'utf8'))
      const connected = manifest.dsh?.profile?.bundles?.includes('superlcm-mcp') === true
      let installed = null
      try { installed = JSON.parse(readFileSync(join(folder,'node_modules/superlcm-mcp/package.json'),'utf8')).version } catch {}
      if (!bin || !parse) { profiles.push({ profile: name, configured: false, error: '缺少 DSH 命令或配置解析器，无法核实压缩配置' }); return }
      const output = await runCommand(command, [...argsPrefix,'--profile', name, '--dump-config'], { ...commandOptions(env), timeout: 5000 })
      const config = inspectDshTree(parse(output.stdout))
      const globalEngine=dshEntries(parse(output.stdout)).find(e=>['superlcm-global','superlcm-global-compaction'].includes(e.id)&&(isDshEngine(e)||isDshArchive(e)))
      if(globalEngine)try{
        if(['superlcm','superlcm/runtime'].includes(globalEngine.name))installed=JSON.parse(readFileSync(join(root,'node_modules/superlcm/package.json'),'utf8')).version
        else {const path=globalEngine.name.startsWith('file:')?fileURLToPath(globalEngine.name):globalEngine.name;installed=JSON.parse(readFileSync(join(dirname(dirname(path)),'package.json'),'utf8')).version}
      }catch{}
      const live = snapshot.runtimes.filter(r => r.profile === name && r.live)
      const engine = live.find(r => r.kind === 'engine'), archive = live.find(r => r.kind === 'archive' && (config.archive_only||r.pid === engine?.pid))
      const running = !!installed && config.configured && !!archive && archive.version===installed && (config.archive_only||!!engine&&engine.version===installed)
      const state = !config.configured ? 'misconfigured' : !config.enabled ? 'disabled' : !config.route_ready ? 'missing-route' : !running ? 'awaiting-runtime' : !engine.enabled || !engine.route_ready ? 'runtime-mismatch' : 'enabled'
      profiles.push({ profile: name, connected:connected||!!globalEngine, global:!!globalEngine, ...config, installed_version: installed, running, state:connected||globalEngine?state:'not-connected', runtime_version: engine?.version || null })
    } catch { profiles.push({ profile: name, configured: false, state: 'misconfigured', error: 'DSH 配置读取失败；请在该界面检查插件配置' }) }
  }))
  profiles.sort((a,b) => a.profile.localeCompare(b.profile))
  const globalConfigured=profiles.length>0&&profiles.every(p=>p.global&&p.configured)
  const global={configured:globalConfigured,state:!globalConfigured?'not-connected':profiles.some(p=>p.state==='enabled')?'enabled':profiles.some(p=>p.state==='disabled')?'disabled':'awaiting-runtime'}
  return { root, files, global,detected: !!bin || names.length > 0, configured: profiles.some(p => p.configured),
    configuration_matches: profiles.some(p=>p.connected) && profiles.filter(p=>p.connected).every(p => p.configured), profiles, ...snapshot }
}
