#!/usr/bin/env node
// Entry for the Claude plugin. Claude runs plugin commands with whatever `node` is first on PATH, which may be
// older than SuperLcm needs (22.16, for node:sqlite); then this hands the same command to a newer node on this
// computer, or explains what is missing. It also keeps a stable entry file up to date (see plugin-entry.js).
import { spawnSync } from 'node:child_process'
const [major, minor] = process.versions.node.split('.').map(Number)
const hook = ['hook', 'codex-hook', 'hermes-hook', 'pi-hook'].includes(process.argv[2])
if (major > 22 || (major === 22 && minor >= 16)) {
  process.env.SUPERLCM_VIA_PLUGIN = '1'
  const { refreshPluginEntry } = await import('./plugin-entry.js')
  refreshPluginEntry()
  await import('./cli.js')
} else {
  const { preferredNode } = await import('./runtime.js')
  const node = preferredNode().path
  if (node !== process.execPath) {
    const run = spawnSync(node, [new URL(import.meta.url).pathname, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true })
    process.exit(run.status ?? 1)
  }
  process.stderr.write(`SuperLcm needs Node.js 22.16 or newer (found ${process.versions.node}). Install it from https://nodejs.org and restart Claude.\n`)
  process.exit(hook ? 0 : 1) // a missing Node must not block the conversation
}
