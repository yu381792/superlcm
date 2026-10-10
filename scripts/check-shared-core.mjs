// Verify paired runtime modules before releasing the two separate products.
// The other checkout is an explicit argument; no machine-specific path is saved.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),other=process.argv[2]
assert.ok(other,'Usage: node scripts/check-shared-core.mjs <standalone-checkout>')
const pairs=[...['summary-policy.js','summary-language.js','summary-tokens.js','summary-merge.js'].map(f=>['src/'+f,'src/'+f]),...['summary-session.js','tree-semantics.js','draft-tree.js','prepared-tree.js','summary-prefix.js','summary-guards.js','async-region.js'].map(f=>['dsh/'+f,'src/'+f])]
for(const [a,b] of pairs){
 let left=readFileSync(resolve(root,a),'utf8'),right=readFileSync(resolve(other,b),'utf8')
 // The standalone merge module has a literal input cap because runtime.js is
 // its DSH entrypoint. Normalize this one documented packaging difference only.
 if(a==='src/summary-merge.js'){
  const constant=readFileSync(resolve(root,'src/runtime.js'),'utf8').match(/export const MAX_SUMMARY_INPUT = (\d+)/)?.[1]
  assert.ok(constant);left=left.replace("import { MAX_SUMMARY_INPUT } from './runtime.js'",'const MAX_SUMMARY_INPUT='+constant)
 }
 assert.equal(left,right,'Paired runtime differs: '+a+' / '+b)
}
console.log(JSON.stringify({pairedRuntimeModules:pairs.length,match:true}))
