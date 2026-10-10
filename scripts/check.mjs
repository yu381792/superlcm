import {readdir} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {dirname,join,extname} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=dirname(dirname(fileURLToPath(import.meta.url))),files=[]
async function walk(folder){for(const entry of await readdir(join(root,folder),{withFileTypes:true})){if(['node_modules','.git'].includes(entry.name))continue;const file=join(folder,entry.name);if(entry.isDirectory())await walk(file);else if(['.js','.mjs','.cjs'].includes(extname(file)))files.push(file)}}
for(const folder of ['src','dsh','hooks','test','scripts'])await walk(folder)
for(const file of files.sort()){const result=spawnSync(process.execPath,['--check',join(root,file)],{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr);process.exit(result.status||1)}}
console.log('Syntax verified: '+files.length+' files')
