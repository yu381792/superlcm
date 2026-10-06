import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore } from '../src/store.js'
import { CompressionReporter, compressionSnapshot, compressionCapabilities } from '../src/compression-status.js'
import { inspectDshTree, inspectDsh } from '../src/dsh-connection.js'
import { startWeb } from '../src/web.js'
const fixture = () => new ClaudeStore(mkdtempSync(join(tmpdir(), 'superlcm-compression-console-')))
const tree = () => [
  { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true },
  { id: 'superlcm-archive', name: 'superlcm-mcp/dsh' },
  { id: 'SuperLcm-compaction', name: 'superlcm-mcp/dsh-engine', config: { auto: true, summarizationProvider: 'local', summarizationModel: 'fixture' } },
]
test('compression capabilities distinguish native engine, takeover and summary-only adapters', () => {
  assert.equal(compressionCapabilities.dsh.owner, 'superlcm')
  assert.equal(compressionCapabilities['claude-code'].mode, 'takeover')
  for (const h of ['codex','hermes','pi']) assert.equal(compressionCapabilities[h].supported, false)
})
test('DSH reports config only when exactly one engine and archive are composed', () => {
  const rows = tree(); assert.equal(inspectDshTree(rows).configured, true)
  rows[0].disabled = false; assert.equal(inspectDshTree(rows).configured, false)
  rows[0].disabled = true; rows.push(rows[1]); assert.equal(inspectDshTree(rows).configured, false)
  assert.throws(() => inspectDshTree({ plugins: [] }), /配置树/)
  assert.equal(inspectDshTree([{ disabled: true, config: { plugins: tree() } }]).configured, false)
  assert.equal(inspectDshTree([{ name: 'agent-preset', config: { plugins: tree() } }]).configured, false)
})
test('one portable SuperLcm runtime owns compaction and archive without exposing module paths', () => {
  const status = inspectDshTree([{ id: 'superlcm-global', name: 'superlcm',
    config: { auto: true, summarizationProvider: 'local', summarizationModel: 'fixture' } }])
  assert.equal(status.configured, true)
  assert.equal(status.engines, 1)
  assert.equal(status.archives, 1)
})
test('heartbeat, stale process and shutdown are different from configured compaction', () => {
  const store = fixture(); let now = 100000
  const reporter = new CompressionReporter(store.db, { kind: 'engine', enabled: true, routeReady: true, profile: 'web', clock: () => now })
  try {
    reporter.report('session-one', 'summarizing', { start: 0, end: 9 })
    let s = compressionSnapshot(store, { now, alive: () => true })
    assert.equal(s.runtimes[0].live, true); assert.equal(s.jobs[0].phase, 'summarizing'); assert.equal(s.jobs[0].source_end, 9)
    assert.equal(compressionSnapshot(store, { now, alive: () => false }).runtimes[0].live, false)
    now += 45001; assert.equal(compressionSnapshot(store, { now, alive: () => true }).jobs[0].live, false)
    reporter.configure({ enabled: false, routeReady: false }); assert.equal(compressionSnapshot(store, { now, alive: () => true }).runtimes[0].enabled, false)
    reporter.close(); assert.equal(compressionSnapshot(store, { now, alive: () => true }).runtimes[0].phase, 'stopped')
  } finally { reporter.close(); store.close() }
})
test('DSH connection needs matching live engine and archive, not old summary records', async () => {
  const store = fixture(), env = { ...process.env, DSH_HOME: join(store.dir, 'dsh'), SUPERLCM_DSH_BIN: process.execPath }
  const dir = join(env.DSH_HOME, 'profiles/web'); mkdirSync(join(dir,'node_modules/superlcm-mcp'),{recursive:true})
  writeFileSync(join(dir,'package.json'),JSON.stringify({ dsh: { profile: { bundles: ['superlcm-mcp'] } } }))
  const version = new CompressionReporter(store.db,{kind:'engine',profile:'web',enabled:true,routeReady:true})
  const archive = new CompressionReporter(store.db,{kind:'archive',profile:'web',enabled:true,routeReady:true})
  const opts = { env, parse: JSON.parse, runCommand: async (_bin,args) => { assert.deepEqual(args,['--profile','web','--dump-config']); return {stdout:JSON.stringify(tree())} } }
  try {
    const installed = compressionSnapshot(store).runtimes[0].version
    writeFileSync(join(dir,'node_modules/superlcm-mcp/package.json'),JSON.stringify({version:installed}))
    let dsh = await inspectDsh(store,opts); assert.equal(dsh.profiles[0].state,'enabled')
    archive.close(); dsh = await inspectDsh(store,opts); assert.equal(dsh.profiles[0].state,'awaiting-runtime')
    assert.equal(dsh.configured,true); assert.equal(dsh.profiles[0].running,false)
    writeFileSync(join(dir,'node_modules/superlcm-mcp/package.json'),JSON.stringify({version:'future'}))
    assert.equal((await inspectDsh(store,opts)).profiles[0].state,'awaiting-runtime')
    opts.runCommand = async () => { throw Error('provider secret must not escape') }
    assert.ok(!(JSON.stringify(await inspectDsh(store,opts))).includes('secret'))
  } finally { version.close(); archive.close(); store.close() }
})
test('console exposes compression status without spawning models and supports independent DSH background settings', async () => {
  const store = fixture(), web = await startWeb({ store, discovery: async () => [], catalog: async () => [], spawnWorker: () => { throw Error('must not spawn') } })
  try {
    const data = await fetch(web.url+'api/compression').then(r => r.json())
    assert.deepEqual(data.runtimes,[]); assert.equal(data.capabilities.dsh.supported,true)
    const r = await fetch(web.url+'api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'harness',harness:'dsh',mode:'api',api_provider:'openai',api_url:'http://127.0.0.1:9/v1',model:'fixture'})})
    assert.equal(r.status,200); assert.equal((await r.json()).mode,'api')
  } finally { await web.close() }
})

test('preset compaction must inherit the host; hidden native pruning prevents a green connection', async () => {
  const {inheritGlobalCompaction,presetCompactionLeaks}=await import('../src/dsh-preset-compaction.js')
  const rows=[{id:'compaction',name:'cordis:group',group:true,isolate:{compaction:true,toolResultPruner:true},config:[
    {id:'compaction-basic',name:'@deepseek-ai/dsh-compaction-basic'},
    {id:'command-compact',name:'@deepseek-ai/dsh-command-compact'},
    {id:'tool-result-pruner',name:'@deepseek-ai/dsh-compaction-tool-result-pruner'}]}]
  const preset={id:'preset-pi-both',name:'@deepseek-ai/dsh-agent-preset',config:{id:'pi-both',plugins:rows}}
  assert.equal(presetCompactionLeaks([preset]).length,3)
  const runtime={id:'superlcm-global',name:'superlcm',config:{auto:true,summarizationProvider:'local',summarizationModel:'fixture'}}
  assert.equal(inspectDshTree([runtime,preset]).configured,false)
  const patched={...preset,config:{...preset.config,plugins:inheritGlobalCompaction(rows)}}
  assert.equal(inspectDshTree([runtime,patched]).configured,true)
  assert.equal(patched.config.plugins[0].config.length,1)
  assert.equal(patched.config.plugins[0].config[0].id,'command-compact')
  assert.equal(rows[0].config.length,3)
})
