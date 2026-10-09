// One persistent local archive worker per DSH plugin. SQLite and file indexing
// run here rather than delaying the DSH model loop; no paid provider is used.
import { createInterface } from 'node:readline'
import { ClaudeStore } from './store.js'
import { captureDshPacket } from './dsh.js'
import { call } from './mcp.js'
import { scheduleSummary } from './summary-scheduler.js'
const store = new ClaudeStore()
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let id
  try {
    if (line.length > 32e6) throw Error('DSH capture input exceeds 32 MB')
    const request = JSON.parse(line); id = request.id
    let result
    if (request.method === 'ping') result = { ready: true }
    else if (request.method === 'cursor') {
      const table = store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='dsh_mirrors'").get()
      result = table ? store.db.prepare('SELECT next_seq FROM dsh_mirrors WHERE session=?').get(request.session)?.next_seq ?? 0 : 0
    } else if(request.method==='historical'){const {legacyDshSource}=await import('./dsh-evidence.js');result=legacyDshSource(store.db,request.session)}
    else if (request.method === 'call') {
      if (!['lcm_continue','lcm_find','lcm_outline','lcm_read'].includes(request.name)) throw Error('DSH archive only exposes recall tools')
      result = await call(store, request.name, request.args)
    } else if(request.method==='capture-legacy'){const {captureLegacyDshSource}=await import('./dsh-legacy.js');result=await captureLegacyDshSource(store,request.source)}
    else if (request.method === 'capture') result = captureDshPacket(store, request.packet)
    else if(request.method==='summarize') {
      if(!request.session?.startsWith('dsh-')||!store.source(request.session))throw Error('Unknown DSH conversation')
      const setting=store.effectiveSetting(request.session)
      result={scheduled:scheduleSummary(store,request.session,setting.mode,setting.model)}
    }
    else throw Error('Unknown DSH archive operation')
    process.stdout.write(JSON.stringify({ id, result }) + '\n')
  } catch (error) { process.stdout.write(JSON.stringify({ id, error: error.message }) + '\n') }
}
store.close()
