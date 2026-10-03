// Isolated UI fixture: actual console and telemetry, deterministic host states.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore } from '../src/store.js'
import { CompressionReporter, compressionSnapshot, compressionCapabilities } from '../src/compression-status.js'
import { startWeb } from '../src/web.js'
const store = new ClaudeStore(mkdtempSync(join(tmpdir(),'superlcm-dsh-ui-')))
const engine = new CompressionReporter(store.db,{kind:'engine',profile:'web',enabled:true,routeReady:true})
const archive = new CompressionReporter(store.db,{kind:'archive',profile:'web',enabled:true,routeReady:true})
engine.report('native-ui-session','summarizing',{start:0,end:9})
const version = compressionSnapshot(store).runtimes[0].version
const harnesses = ['codex','hermes','pi','dsh'].map(harness => ({harness,supported:true,detected:true,configured:true,
  configuration_matches:true,bin:process.execPath,compression:compressionCapabilities[harness],
  ...(harness === 'dsh' ? {dsh:{profiles:[{profile:'web',configured:true,enabled:true,route_ready:true,
    running:true,state:'enabled',installed_version:version}]}} : {}) }))
const web = await startWeb({store,discovery:async()=>harnesses,catalog:async()=>[]})
console.log(JSON.stringify({url:web.url,dir:store.dir}))
process.stdin.on('data', data => engine.report('native-ui-session',data.toString().trim(),{start:0,end:9}))
process.on('SIGTERM',async()=>{engine.close();archive.close();await web.close();process.exit(0)})
