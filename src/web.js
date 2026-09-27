import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connectionEvidence } from './connections.js'
import { definitions } from './harness.js'
import { probeClaudeConnection } from './claude-connection.js'
import { localConversations, indexLocalConversation } from './local-conversations.js'
import { testHarness } from './diagnostics.js'
import { setupPreview, publicPreview, applySetup } from './setup.js'
import { probeMcp } from './mcp-probe.js'
import { page } from './web-page.js'
import { ClaudeStore } from './store.js'
import { continuePacket } from './context.js'
import { modelCatalog, harnessConnections } from './model-catalog.js'
import { summaryMode } from './mode.js'
import { saveApiKey } from './api-credentials.js'
import { findCli } from './runtime.js'
import { summaryEstimate } from './summarize.js'
import { writerTool } from './cli-writers.js'
import { openInTerminal } from './open-terminal.js'
export { probeMcp } from './mcp-probe.js'

const nonce = () => randomBytes(18).toString('hex')
export const defaultPort = 8791
const cliScript = fileURLToPath(new URL('./cli.js', import.meta.url))
const securityHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...securityHeaders }); res.end(JSON.stringify(data)) }
async function body(req) {
  const chunks = []; let bytes = 0
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16000) throw new Error('Request body too large'); chunks.push(chunk) }
  const x = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('JSON object required')
  return x
}
const int = (value, fallback) => { const n = value === null || value === undefined || value === '' ? fallback : Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid number'); return n }
// The line a user pastes into another tool to continue a conversation there.
const shortName = name => { const flat = String(name).replace(/\s+/g, ' ').trim(); return flat.length > 24 ? flat.slice(0, 23) + '…' : flat }
const continueLine = source => `通过 SuperLcm 接续对话 #${source.code}「${shortName(source.name)}」，继续之前的任务。`

export async function startWeb({ store = new ClaudeStore(), port = 0, host = '127.0.0.1', env = process.env, discovery = harnessConnections, catalog = modelCatalog, claudeProbe = probeClaudeConnection, spawnWorker = spawn, terminal = {} } = {}) {
  if (host !== '127.0.0.1') throw new Error('Web console is loopback-only')
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local Web port')
  const session = url => { const id = url.searchParams.get('session'); if (!id || !store.source(id)) throw new Error('Unknown conversation'); return id }
  // One-off catch-up methods this computer can actually run for a conversation.
  const backends = id => [...(writerTool(store.metadata(id).harness, env) ? ['cli'] : []), ...(store.apiConfig(id, env) ? ['api'] : [])]
  const routes = {
    'GET /api/conversations': url => ({ ...store.listSessions(50, int(url.searchParams.get('offset'), 0), url.searchParams.get('harness') || undefined), groups: store.harnessGroups() }),
    'GET /api/conversation': url => { const id = session(url); return { ...store.outline(id), writer_tool: writerTool(store.metadata(id).harness, env), bands: store.bands(id), setting: store.effectiveSetting(id, env), summarizing: store.summarizing(id), status: store.source(id).status, backends: backends(id), estimate: summaryEstimate(store, id) } },
    'GET /api/outline': url => store.outline(session(url), url.searchParams.get('node') || undefined),
    'GET /api/events': url => { const id = session(url); return { source: store.metadata(id), events: store.eventPreviews(id, int(url.searchParams.get('from'), 0), int(url.searchParams.get('to'), 0)) } },
    'GET /api/search': url => store.find(url.searchParams.get('q') || '', { harness: url.searchParams.get('harness') || undefined, limit: 30 }),
    'GET /api/continue': url => { const id = session(url), packet = continuePacket(store, id); return { line: continueLine(packet.source), code: packet.source.code, name: shortName(packet.source.name), packet } },
    'POST /api/rename': async req => { const x = await body(req); if (!store.source(x.session)) throw new Error('Unknown conversation'); return store.nameSession(x.session, x.name) },
    'POST /api/summarize': async req => {
      const x = await body(req)
      if (!store.source(x.session)) throw new Error('Unknown conversation')
      if (!backends(x.session).includes(x.backend)) throw new Error('This summary method is not available on this computer')
      if (store.summarizing(x.session)) return { started: false, running: true }
      const child = spawnWorker(process.execPath, [cliScript, 'summarize', x.session, '--backend', x.backend], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...env, SUPERLCM_HOME: store.dir } })
      child.on?.('error', () => store.setStatus(x.session, 'summary_error'))
      child.unref?.()
      return { started: true }
    },
    'GET /api/tuning': () => store.tuning(),
    'POST /api/tuning': async req => store.setTuning(await body(req)),
    'GET /api/connections': () => ({ connections: definitions.map(h => ({ harness: h.id, evidence: connectionEvidence(store, h.id) })) }),
    'GET /api/harnesses': async () => ({ harnesses: await discovery(store, { env }) }),
    'GET /api/local-conversations': url => localConversations(store, url.searchParams.get('harness'), { env, offset: int(url.searchParams.get('offset'), 0) }),
    'POST /api/index-local': async req => { const x = await body(req); return indexLocalConversation(store, x.harness, x.key, { env }) },
    // Opens the tool itself so its own startup screen asks the user to approve new hooks; SuperLcm never approves them.
    'POST /api/open-review': async req => { const x = await body(req); if (!['codex', 'hermes'].includes(x.harness)) throw new Error('Unsupported tool'); return openInTerminal(findCli(x.harness, env), { dir: store.dir, name: 'open-' + x.harness, cwd: env.HOME, ...terminal }) },
    'POST /api/delete': async req => { const x = await body(req); return store.deleteSession(x.session) },
    'POST /api/delete-preview': async req => { const x = await body(req); const rows = store.staleSessions(x.before_ms, x.harness || undefined); return { count: rows.length, records: rows.reduce((n, r) => n + r.records, 0), sample: rows.slice(0, 8).map(r => ({ name: r.name || r.session, harness: r.harness, updated_ms: r.updated_ms })) } },
    // The client confirms the exact count it previewed, so a conversation that became stale meanwhile is not removed unseen.
    'POST /api/delete-bulk': async req => { const x = await body(req); const rows = store.staleSessions(x.before_ms, x.harness || undefined); if (rows.length !== x.expect_count) throw new Error('The matching conversations changed; preview again'); for (const r of rows) store.deleteSession(r.session); return { deleted: rows.length } },
    'GET /api/storage': () => store.storageStats(),
    'POST /api/connection-check': async req => { const x = await body(req); return x.harness === 'claude-code' ? claudeProbe(store, { env }) : testHarness(store, x.harness, { env }) },
    'POST /api/setup-preview': async req => { const x = await body(req); return publicPreview(await setupPreview(store, x.harness, { env })) },
    'POST /api/setup-apply': async req => { const x = await body(req); if (x.confirm !== true) throw Error('请先预览并确认接入'); return applySetup(store, x.harness, x.revision, { env, approveHooks: x.approve_hooks === true }) },
    'GET /api/models': url => catalog(url.searchParams.get('backend'), { env }),
    'GET /api/settings': async () => ({
      global: { ...(store.globalSetting() || { mode: summaryMode(env), model: null, api_provider: null, api_url: null, configured: false }), api_key_configured: store.hasApiCredential('global') },
      harnesses: await discovery(store, { env }),
      settings: store.harnessSettings().map(x => ({ ...x, api_key_configured: store.hasApiCredential('harness:' + x.harness) })),
      tuning: store.tuning()
    }),
    'POST /api/settings': async req => {
      const x = await body(req)
      if (x.scope !== 'global' && x.scope !== 'harness') throw new Error('Invalid settings scope')
      if (x.scope === 'harness' && !(await discovery(store, { env })).some(h => h.harness === x.harness)) throw new Error('Harness has not been configured or observed')
      if (x.scope === 'harness' && x.mode === 'inherit') return store.clearHarnessSetting(x.harness)
      const scope = x.scope === 'global' ? 'global' : 'harness:' + x.harness
      const model = x.model || null, provider = x.api_provider || null, address = x.api_url || null, key = x.api_key
      store.validateSetting(x.mode, model, provider, address)
      if (x.mode === 'api') {
        if (key !== undefined && typeof key !== 'string') throw new Error('API key must be text')
        if (!key && !store.hasApiCredential(scope)) throw new Error('Enter and save an API key for this setting')
        if (key) saveApiKey(store.dir, scope, key)
      } else if (key) throw new Error('API key is accepted only for custom API mode')
      const result = x.scope === 'global' ? store.setGlobalSetting(x.mode, model, provider, address) : store.setHarnessSetting(x.harness, x.mode, model, provider, address)
      return { ...result, api_key_configured: store.hasApiCredential(scope) }
    },
    'POST /api/probe': async req => { await body(req); return probeMcp({ env: { ...process.env, SUPERLCM_HOME: store.dir } }) }
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.headers.host !== `127.0.0.1:${server.address()?.port}`) return json(res, 403, { error: 'Loopback Host required' })
      // No login: the Host check stops DNS rebinding, browsers cannot read cross-origin responses,
      // and writes need a same-origin JSON request, which a foreign page cannot send without a failing preflight.
      if (url.pathname === '/' && req.method === 'GET') {
        const n = nonce()
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders,
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${n}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` })
        return res.end(page(n))
      }
      if (req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${server.address()?.port}`) return json(res, 403, { error: 'Cross-origin mutation refused' })
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'JSON request required' })
      }
      const route = routes[`${req.method} ${url.pathname}`]
      if (!route) return json(res, 404, { error: 'Unknown console route' })
      json(res, 200, await route(req.method === 'GET' ? url : req, url))
    } catch (error) { json(res, 400, { error: error.message }) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  return { server, url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => server.close(() => { store.close(); resolve() })) }
}
