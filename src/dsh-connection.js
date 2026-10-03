// Read DSH's composed tree, using its own installed YAML reader. !!js stays
// inert; --dump-config does not mount plugins, evaluate expressions or boot DSH.
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { paths, findCli, runCommand as run, commandOptions } from './runtime.js'
import { compressionSnapshot } from './compression-status.js'
export function dshHome(env = process.env) { return resolve(env.DSH_HOME || join(paths(env).home, '.dsh')) }
export function inspectDshTree(tree) {
  if (!Array.isArray(tree)) throw Error('无法识别 DSH 配置树')
  const entries = []
  const walk = rows => { for (const row of rows || []) {
    if (row.disabled) continue
    entries.push(row)
    if (Array.isArray(row.config)) walk(row.config)
    if (Array.isArray(row.config?.plugins) && !/preset/.test(row.name || '')) walk(row.config.plugins)
  } }
  walk(tree)
  const engines = entries.filter(x => ['superlcm-mcp/dsh-engine','SuperLcm','@deepseek-ai/dsh-compaction-basic'].includes(x.name))
  const archives = entries.filter(x => x.name === 'superlcm-mcp/dsh')
  const engine = engines.find(x => x.name === 'superlcm-mcp/dsh-engine')
  return { configured: engines.length === 1 && !!engine && archives.length === 1,
    engines: engines.length, archives: archives.length, enabled: engine?.config?.auto === true,
    route_ready: !!engine?.config?.summarizationProvider?.trim() && !!engine?.config?.summarizationModel?.trim(),
    model: engine?.config?.summarizationModel || null }
}
export async function inspectDsh(store, { env = process.env, runCommand = run, parse } = {}) {
  const root = dshHome(env), bin = findCli('dsh', env), profilesRoot = join(root, 'profiles')
  const files = { profiles: profilesRoot, transcripts: join(root, 'sessions') }
  const snapshot = compressionSnapshot(store), profiles = []
  let names = []; try { names = readdirSync(profilesRoot).filter(n => /^[\w.-]+$/.test(n) && existsSync(join(profilesRoot,n,'package.json'))) } catch {}
  if (bin && !parse) try {
    const yaml = createRequire(realpathSync(bin))('js-yaml')
    const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: () => '[unevaluated expression]' })])
    parse = text => yaml.load(text, { schema })
  } catch {}
  await Promise.all(names.map(async name => {
    try {
      const folder = join(profilesRoot,name), manifest = JSON.parse(readFileSync(join(folder,'package.json'),'utf8'))
      if (!manifest.dsh?.profile?.bundles?.includes('superlcm-mcp')) return
      let installed = null
      try { installed = JSON.parse(readFileSync(join(folder,'node_modules/superlcm-mcp/package.json'),'utf8')).version } catch {}
      if (!bin || !parse) { profiles.push({ profile: name, configured: false, error: '缺少 DSH 命令或配置解析器，无法核实压缩配置' }); return }
      const output = await runCommand(bin, ['--profile', name, '--dump-config'], { ...commandOptions(env), timeout: 5000 })
      const config = inspectDshTree(parse(output.stdout))
      const live = snapshot.runtimes.filter(r => r.profile === name && r.live)
      const engine = live.find(r => r.kind === 'engine'), archive = live.find(r => r.kind === 'archive' && r.pid === engine?.pid)
      const running = !!installed && config.configured && !!engine && !!archive && engine.version === installed && archive.version === installed
      const state = !config.configured ? 'misconfigured' : !config.enabled ? 'disabled' : !config.route_ready ? 'missing-route' : !running ? 'awaiting-runtime' : !engine.enabled || !engine.route_ready ? 'runtime-mismatch' : 'enabled'
      profiles.push({ profile: name, ...config, installed_version: installed, running, state, runtime_version: engine?.version || null })
    } catch { profiles.push({ profile: name, configured: false, state: 'misconfigured', error: 'DSH 配置读取失败；请在该界面检查插件配置' }) }
  }))
  profiles.sort((a,b) => a.profile.localeCompare(b.profile))
  return { root, files, detected: !!bin || names.length > 0, configured: profiles.some(p => p.configured),
    configuration_matches: profiles.length > 0 && profiles.every(p => p.configured), profiles, ...snapshot }
}
