// Local-only fallback when DSH's package manager cannot resolve an already
// installed peer from its offline cache. Does not upgrade DSH or restart it.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, symlinkSync, realpathSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const [tarballArg, backupArg, replaceArg] = process.argv.slice(2)
if (!tarballArg || !backupArg) throw Error('Usage: node scripts/install-dsh-local.mjs <verified npm tarball> <backup directory>')
const tarball = resolve(tarballArg), backup = resolve(backupArg)
const root = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const host = createRequire(process.env.SUPERLCM_DSH_RUNTIME || join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json'))
const yaml = host('js-yaml'), sha = data => createHash('sha256').update(data).digest('hex')
const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64')
const target = join(root, 'profiles/node_modules/superlcm-mcp')
if (existsSync(target)) {
  if (replaceArg !== '--replace') throw Error('Target already exists; use --replace only for an explicitly authorized update: ' + target)
  const current = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  if (current.name !== 'superlcm-mcp') throw Error('Refusing to replace a different package')
}
mkdirSync(backup, { recursive: true, mode: 0o700 })
mkdirSync(dirname(target), { recursive: true })
const stage = join(root, 'profiles/node_modules/superlcm-mcp-stage-' + process.pid)
if (existsSync(stage)) throw Error('Staging path already exists: ' + stage)
mkdirSync(stage)
const extracted = spawnSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', stage], { encoding: 'utf8' })
if (extracted.status !== 0) { renameSync(stage, join(backup, 'failed-staged-package')); throw Error(extracted.stderr || 'Local package extraction failed') }
const pkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'))
if (pkg.name !== 'superlcm-mcp' || !pkg.dsh?.bundle?.patch) { renameSync(stage, join(backup, 'rejected-staged-package')); throw Error('Not a unified SuperLcm package') }
if (existsSync(target)) {
  renameSync(target, join(backup, 'previous-installed-package'))
}
renameSync(stage, target)
const reference = 'file:' + tarball, lockKey = 'superlcm-mcp@' + reference, changes = []
const edit = (profile, name, transform) => {
  const path = join(root, 'profiles', profile, name)
  if (!existsSync(path)) return
  const before = readFileSync(path), after = transform(before.toString('utf8'))
  const saved = join(backup, profile + '-before-local-' + name)
  copyFileSync(path, saved)
  writeFileSync(path, after)
  changes.push({ path, backup: saved, before_sha256: sha(before), after_sha256: sha(Buffer.from(after)) })
}
for (const profile of ['web','acp','headless']) {
  const link = join(root, 'profiles', profile, 'node_modules/superlcm-mcp')
  if (existsSync(link)) {
    if (realpathSync(link) !== realpathSync(target)) throw Error('Profile uses a different SuperLcm installation: ' + link)
  } else symlinkSync(target, link, 'dir')
  edit(profile, 'package.json', text => {
    const manifest = JSON.parse(text)
    delete manifest.dependencies.SuperLcm
    manifest.dependencies['superlcm-mcp'] = reference
    const bundles = manifest.dsh.profile.bundles.filter(name => name !== 'SuperLcm' && name !== 'superlcm-mcp')
    const base = bundles.indexOf('@deepseek-ai/dsh-base')
    bundles.splice(base + 1, 0, 'superlcm-mcp')
    manifest.dsh.profile.bundles = bundles
    return JSON.stringify(manifest, null, 2) + '\n'
  })
  edit(profile, 'pnpm-lock.yaml', text => {
    const lock = yaml.load(text), dependencies = lock.importers['.'].dependencies
    delete dependencies.SuperLcm
    dependencies['superlcm-mcp'] = { specifier: reference, version: reference }
    lock.packages[lockKey] = { resolution: { integrity, tarball: reference }, version: pkg.version, engines: pkg.engines, peerDependencies: pkg.peerDependencies, peerDependenciesMeta: pkg.peerDependenciesMeta }
    lock.snapshots[lockKey] = {}
    return yaml.dump(lock, { lineWidth: -1, noRefs: true })
  })
  edit(profile, 'package-lock.json', text => {
    const lock = JSON.parse(text)
    delete lock.packages[''].dependencies.SuperLcm
    lock.packages[''].dependencies['superlcm-mcp'] = reference
    lock.packages['node_modules/superlcm-mcp'] = { version: pkg.version, resolved: reference, integrity, license: pkg.license, engines: pkg.engines, bin: pkg.bin, peerDependencies: pkg.peerDependencies, peerDependenciesMeta: pkg.peerDependenciesMeta }
    return JSON.stringify(lock, null, 2) + '\n'
  })
  edit(profile, 'cordis.patch.yml', text => {
    const marker = '# 所有 DSH 界面共用 Claude、Codex 等工具的 SuperLcm 会话档案。'
    const start = text.indexOf(marker)
    if (start !== -1) {
      const oldBridge = text.slice(start)
      if (!oldBridge.includes('id: mcp-superlcm-archive') || /^- (?!insert:)/m.test(oldBridge)) throw Error('Review the old standalone MCP bridge before removing it')
      text = text.slice(0, start).trimEnd() + '\n'
    }
    text = text.replace(/(\bname:\s*)SuperLcm(?=\s*$)/gm, '$1superlcm-mcp/dsh-engine')
    if (profile === 'headless' && !text.includes('name: superlcm-mcp/dsh-engine')) {
      // The headless base previously used the conversation route for summaries.
      // Preserve that explicitly selected route; never copy Web's paid route.
      const route = /- id: agent-default-model\s+config:\s+provider: ([^\n]+)\s+model: ([^\n]+)/.exec(text)
      if (!route) throw Error('Headless summary route is not explicit; review the profile')
      text += '\n# 统一 SuperLcm 独占压缩；摘要沿用该界面原来选定的默认模型。\n- id: compaction-basic\n  disabled: true\n- insert:\n    - id: SuperLcm-compaction\n      name: superlcm-mcp/dsh-engine\n      config:\n        auto: true\n        summarizationProvider: ' + route[1] + '\n        summarizationModel: ' + route[2] + '\n'
    }
    return text
  })
}
writeFileSync(join(backup, 'local-install-receipt.json'), JSON.stringify({ version: pkg.version, tarball, integrity, installed: target, changes, oldPackage: 'retained for rollback, absent from active bundles', serviceRestarted: false }, null, 2) + '\n')
console.log(JSON.stringify({ installed: target, profiles: ['web','acp','headless'], backup, serviceRestarted: false }))
