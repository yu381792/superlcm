import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=dirname(dirname(fileURLToPath(import.meta.url)))
for(const folder of ['src','test','scripts'])for(const file of await readdir(join(root,folder))){if(!/\.[cm]?js$/.test(file))continue;const result=spawnSync(process.execPath,['--check',join(root,folder,file)],{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr);process.exit(result.status||1)}}
console.log('Claude adapter syntax verified')
