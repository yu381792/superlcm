// Open a CLI in a new terminal window so the user can act in the tool's own interface
// (for example Codex's startup "Hooks need review" screen). The command is fixed by the caller.
import { spawn } from 'node:child_process'
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const shellQuote = s => "'" + String(s).replace(/'/g, "'\\''") + "'"
export function openInTerminal(bin, { dir, name = 'open-tool', cwd, platform = process.platform, spawnProcess = spawn } = {}) {
  if (!bin) throw new Error('CLI not found')
  const launch = (cmd, args) => { const child = spawnProcess(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }); child.on?.('error', () => {}); child.unref?.() }
  if (platform === 'darwin') {
    // A .command file opens in Terminal without asking for automation permission.
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name + '.command')
    writeFileSync(file, '#!/bin/sh\ncd ' + (cwd ? shellQuote(cwd) : '"$HOME"') + ' && exec ' + shellQuote(bin) + '\n')
    chmodSync(file, 0o700)
    launch('open', ['-a', 'Terminal', file])
    return { opened: true, how: 'Terminal' }
  }
  if (platform === 'win32') { launch('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', bin]); return { opened: true, how: 'cmd' } }
  launch('x-terminal-emulator', ['-e', bin])
  return { opened: true, how: 'x-terminal-emulator' }
}
