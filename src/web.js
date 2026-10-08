import { applyTakeover, claudeCompactWindow } from './takeover.js'
import { claudePluginEnabled } from './runtime.js'
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
import { disconnectPreview,applyDisconnect } from './disconnect.js'
import { probeMcp } from './mcp-probe.js'
import { page } from './web-page.js'
import { ClaudeStore } from './store.js'
import { continuePacket } from './context.js'
import { modelCatalog, harnessConnections } from './model-catalog.js'
import { summaryMode } from './mode.js'
import { saveApiKey, readApiKey, removeApiKey, apiKeyEndpoint } from './api-credentials.js'
import { loopbackEndpoint } from './api-endpoint.js'
import { findCli } from './runtime.js'
import { summaryEstimate, summarizeWithModel } from './summarize.js'
import { writerTool } from './cli-writers.js'
import { openInTerminal } from './open-terminal.js'
import { compressionSnapshot, compressionCapabilities, runtimeVersion } from './compression-status.js'
import { dshCompressionSettings,publicCompressionSettings,saveDshCompression } from './dsh-controls.js'
import {defaultConsolePort,recordConsoleLocation} from './console-location.js'
import { refreshConversationNames } from './conversation-names.js'
export { probeMcp } from './mcp-probe.js'

const nonce = () => randomBytes(18).toString('hex')
export const defaultPort = defaultConsolePort
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

export async function startWeb({ store = new ClaudeStore(), port = 0, host = '127.0.0.1', env = process.env, nameRefreshMs = 15000, discovery = harnessConnections, catalog = modelCatalog, claudeProbe = probeClaudeConnection, probeModel = o => summarizeWithModel('User: Hello.\nAssistant: Hello! How can I help?', { ...o, timeoutMs: 45000 }), spawnWorker = spawn, terminal = {} } = {}) {
  if (host !== '127.0.0.1') throw new Error('Web console is loopback-only')
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local Web port')
  const session = url => { const id = url.searchParams.get('session'); if (!id || !store.source(id)) throw new Error('Unknown conversation'); return id }
  // One-off catch-up methods this computer can actually run for a conversation.
  const backends = id => [...(writerTool(store.metadata(id).harness, env) ? ['cli'] : []), ...(store.apiConfig(id, env) ? ['api'] : [])]
  const routes = {
    'GET /api/conversations': url => { refreshConversationNames(store,{env,minIntervalMs:nameRefreshMs});return { ...store.listSessions(50, int(url.searchParams.get('offset'), 0), url.searchParams.get('harness') || undefined), groups: store.harnessGroups() } },
    'GET /api/conversation': url => { const id = session(url);refreshConversationNames(store,{env,session:id,minIntervalMs:nameRefreshMs});return { ...store.outline(id), writer_tool: writerTool(store.metadata(id).harness, env), bands: store.bands(id), setting: store.effectiveSetting(id, env), summarizing: store.summarizing(id), status: store.source(id).status, summary_error_detail: store.source(id).status === 'summary_error' ? store.summaryError(id) : null, backends: backends(id), estimate: summaryEstimate(store, id) } },
    'GET /api/outline': url => store.outline(session(url), url.searchParams.get('node') || undefined),
    'GET /api/events': url => { const id = session(url); return { source: store.metadata(id), events: store.eventPreviews(id, int(url.searchParams.get('from'), 0), int(url.searchParams.get('to'), 0)) } },
    'GET /api/search': url => { refreshConversationNames(store,{env,minIntervalMs:nameRefreshMs});return store.find(url.searchParams.get('q') || '', { harness: url.searchParams.get('harness') || undefined, limit: 30 }) },
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
    'GET /api/harnesses': async () => ({ version:runtimeVersion,features:{dsh_setup:true,dsh_global_setup:true,dsh_compression_controls:true},harnesses: await discovery(store, { env }) }),
    'GET /api/compression': () => ({ capabilities: compressionCapabilities, ...compressionSnapshot(store) }),
    'GET /api/dsh-compression': async()=>publicCompressionSettings(await dshCompressionSettings(store,{env})),
    'POST /api/dsh-compression': async req=>saveDshCompression(store,await body(req),{env}),
    // Claude card: install / update the SuperLcm plugin, or clean up the older MCP + hooks connection.
    'POST /api/claude-plugin': async req => { const x = await body(req); const { pluginAction } = await import('./claude-plugin.js'); return pluginAction(store, x.action, { env }) },
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
    'POST /api/setup-preview': async req => { const x = await body(req); return publicPreview(await setupPreview(store, x.harness, { env,provider_ref:x.provider_ref,provider:x.provider,model:x.model })) },
    'POST /api/setup-apply': async req => { const x = await body(req); if (x.confirm !== true) throw Error('请先预览并确认接入'); return applySetup(store, x.harness, x.revision, { env,provider_ref:x.provider_ref,provider:x.provider,model:x.model, approveHooks: x.approve_hooks === true }) },
    'POST /api/disconnect-preview': async req=>{const x=await body(req);return publicPreview(await disconnectPreview(store,x.harness,{env}))},
    'POST /api/disconnect-apply': async req=>{const x=await body(req);if(x.confirm!==true)throw Error('请先预览并确认取消接入');return applyDisconnect(store,x.harness,x.revision,{env})},
    'GET /api/models': url => catalog(url.searchParams.get('backend'), { env }),
    // Kept fast: no tool detection here, so saving a choice on a card answers at once.
    'GET /api/settings': async () => {
      const settings = store.harnessSettings()
      return {
        global: { ...(store.globalSetting() || { mode: summaryMode(env), model: null, api_provider: null, api_url: null, configured: false }), api_key_configured: store.hasApiCredential('global') },
        index_home: store.dir,
        settings: settings.map(x => ({ ...x, api_key_configured: store.hasApiCredential(store.harnessKeyScope(x.harness, x)) })),
        api_models: store.apiModels().map(m => ({ ...m, key_configured: store.hasApiCredential('model:' + m.id), used_by: settings.filter(x => x.api_ref === m.id).map(x => x.harness) })),
        tuning: store.tuning(),
        takeover: { ...store.takeover(), previous: undefined, claude_window: claudeCompactWindow(env), plugin: claudePluginEnabled(env) }
      }
    },
    // Saving a model first makes one real call with it, so a wrong endpoint, model ID, key or 思考程度
    // shows the provider's own answer now; skip_test saves anyway (a gateway that refuses tiny test calls).
    'POST /api/api-models': async req => {
      const x = await body(req)
      if (x.api_key !== undefined && typeof x.api_key !== 'string') throw new Error('API key must be text')
      const before = x.id ? store.apiModel(x.id) : null
      if (x.id && !before) throw new Error('Unknown API model')
      const m = store.checkApiModel({ provider: x.api_provider || null, url: x.api_url || null, model: x.model || null, label: x.label || null, effort: x.effort || null })
      // The key: typed now, else this model's own (same endpoint), else one saved for the same endpoint.
      let key = x.api_key || (before && before.url === m.url ? readApiKey(store.dir, 'model:' + before.id) : null)
      if (!key) { const donor = store.apiModels().find(y => y.id !== x.id && y.url === m.url && store.hasApiCredential('model:' + y.id)); if (donor) key = readApiKey(store.dir, 'model:' + donor.id) }
      if (!key && !loopbackEndpoint(m.url)) throw new Error(before ? 'A new endpoint needs its API key' : 'Enter an API key for this model')
      if (x.skip_test !== true) {
        try { await probeModel({ model: m.model, apiKey: key || '', apiProvider: m.provider, apiURL: m.url, effort: m.effort }) }
        catch (error) { throw new Error('Test call failed: ' + String(error?.message || error).slice(0, 400)) }
      }
      const saved = store.saveApiModel({ id: x.id || null, ...m })
      if (key) saveApiKey(store.dir, 'model:' + saved.id, key, m.url)
      else if (before && before.url !== m.url) removeApiKey(store.dir, 'model:' + saved.id)
      return { ...saved, key_configured: store.hasApiCredential('model:' + saved.id), tested: x.skip_test !== true }
    },
    // 接管压缩 on/off and its size; turning it on also sets Claude Code's autoCompactWindow (see src/takeover.js).
    'POST /api/takeover': async req => { const x = await body(req); const r = applyTakeover(store, { enabled: x.enabled === true, window: x.window === undefined ? undefined : Number(x.window), keep: x.keep === undefined ? undefined : Number(x.keep) }, env); return { ...r, previous: undefined, plugin: claudePluginEnabled(env) } },
    'POST /api/api-models/delete': async req => { const x = await body(req); return { deleted: store.deleteApiModel(x.id) } },
    'POST /api/settings': async req => {
      const x = await body(req)
      if (x.scope !== 'global' && x.scope !== 'harness') throw new Error('Invalid settings scope')
      if (x.scope === 'harness' && !definitions.some(d => d.id === x.harness) && !store.harnessSetting(x.harness)) throw new Error('Unknown tool')
      if(x.harness==='dsh'&&['cli','agent','codex-cli'].includes(x.mode))throw Error('dsh harness 后台摘要请选择自定义 API')
      if (x.scope === 'harness' && x.mode === 'inherit') return store.clearHarnessSetting(x.harness)
      if (x.scope === 'harness' && x.mode === 'api' && x.api_ref) {
        const result = store.setHarnessSetting(x.harness, 'api', null, null, null, x.api_ref)
        return { ...result, api_key_configured: store.hasApiCredential(store.harnessKeyScope(x.harness, result)) }
      }
      const scope = x.scope === 'global' ? 'global' : 'harness:' + x.harness
      const model = x.model || null, provider = x.api_provider || null, address = x.api_url || null, key = x.api_key
      const checked = store.validateSetting(x.mode, model, provider, address)
      if (x.mode === 'api') {
        if (key !== undefined && typeof key !== 'string') throw new Error('API key must be text')
        const prior = x.scope === 'global' ? store.globalSetting() : store.harnessSetting(x.harness)
        const sameEndpoint = prior?.mode === 'api' && !prior.api_ref && prior.api_url === checked.api_url
        let chosenKey = key || (sameEndpoint || apiKeyEndpoint(store.dir, scope) === checked.api_url ? readApiKey(store.dir, scope, checked.api_url) : null)
        // Same endpoint as the default setting or another tool: reuse the key already saved there.
        if (!chosenKey) {
          const donor = [['global', store.globalSetting()], ...store.harnessSettings().map(y => [store.harnessKeyScope(y.harness, y), y])].find(([s, y]) => s !== scope && y?.mode === 'api' && y.api_url === checked.api_url && store.hasApiCredential(s))
          if (donor) chosenKey = readApiKey(store.dir, donor[0], checked.api_url)
        }
        if (!chosenKey && !loopbackEndpoint(checked.api_url)) throw new Error('A new endpoint needs its API key; enter and save it for this setting')
        if (chosenKey) saveApiKey(store.dir, scope, chosenKey, checked.api_url)
        else if (!sameEndpoint) removeApiKey(store.dir, scope)
      } else if (key) throw new Error('API key is accepted only for custom API mode')
      const result = x.scope === 'global' ? store.setGlobalSetting(x.mode, model, provider, address) : store.setHarnessSetting(x.harness, x.mode, model, provider, address)
      return { ...result, api_key_configured: store.hasApiCredential(scope) }
    },
    'POST /api/probe': async req => { await body(req); return probeMcp({ env: { ...process.env, SUPERLCM_HOME: store.dir } }) }
  }
  // Optional: open the console from your own devices through `tailscale serve` (tailnet only, never Funnel).
  // SUPERLCM_WEB_REMOTE_HOSTS lists the Host values served that way (e.g. mac.example.ts.net:8791).
  // SUPERLCM_WEB_TAILSCALE_USERS: '*' admits every device on the tailnet; otherwise only these Tailscale logins
  // (tailscaled adds Tailscale-User-Login for a signed-in user). Funnel (public internet) traffic, which
  // tailscaled marks with Tailscale-Funnel-Request, is always refused.
  const list = value => String(value || '').split(',').map(x => x.trim()).filter(Boolean)
  const remoteHosts = list(env.SUPERLCM_WEB_REMOTE_HOSTS), tailnetUsers = list(env.SUPERLCM_WEB_TAILSCALE_USERS)
  const tailnetRequest = req => remoteHosts.includes(req.headers.host) && !req.headers['tailscale-funnel-request'] &&
    (tailnetUsers.includes('*') || tailnetUsers.includes(req.headers['tailscale-user-login'])) &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const local = req.headers.host === `127.0.0.1:${server.address()?.port}`
      if (!local && !tailnetRequest(req)) return json(res, 403, { error: 'Loopback Host required' })
      // No login: the Host check stops DNS rebinding, browsers cannot read cross-origin responses,
      // and writes need a same-origin JSON request, which a foreign page cannot send without a failing preflight.
      if (url.pathname === '/' && req.method === 'GET') {
        const n = nonce()
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders,
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${n}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` })
        return res.end(page(n))
      }
      if (req.method === 'POST') {
        const own = local ? `http://127.0.0.1:${server.address()?.port}` : `https://${req.headers.host}`
        if (req.headers.origin && req.headers.origin !== own) return json(res, 403, { error: 'Cross-origin mutation refused' })
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'JSON request required' })
      }
      const route = routes[`${req.method} ${url.pathname}`]
      if (!route) return json(res, 404, { error: 'Unknown console route' })
      const began=performance.now(),data=await route(req.method === 'GET' ? url : req, url)
      res.setHeader('Server-Timing','handler;dur='+(performance.now()-began).toFixed(1))
      json(res, 200, data)
    } catch (error) { json(res, 400, { error: error.message }) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  try {recordConsoleLocation(store, server.address().port)}
  catch(error){await new Promise(resolve=>server.close(resolve));throw error}
  return { server, url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => server.close(() => { store.close(); resolve() })) }
}
