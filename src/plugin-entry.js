// When SuperLcm runs from the Claude plugin, its files sit in a versioned folder that Claude replaces (and
// deletes) on every plugin update. Codex and Pi are connected to one fixed file in the SuperLcm folder
// instead, which starts the current plugin copy and, if that copy is gone, the newest one Claude has installed.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { home } from './store.js'
const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
const root = dirname(dirname(cli))
// Claude's plugin cache: <config>/plugins/cache/<marketplace>/<plugin>/<version>/
export const fromPluginCache = () => root.includes(`${sep}plugins${sep}cache${sep}`)
export const pluginEntry = () => join(home(), 'superlcm.js')
const source = () => `// SuperLcm stable entry, written by the Claude plugin. Tools connected while SuperLcm was installed as a
// plugin start this file; it follows plugin updates. Safe to regenerate.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
let cli = ${JSON.stringify(cli)}
if (!existsSync(cli)) {
  const versions = ${JSON.stringify(dirname(root))}, list = (() => { try { return readdirSync(versions) } catch { return [] } })()
  const found = list.map(v => join(versions, v, 'src', 'cli.js')).filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  if (!found) { process.stderr.write('SuperLcm: the Claude plugin is no longer installed; reinstall it or reconnect this tool from the console.\\n'); process.exit(0) }
  cli = found
}
await import(pathToFileURL(cli).href)
`
const parts = v => v.split('.').map(Number)
const newer = (a, b) => { const x = parts(a), y = parts(b); if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false; for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false }
// A session opened before an update keeps running its own (older) copy's hooks; it must not point the entry, and
// with it the console and other tools, back at that older copy while the newer one is installed.
const pointsNewer = current => {
  try { const at = JSON.parse(current.match(/^let cli = (".*")$/m)[1]), dir = dirname(dirname(at)); return dirname(dir) === dirname(root) && existsSync(at) && newer(basename(dir), basename(root)) } catch { return false }
}
export function refreshPluginEntry() {
  if (!fromPluginCache()) return null
  const file = pluginEntry(), text = source()
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (current === text || (current && pointsNewer(current))) return file
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = file + '.' + randomBytes(4).toString('hex')
    writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, file)
  } catch {}
  return file
}
