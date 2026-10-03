import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore } from '../src/store.js'
import { startWeb } from '../src/web.js'
import { inspectDsh } from '../src/dsh-connection.js'
import { findCli } from '../src/runtime.js'
import { compressionCapabilities } from '../src/compression-status.js'
const dir=mkdtempSync(join(tmpdir(),'superlcm-public-ui-')),store=new ClaudeStore(join(dir,'archive'))
const env={...process.env,DSH_HOME:join(dir,'dsh')}
for(const profile of ['web','acp']) {
  const folder=join(env.DSH_HOME,'profiles',profile);mkdirSync(folder,{recursive:true})
  writeFileSync(join(folder,'package.json'),JSON.stringify({name:'dsh-profile-'+profile,private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base']}},dependencies:{}}))
  const models=profile==='web'?['cheap-summary','long-context']:['alternate-model']
  writeFileSync(join(folder,'cordis.patch.yml'),'# Keep this comment\n- id: agent-default-model\n  config:\n    provider: sample-ai\n    model: cheap-summary\n- id: llm-pi-ai\n  config:\n    providers:\n      sample-ai:\n        displayName: Sample AI\n        api: openai-responses\n        baseURL: http://127.0.0.1:9/v1\n        headers:\n          Authorization: Bearer fixture-private-key\n        models:\n'+models.map(id=>'          - id: '+id+'\n            name: '+id+'\n            contextWindow: 128000\n').join(''))
}
const web=await startWeb({store,env,catalog:async()=>[],discovery:async()=>{
  const dsh=await inspectDsh(store,{env})
  return ['hermes','pi'].map(harness=>({harness,bin:process.execPath,supported:true,detected:true,configured:false,compression:compressionCapabilities[harness]})).concat({harness:'dsh',bin:findCli('dsh',env),supported:true,detected:dsh.detected,configured:dsh.configured,configuration_matches:dsh.configuration_matches,dsh,compression:compressionCapabilities.dsh})
}})
console.log(JSON.stringify({url:web.url,dir,archive:store.dir}))
process.on('SIGTERM',async()=>{await web.close();process.exit(0)})
