import { createInterface } from 'node:readline'
import { ClaudeStore, claudeTranscript, importFile } from './store.js'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
const version = '0.1.0-alpha.5'
const instructions = 'SuperLcm is a cross-harness conversation index: list sessions to select a harness and conversation, page all summaries with lcm_summaries, and verify claims with lcm_search and exact lcm_read_event/lcm_expand. An MCP client never acquires the host transcript automatically; original sources remain authoritative. Explicit session IDs are required.'
const schema = (properties = {}, required = []) => ({type:'object',properties,required,additionalProperties:false})
const str = description => ({type:'string',description})
const int = description => ({type:'integer',description})
export const tools = [
  {name:'lcm_sessions',description:'Page through all indexed conversations across harnesses with origin, first-message hint and summary count. Use next_offset for another page; all local MCP clients see this shared index.',inputSchema:schema({limit:int('Conversations per page, 1–50; default 20'),offset:int('Zero-based offset; default 0'),harness:str('Optional origin filter, e.g. claude-code or codex')})},
  {name:'lcm_overview',description:'Get short top-layer navigation for one conversation, regardless of the harness that produced it.',inputSchema:schema({session:str('Session ID from lcm_sessions')},['session'])},
  {name:'lcm_summaries',description:'Page through ALL independently stored summary nodes for one selected conversation, top level first. Use next_offset for the next page; expand originals to verify claims.',inputSchema:schema({session:str('Session ID from lcm_sessions'),limit:int('Nodes per page, 1–50; default 10'),offset:int('Zero-based offset; default 0')},['session'])},
  {name:'lcm_search',description:'Search summary nodes AND indexed original conversation text; verify important claims by expanding exact raw source.',inputSchema:schema({session:str('Session ID'),query:str('Search terms'),limit:int('Hits per section, at most 50')},['session','query'])},
  {name:'lcm_read_event',description:'Read one indexed original event directly by ordinal, including an unsummarized recent tail. Page with next.charOffset and verify exact source hash.',inputSchema:schema({session:str('Session ID'),ordinal:int('Event ordinal from lcm_search'),char_offset:int('Character offset within event'),max_chars:int('Page budget, max 50000')},['session','ordinal'])},
  {name:'lcm_describe',description:'Inspect one node, its summary, child IDs, parents and original event range.',inputSchema:schema({session:str('Session ID'),node_id:str('Node from lcm_search or lcm_overview')},['session','node_id'])},
  {name:'lcm_expand',description:'Read exact original JSONL events (or imported text), page by next ordinal and charOffset; never infer missing details from summaries.',inputSchema:schema({session:str('Session ID'),node_id:str('Node ID'),ordinal:int('Start event ordinal'),char_offset:int('Character offset within event'),max_chars:int('Page budget, max 50000')},['session','node_id'])},
  {name:'lcm_doctor',description:'Read-only SQLite and source-pointer integrity diagnostics; no repair or deletion.',inputSchema:schema({session:str('Session ID')},['session'])},
  {name:'lcm_import',description:'EXPLICIT import of a portable JSONL or UTF-8 text conversation export from any harness. Copies only allowlisted local files; no auto-capture or model call.',inputSchema:schema({path:str('Allowlisted local .jsonl or .txt'),session:str('Optional unique conversation ID'),harness:str('Origin label, e.g. codex or claude-code; default import')},['path'])},
  {name:'lcm_index',description:'Read and index an explicitly supplied Claude Code transcript path. This never invokes a summarizer or charges for API calls.',inputSchema:schema({path:str('Claude Code transcript_path under configured projects directory'),session:str('Claude Code session ID')},['path','session'])}
]
export async function call(store,name,args = {}) {
  const tool=tools.find(t=>t.name===name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Object arguments required')
  for (const key of tool.inputSchema.required) {
    const rule = tool.inputSchema.properties[key]
    if (rule.type === 'string' ? (typeof args[key] !== 'string' || !args[key]) : (rule.type === 'integer' && !Number.isSafeInteger(args[key]))) throw new Error(`Missing or invalid ${key}`)
  }
  if (name==='lcm_sessions') {
    const limit=args.limit ?? 20, offset=args.offset ?? 0
    if (!Number.isSafeInteger(limit) || limit<1 || limit>50 || !Number.isSafeInteger(offset) || offset<0) throw new Error('Invalid session page; limit must be 1–50 and offset nonnegative')
    if (args.harness!==undefined && (typeof args.harness!=='string' || !/^[a-z][a-z0-9-]{0,39}$/.test(args.harness))) throw new Error('Invalid harness filter')
    return store.listSessions(limit,offset,args.harness)
  }
  if (name==='lcm_import') {
    if (!process.env.SUPERLCM_IMPORT_DIR) throw new Error('MCP import disabled; use explicit CLI import or set SUPERLCM_IMPORT_DIR')
    const root=realpathSync(process.env.SUPERLCM_IMPORT_DIR), file=realpathSync(args.path), rel=relative(root,file)
    if (rel==='..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Import path outside allowlisted directory')
    return importFile(store,file,args.session,args.harness || 'import')
  }
  if (name==='lcm_index') {
    if (process.env.SUPERLCM_ALLOW_MCP_INDEX!=='1') throw new Error('MCP indexing disabled; use Claude Code hook or explicit CLI index')
    const result=store.ingest(args.session,claudeTranscript(args.path))
    store.setOrigin(args.session,'claude-code')
    return result
  }
  if (!store.source(args.session)) throw new Error('Unknown session')
  if (name==='lcm_overview') return store.overview(args.session)
  if (name==='lcm_summaries') return store.summaries(args.session,args.limit ?? 10,args.offset ?? 0)
  if (name==='lcm_read_event') return store.readEvent(args.session,args.ordinal,args.char_offset,args.max_chars)
  if (name==='lcm_search') return store.search(args.session,args.query,args.limit)
  if (name==='lcm_describe') return store.describe(args.session,args.node_id)
  if (name==='lcm_expand') return store.expand(args.session,args.node_id,args.ordinal,args.char_offset,args.max_chars)
  if (name==='lcm_doctor') return store.doctor(args.session)
}
const modernVersion = '2026-07-28'
const legacyVersions = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05']
export function startServer(store = new ClaudeStore(), input = process.stdin, output = process.stdout) {
  const send = value => output.write(JSON.stringify(value)+'\n')
  const rl=createInterface({input,crlfDelay:Infinity})
  rl.on('line', async line => {
    let msg
    try { msg=JSON.parse(line) } catch { send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return }
    if (!Object.hasOwn(msg,'id')) return
    try {
      const requested = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion']
      const modern = requested === modernVersion
      if (requested && !modern && !legacyVersions.includes(requested)) {
        send({jsonrpc:'2.0',id:msg.id,error:{code:-32022,message:'Unsupported protocol version',data:{supported:[modernVersion,...legacyVersions],requested}}});return
      }
      let result
      switch (msg.method) {
        case 'initialize': result={protocolVersion:legacyVersions.includes(msg.params?.protocolVersion)?msg.params.protocolVersion:legacyVersions[0],capabilities:{tools:{}},serverInfo:{name:'superlcm',version},instructions};break
        case 'server/discover': result={resultType:'complete',supportedVersions:[modernVersion,...legacyVersions],capabilities:{tools:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'superlcm',version}},instructions};break
        case 'ping': result={};break
        case 'tools/list': result={tools};break
        case 'tools/call': {
          try {
            const value=await call(store,msg.params?.name,msg.params?.arguments)
            result={content:[{type:'text',text:JSON.stringify(value)}]}
          } catch(error) {result={content:[{type:'text',text:error.message}],isError:true} }
          break
        }
        default: throw Object.assign(new Error('Method not found'),{code:-32601})
      }
      if (modern && ['tools/list','tools/call'].includes(msg.method)) result.resultType='complete'
      send({jsonrpc:'2.0',id:msg.id,result})
    } catch(error) { send({jsonrpc:'2.0',id:msg.id,error:{code:error.code||-32603,message:error.message}}) }
  })
  rl.on('close',()=>store.close())
  return rl
}
