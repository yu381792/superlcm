// Connect view (setup + local import), status pill, settings, appearance and boot().
const WRITERS = [
  ['agent', t('对话模型生成'), t('正在聊天的 AI 凭记忆顺手写，几乎不多花钱')],
  ['cli', t('本工具后台写'), t('另起一个该工具的进程来写，用它已配置的模型，不占用正在聊的对话')],
  ['api', t('自定义 API'), t('后台单独写 · 使用你的 API 密钥')],
  ['off', t('关闭（摘要方式）'), t('不生成摘要，原文照常保存')]
]
const writerLabel = mode => WRITERS.find(w => w[0] === mode)?.[1] || mode
const kfmt=n=>Math.round(n/1000)+'K'
const admin = { settings: null, catalog: {}, modelEdit: null, compression: { runtimes: [], jobs: [] }, outdated: false }
const DSH_STATES = { 'summary-only':'自动归档与后台摘要已接入',enabled: '已启用 · SuperLcm 接管压缩', disabled: '自动压缩已关闭', 'missing-route': '未配置压缩模型', 'awaiting-runtime': '已配置 · 待加载或重启', 'runtime-mismatch': '运行设置与保存配置不同', misconfigured: '压缩配置不完整或有冲突', 'not-connected':'尚未接入' }
function dshCompressionLabel(h) {
  const global=h.dsh?.global
  if(global?.configured)return t(DSH_STATES[global.state]||'未核实运行状态')+' · '+t('全局接入')
  if(h.configured)return t('旧接入方式，请更新为全局接入')
  return t('尚未全局接入')
}

// Short badge plus a plain-language detail line, both from real evidence.
function connState(h) {
  const e = h.connection_evidence, tool = toolName(h.harness)
  if(h.integration_enabled===false)return {cls:'off',badge:t('未接入'),text:t('已取消接入，已有档案和摘要保留')}
  if (h.harness === 'dsh' && admin.outdated) return {cls:'warn',badge:t('需重启后台'),text:t('页面已更新，后台仍是旧版；重新启动 SuperLcm 后才能检测和接入 dsh harness')}
  if (!h.supported) return { cls: 'off', badge: t('仅导入'), text: h.local_conversations ? t('暂不支持自动接入，可导入本机对话') : t('暂不支持自动接入') }
  if (!h.bin) return { cls: 'off', badge: t('未安装'), text: t('未找到 {tool} 命令行', { tool }) }
  if (h.harness === 'dsh') {
    if(!h.configuration_matches)return {cls:'warn',badge:h.configured?t('需更新'):t('未接入'),text:t('接入后，自动归档并在后台生成摘要')}
    return h.dsh.profiles.some(p=>p.running)?{cls:'on',badge:t('已接入'),text:t('自动归档与后台摘要已接入')}:{cls:'warn',badge:t('待加载'),text:t('已写入配置，重新加载 dsh harness 后生效')}
  }
  const c = h.claude
  if (c?.plugin && !c.plugin.enabled) return { cls: 'warn', badge: t('已停用'), text: t('SuperLcm 插件装了，但在 Claude Code 里被停用') }
  if (c?.plugin?.outdated) return { cls: 'warn', badge: t('需更新'), text: t('插件是 v{a}，有新版 v{b}', { a: c.plugin.version, b: c.plugin.latest }) }
  if (c && !c.plugin) return h.configured ? { cls: 'warn', badge: t('建议改装'), text: t('正在用 MCP 和钩子归档；可在管理接入中更新为插件') } : { cls: 'warn', badge: t('未接入'), text: t('接入后，新对话会自动存入 SuperLcm') }
  if (!h.configuration_matches) return h.configured ? { cls: 'warn', badge: t('需更新'), text: t('点「管理接入」更新一次，以后 {tool} 升级不会影响 SuperLcm', { tool }) } : { cls: 'warn', badge: t('未接入'), text: t('接入后，新对话会自动存入 SuperLcm') }
  if (h.capture_stale) return { cls: 'warn', badge: t('没在存'), text: h.harness === 'codex' ? t('最近的 Codex 对话没有存进来，多半是 Codex 在等你允许钩子。到「管理接入」检查并更新接入') : t('最近的 {tool} 对话没有存进来。点「管理接入」看看哪里不对', { tool }) }
  if (h.node_borrowed) return { cls: 'warn', badge: t('已接入'), text: t('借用 {owner} 自带的 node 运行；{owner} 升级后若失灵，点「管理接入」即可恢复', { owner: h.node_borrowed }) }
  // Capture is what shows the connection works; the AI calling SuperLcm's tools is optional and rarer.
  if (h.hook_seen) return { cls: 'on', badge: t('已接入'), text: t('最近一次存入：{t}', { t: ago(Date.parse(h.hook_seen.replace(' ', 'T') + 'Z')) }) }
  if (e?.last_call_at) return { cls: 'on', badge: t('已接入'), text: t('AI 最近一次调用：{t}', { t: ago(Date.parse(e.last_call_at)) }) }
  if (e?.state === 'tool_verified') return { cls: 'on', badge: t('已接入'), text: t('AI 已成功调用') }
  if (e?.state === 'mcp_loaded') return { cls: 'on', badge: t('已接入'), text: t('已加载，等待 AI 首次调用') }
  return { cls: 'warn', badge: t('待重启'), text: t('已写入配置 · 重启 {tool} 后生效', { tool }) }
}

/* ---------- connect view ---------- */
async function loadHarnesses() {
  const data = await api('/api/harnesses')
  admin.outdated = data.features?.dsh_global_setup !== true
  state.harnesses = data.harnesses
  if (admin.outdated) showError(t('页面已更新，后台仍是旧版；重新启动 SuperLcm 后才能检测和接入 dsh harness'))
  renderTools(); renderStatus(); renderTakeover(admin.settings?.takeover)
}
function renderStatus() {
  const ready = state.harnesses.filter(h => h.configuration_matches && (h.harness !== 'dsh' || h.dsh?.profiles.some(p => p.running)))
  $('#statusDot').className = 'dot ' + (ready.length ? 'on' : 'warn')
  $('#statusText').textContent = ready.length ? t('已接入 {tools}', { tools: ready.map(h => toolName(h.harness)).join(LANG === 'zh' ? '、' : ', ') }) : t('尚未接入工具')
}
function renderTools() {
  $('#tools').innerHTML = state.harnesses.map(h => {
    const s = connState(h), count = state.groups?.find(g => g.harness === h.harness)?.n || 0
    const buttons = (h.supported ? '<button type="button" class="btn primary" data-manage="' + esc(h.harness) + '"' + (!h.bin || h.harness === 'dsh' && admin.outdated ? ' disabled' : '') + '>' + t('管理接入') + '</button>' : '') +
      (h.local_conversations && h.detected ? '<button type="button" class="btn" data-import="' + esc(h.harness) + '">' + t('导入历史对话') + '</button>' : '')
    const rows = [[t('状态'), esc(s.text)], [t('已存对话'), count ? t('{n} 个', { n: fmt(count) }) : '<span class="muted">' + t('暂无') + '</span>']]
    rows.push(...writerRows(h))
    if (h.claude) rows.push(...claudeRows(h))
    const takeover=h.harness==='claude-code'?admin.settings?.takeover.enabled:h.harness==='dsh'&&h.dsh?.profiles.some(p=>p.enabled&&!p.archive_only)
    rows.push([t('上下文压缩'),'<span class="muted">'+(takeover?t('SuperLcm 接管已开启'):t('由 {tool} 自身负责',{tool:toolName(h.harness)}))+'</span>'])
    return '<article class="tcard' + (h.detected ? '' : ' dim') + '"><header class="tc-h">' + mark(h.harness, 'lg') + '<div class="tc-name"><div class="tn">' + esc(toolName(h.harness)) + '</div>' + (h.detected ? '' : '<div class="tv">' + t('本机未检测到') + '</div>') + '</div><span class="state ' + s.cls + '">' + esc(s.badge) + '</span></header>' +
      '<dl class="tc-kv">' + rows.map(([k, v]) => '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>').join('') + '</dl>' +
      (buttons ? '<footer class="tc-f">' + buttons + '</footer>' : '') + '</article>'
  }).join('') || '<div class="empty">' + t('本机未检测到支持的工具。') + '</div>'
  for (const b of $('#tools').querySelectorAll('[data-manage]')) b.onclick = () => openConnectionManager(b.dataset.manage)
  for (const b of $('#tools').querySelectorAll('[data-import]')) b.onclick = () => openImport(b.dataset.import)
  for (const b of $('#tools').querySelectorAll('[data-plugin]')) b.onclick = () => pluginAct(b.dataset.plugin, b)
  for (const b of $('#tools').querySelectorAll('[data-goto-compact]')) b.onclick = () => { show('settings'); settingsSection('compact') }
  for (const select of $('#tools').querySelectorAll('select[data-tool]')) select.onchange = () => {
    const harness = select.dataset.tool, x = admin.settings.settings.find(y => y.harness === harness), models = admin.settings.api_models
    // Custom API picks one of the models added in Settings; with none yet, go add one first.
    if (select.value === 'api' && !models.length) return addApiModel()
    const payload = select.value === 'api' ? { scope: 'harness', harness, mode: 'api', api_ref: models.some(m => m.id === x?.api_ref) ? x.api_ref : models[0].id }
      : { scope: 'harness', harness, mode: select.value, model: x?.mode === select.value ? x.model : null }
    act(async () => { await api('/api/settings', payload); await loadSettings(); toast(t('已保存')) }, select)
  }
  for (const select of $('#tools').querySelectorAll('select[data-apimodel]')) select.onchange = () => {
    if (select.value === '__add') return addApiModel()
    act(async () => { await api('/api/settings', { scope: 'harness', harness: select.dataset.apimodel, mode: 'api', api_ref: select.value }); await loadSettings(); toast(t('已保存')) }, select)
  }
  for (const b of $('#tools').querySelectorAll('[data-add-model]')) b.onclick = addApiModel
  for (const select of $('#tools').querySelectorAll('select[data-model]')) {
    const harness = select.dataset.model, x = admin.settings.settings.find(y => y.harness === harness)
    fillModels(select, harness, x?.model || null)
    select.onchange = () => act(async () => {
      let model = select.value || null
      if (model === '__other') { model = (prompt(t('输入 {tool} 能用的模型 ID', { tool: toolName(harness) })) || '').trim() || null; if (!model) return renderTools() }
      await api('/api/settings', { scope: 'harness', harness, mode: 'cli', model })
      await loadSettings(); toast(t('已保存'))
    }, select)
  }
}
// Every card opens the same management window; installation stays explicit.
function openConnectionManager(harness) {
  const render = () => {
    const h = state.harnesses.find(x => x.harness === harness), s = connState(h)
    const configured = h.claude ? !!h.claude.plugin : h.configured
    overlay('<div class="modal" role="dialog" aria-labelledby="connectionTitle"><div class="card"><div class="card-h"><h3 id="connectionTitle">' + t('管理接入') + ' · ' + esc(toolName(harness)) + '</h3><button type="button" class="x" data-close aria-label="' + t('关闭') + '">×</button></div><div class="card-b">' +
      '<p><span class="state ' + s.cls + '">' + esc(s.badge) + '</span></p><p>' + esc(s.text) + '</p>' +
      '<p class="muted">'+t('默认接入归档、后台摘要和查询，压缩由工具自身负责。')+'</p>'+
      '<div class="actions"><button type="button" class="btn primary" id="manageApply">' + t(configured ? '更新接入' : '接入') + '</button><button type="button" class="btn" id="manageCheck">' + t('检查接入') + '</button>'+(h.configured&&h.integration_enabled!==false||h.claude?.plugin?.enabled?'<button type="button" class="btn" id="manageDisconnect">'+t('取消接入')+'</button>':'')+'<button type="button" class="btn" data-close>' + t('关闭') + '</button></div></div></div></div>', root => {
      root.querySelector('#manageCheck').onclick = event => act(async () => { await loadHarnesses(); render(); toast(t('已重新检查')) }, event.currentTarget)
      root.querySelector('#manageApply').onclick = event => {
        if (harness === 'dsh') return openDshSetup()
        if (h.claude) return pluginAct(configured ? 'update' : 'install', event.currentTarget).then(render)
        return openSetup(harness)
      }
      root.querySelector('#manageDisconnect')?.addEventListener('click',()=>openDisconnect(harness))
    })
  }
  render()
}

function moduleSupport(c) {
  const ok = v => v && c.modules_min && v.localeCompare(c.modules_min, undefined, { numeric: true }) >= 0
  return [c.terminal_version && [t('终端'), c.terminal_version, ok(c.terminal_version)], c.desktop_version && [t('桌面版'), c.desktop_version, ok(c.desktop_version)]].filter(Boolean)
}
function claudeRows(h) {
  const c = h.claude, rows = []
  rows.push([t('接入方式'), c.plugin ? t('Claude 插件 · v{v}', { v: esc(c.plugin.version || '?') }) : h.configured ? t('旧方式：MCP + 钩子') : '<span class="muted">' + t('尚未安装插件') + '</span>'])
  if (c.plugin?.enabled && (c.legacy?.hooks || c.legacy?.mcp)) rows.push([t('旧接入'), '<span class="muted">' + t('还留着旧的钩子/MCP 登记，已自动停用') + '</span> <button type="button" class="link" data-plugin="cleanup">' + t('清理') + '</button>'])
  return rows
}
async function pluginAct(action, button) {
  const done = { install: t('插件已安装，新开的 Claude Code 对话生效'), update: t('插件已更新，新开的 Claude Code 对话生效'), cleanup: t('旧接入已清理，原配置已备份') }
  await act(async () => { await api('/api/claude-plugin', { action }); await loadHarnesses(); toast(done[action]) }, button)
}

// Setup: preview what changes → user confirms → write config → check it loads.
async function openSetup(harness) {
  const name = toolName(harness)
  const steps = [[t('检查本机配置'), ''], [t('写入 SuperLcm 配置（先备份原文件）'), ''], [t('验证能否正常加载'), '']]
  let preview = null, busy = false, lastCheck = null, reviewOpened = false, approveHooks = true
  const needsApproval = harness === 'codex' || harness === 'hermes'
  const render = (message = '', cls = 'calm', finished = false, extra = '') => overlay('<div class="modal" role="dialog" aria-labelledby="stitle"><div class="card"><div class="card-h"><div><h3 id="stitle">' + t('接入 {tool}', { tool: esc(name) }) + '</h3><p>' + t('接入后，{tool} 的对话会自动保存，其中的 AI 也能查阅全部已存对话。', { tool: esc(name) }) + '</p></div><button type="button" class="x" data-close aria-label="' + t('关闭') + '"' + (busy ? ' disabled' : '') + '>×</button></div><div class="card-b">' +
    '<ol class="steps">' + steps.map(([t, s]) => '<li class="' + s + '"><span>' + esc(t) + '</span></li>').join('') + '</ol>' +
    (preview ? '<details><summary>' + t('将修改的文件') + '</summary><div class="packet">' + esc([t('MCP 配置：') + preview.files.mcp + (preview.mcp_action === 'preserve' ? t('（已存在，保持不变）') : ''), t('事件钩子：') + preview.files.hooks + (preview.hook_events_added.length ? t('（新增 {list}）', { list: preview.hook_events_added.join(', ') }) : t('（已齐全）')), t('数据位置：') + preview.index_home].join('\n')) + '</div></details>' : '') +
    (message ? '<div class="notice ' + cls + '"><span>' + message + '</span></div>' : '') +
    // Codex and Hermes ask the user to approve new hooks; offer to do that step for them (their own documented way).
    (!finished && needsApproval && preview?.can_apply ? '<label class="check"><input type="checkbox" id="approveHooks"' + (approveHooks ? ' checked' : '') + (busy ? ' disabled' : '') + '><span><b>' + t('同时替我在 {tool} 里允许', { tool: esc(name) }) + '</b>' + t('相当于替你在 {tool} 里点一次「允许」，只针对 SuperLcm 自己的钩子。不勾的话，接入后要打开 {tool} 亲自确认。', { tool: esc(name) }) + '</span></label>' : '') +
    '<div class="actions">' + (finished ? extra + '<button type="button" class="btn' + (extra ? '' : ' primary') + '" data-close>' + t('完成') + '</button>' : '<button type="button" class="btn primary" id="applySetup"' + (preview?.can_apply && !busy ? '' : ' disabled') + '>' + t('确认接入') + '</button><button type="button" class="btn" data-close' + (busy ? ' disabled' : '') + '>' + t('取消') + '</button>') + '</div></div></div></div>', root => {
    root.querySelector('#applySetup')?.addEventListener('click', apply)
    root.querySelector('#approveHooks')?.addEventListener('change', event => { approveHooks = event.target.checked })
    root.querySelector('#openReview')?.addEventListener('click', event => act(async () => {
      await api('/api/open-review', { harness })
      reviewOpened = true; showResult(lastCheck)
    }, event.currentTarget))
    root.querySelector('#recheck')?.addEventListener('click', event => act(async () => { showResult(await api('/api/connection-check', { harness })); await loadHarnesses() }, event.currentTarget))
  })
  function showResult(check) {
    lastCheck = check
    const ok = harness === 'claude-code' ? check.ok : check.protocol?.ok
    steps[2][1] = ok ? 'done' : 'fail'
    if (!ok) return render(t('配置已保存，但验证未通过：') + esc(t(check.message || check.protocol?.error || '未知原因')), 'bad', true)
    if (harness === 'claude-code') return render('<b>' + t('接入完成。') + '</b>' + t('新开的 Claude Code 对话会自动加载；已打开的对话需要在 {cmd} 中重连或重开。', { cmd: '<span class="mono">/mcp</span>' }), 'calm', true)
    if (harness === 'pi') return render('<b>' + t('接入完成。') + '</b>' + t('新开的 Pi 对话会自动加载 SuperLcm；已打开的对话输入 {cmd} 即可加载。', { cmd: '<span class="mono">/reload</span>' }), 'calm', true)
    const trust = check.hook?.trust_check, tool = toolName(harness)
    if (trust?.ok) return render('<b>' + t('接入完成。') + '</b>' + t('{tool} 已信任 SuperLcm 的钩子，新开的对话即可使用。', { tool }), 'calm', true)
    const count = trust?.checked && trust.untrusted.length ? t('（尚未信任 {n} 个）', { n: trust.untrusted.length }) : ''
    const text = reviewOpened
      ? '<b>' + t('已在终端打开 {tool}。', { tool }) + '</b>' + (harness === 'codex' ? t('在它弹出的「Hooks need review」里选择信任，然后回来点「重新检查」。') : t('它会逐个询问是否允许 SuperLcm 的钩子，输入 y 允许，然后回来点「重新检查」。'))
      : '<b>' + t('还差一步：') + '</b>' + t('{tool} 要求你亲自确认一次新钩子。点「打开 {tool} 确认」，在弹出的界面里允许即可。', { tool }) + count
    render(text, 'calm', true, '<button type="button" class="btn primary" id="openReview">' + t('打开 {tool} 确认', { tool }) + '</button><button type="button" class="btn" id="recheck">' + t('重新检查') + '</button>')
  }
  render(t('正在检查…'))
  try {
    preview = await api('/api/setup-preview', { harness })
    steps[0][1] = 'done'
    render(preview.can_apply ? (preview.mcp_action === 'preserve' && !preview.hook_events_added.length ? t('配置已齐全，可以直接验证。') : t('确认后才会修改配置文件，原文件会先备份。')) : esc(t(preview.blocker)), preview.can_apply ? 'calm' : 'bad')
  } catch (error) { steps[0][1] = 'fail'; render(t('检查失败：') + esc(error.message), 'bad') }
  async function apply() {
    busy = true; render(t('正在写入…'))
    try {
      const x = await api('/api/setup-apply', { harness, revision: preview.revision, confirm: true, approve_hooks: needsApproval && approveHooks })
      if (!x.configuration_verified) throw new Error(t('配置已写入，但读回时不一致'))
      steps[1][1] = 'done'; render(t('正在验证…'))
      const check = await api('/api/connection-check', { harness })
      busy = false
      showResult(check)
      await loadHarnesses()
    } catch (error) { busy = false; steps[1][1] ||= 'fail'; render(t('接入失败：') + esc(error.message), 'bad') }
  }
}

// Import: pick past conversations from this computer's native records.
async function openImport(harness) {
  let page = { conversations: [], next_offset: 0 }, rows = []
  const render = () => overlay('<div class="modal" role="dialog" aria-labelledby="ititle"><div class="card"><div class="card-h"><div><h3 id="ititle">' + t('导入 {tool} 的对话', { tool: esc(toolName(harness)) }) + '</h3><p>' + t('只读取你选中的对话，不调用模型。导入后可以接续到任何已接入的工具。') + '</p></div><button type="button" class="x" data-close aria-label="' + t('关闭') + '">×</button></div><div class="card-b">' +
    '<div class="local-list">' + (rows.length ? rows.map((c, i) => '<div class="local-row"><span class="n" title="' + esc(c.path) + '">' + esc(c.name) + '<span class="muted"> · ' + ago(Date.parse(c.updated_at)) + (c.bytes ? ' · ' + (c.bytes >= 1048576 ? (c.bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(c.bytes / 1024)) + ' KB') : '') + '</span></span>' +
      (c.indexed ? '<button type="button" class="btn small" data-open="' + esc(c.session) + '">' + t('已导入 · 查看') + '</button>' : c.can_index ? '<button type="button" class="btn small" data-i="' + i + '">' + t('导入') + '</button>' : '<span class="muted">' + esc(t(c.error || '无法导入')) + '</span>') + '</div>').join('') : '<div class="empty">' + t('读取中…') + '</div>') + '</div>' +
    (page.next_offset !== null ? '<div class="actions"><button type="button" class="btn small" id="moreLocal">' + t('加载更多') + '</button></div>' : '') + '</div></div></div>', root => {
    for (const b of root.querySelectorAll('[data-i]')) b.onclick = () => act(async () => {
      const c = rows[Number(b.dataset.i)], x = await api('/api/index-local', { harness, key: c.key })
      c.indexed = true; c.session = x.source?.session || c.session
      toast(t('已导入「{name}」', { name: c.name })); render(); loadConversations()
    }, b)
    for (const b of root.querySelectorAll('[data-open]')) b.onclick = () => { closeOverlay(); show('conversations'); select(b.dataset.open) }
    root.querySelector('#moreLocal')?.addEventListener('click', event => act(more, event.target))
  })
  async function more() {
    page = await api('/api/local-conversations?harness=' + q(harness) + '&offset=' + page.next_offset)
    rows.push(...page.conversations); render()
    if (!rows.length) $('#overlay .local-list').innerHTML = '<div class="empty">' + t('没有找到本机对话记录。') + '</div>'
  }
  render(); await act(more)
}

/* ---------- settings ---------- */
async function loadSettings() {
  const s = admin.settings = await api('/api/settings')
  renderApiModels(); renderTuning(s.tuning); renderTakeover(s.takeover)
  if (state.harnesses) renderTools()
  $('#dataDir').value = s.index_home || ''
}
const hostOf = url => { try { return new URL(url).host } catch { return url || '' } }
const isLocal = url => /^https?:\/\/(127\.|localhost|\[::1\])/.test(url || '')
const EFFORT_LABELS = [['', t('默认（不指定）')], ['minimal', t('最少')], ['low', t('低')], ['medium', t('中')], ['high', t('高')], ['xhigh', t('极高')]]
const effortLabel = e => EFFORT_LABELS.find(x => x[0] === (e || ''))?.[1] || e
// What a card and the list call a model: its name, else its model ID; 思考程度 shown when set.
const modelName = m => (m.label || m.model) + (m.effort ? ' · ' + t('思考{e}', { e: effortLabel(m.effort) }) : '')
function addApiModel() { admin.modelEdit = 'new'; show('settings'); settingsSection('summary'); renderApiModels(); $('#apiModels [data-f="url"]')?.focus() }
// Settings › 摘要: the custom API models any tool card can pick.
function renderApiModels() {
  const list = admin.settings.api_models, edit = admin.modelEdit
  const row = m => '<div class="am-row"><div class="am-main"><b>' + esc(modelName(m)) + '</b><span>' + (m.label ? esc(m.model) + ' · ' : '') + esc(hostOf(m.url)) + ' · ' + (m.provider === 'openai' ? t('OpenAI 兼容') : 'Anthropic Messages') + ' · ' +
    (m.key_configured ? t('密钥已保存') : isLocal(m.url) ? t('本机地址，无需密钥') : t('缺少密钥')) + (m.used_by.length ? ' · ' + t('正在使用：{tools}', { tools: m.used_by.map(toolName).join(LANG === 'zh' ? '、' : ', ') }) : '') + '</span></div>' +
    '<button type="button" class="link" data-am-edit="' + esc(m.id) + '">' + t('修改') + '</button>' +
    '<button type="button" class="link" data-am-del="' + esc(m.id) + '"' + (m.used_by.length ? ' disabled title="' + t('先在「接入」页把使用它的工具换成别的方式') + '"' : '') + '>' + t('删除') + '</button></div>'
  $('#apiModels').innerHTML = (list.length || edit ? '' : '<p class="muted am-empty">' + t('还没有添加模型。') + '</p>') +
    list.map(m => edit === m.id ? modelForm(m) : row(m)).join('') +
    (edit === 'new' ? modelForm({}) : '<button type="button" class="btn" id="amAdd">' + t('+ 添加模型') + '</button>')
  const root = $('#apiModels')
  root.querySelector('#amAdd')?.addEventListener('click', () => { admin.modelEdit = 'new'; renderApiModels() })
  for (const b of root.querySelectorAll('[data-am-edit]')) b.onclick = () => { admin.modelEdit = b.dataset.amEdit; renderApiModels() }
  for (const b of root.querySelectorAll('[data-am-del]')) b.onclick = () => {
    // One more click to confirm, right on the button.
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = t('确认删除'); return }
    act(async () => { await api('/api/api-models/delete', { id: b.dataset.amDel }); await loadSettings(); toast(t('已删除')) }, b)
  }
  const form = root.querySelector('.am-form')
  if (!form) return
  const f = n => form.querySelector('[data-f="' + n + '"]')
  f('provider').onchange = () => { const url = f('url'); if (/api\.(anthropic|openai)\.com/.test(url.value) || !url.value) url.value = f('provider').value === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.anthropic.com/v1/messages' }
  form.querySelector('[data-am-cancel]').onclick = () => { admin.modelEdit = null; renderApiModels() }
  const save = form.querySelector('[data-am-save]'), note = form.querySelector('.am-note')
  // Any edit after a failed test goes back to testing first.
  form.oninput = () => { if (save.dataset.skip) { delete save.dataset.skip; save.textContent = t('测试并保存'); note.hidden = true } }
  save.onclick = async () => {
    const payload = { label: f('label').value.trim(), api_provider: f('provider').value, api_url: f('url').value.trim(), model: f('model').value.trim(), effort: f('effort').value || null }
    if (form.dataset.id) payload.id = form.dataset.id
    if (f('key').value) payload.api_key = f('key').value
    if (save.dataset.skip) payload.skip_test = true
    save.disabled = true; note.hidden = false; note.className = 'am-note notice calm'; note.textContent = payload.skip_test ? t('正在保存…') : t('正在用这个模型试写一句，最多等 45 秒…')
    try {
      await api('/api/api-models', payload)
      admin.modelEdit = null; await loadSettings(); toast(payload.skip_test ? t('已保存（未测试）') : t('测试通过，已保存'))
    } catch (error) {
      const failed = /^Test call failed: /.test(error.message)
      note.className = 'am-note notice warn'
      note.textContent = failed ? t('测试调用失败：{why}', { why: error.message.replace(/^Test call failed: /, '') }) + ' ' + t('检查接口地址、模型 ID、密钥和思考程度；确定没问题也可以仍然保存。') : error.message
      if (failed) { save.dataset.skip = '1'; save.textContent = t('仍然保存') }
    } finally { save.disabled = false }
  }
}
function modelForm(m) {
  const models = admin.settings.api_models, sameHost = !m.id && models.some(y => y.key_configured)
  const hint = m.key_configured ? t('已保存，留空保持不变') : sameHost ? t('地址和已添加的模型相同时可留空，沿用它的密钥') : t('首次保存必须填写；本机地址不需要可留空')
  return '<div class="am-form fields" data-id="' + esc(m.id || '') + '">' +
    '<label class="field">' + t('名称') + '<input data-f="label" maxlength="60" value="' + esc(m.label || '') + '" placeholder="' + t('可选，例如 Luna 高思考') + '"></label>' +
    '<label class="field">' + t('接口协议') + '<select data-f="provider"><option value="anthropic">Anthropic Messages</option><option value="openai"' + (m.provider === 'openai' ? ' selected' : '') + '>' + t('OpenAI 兼容') + '</option></select></label>' +
    '<label class="field">' + t('接口地址') + '<input data-f="url" type="url" value="' + esc(m.url || 'https://api.anthropic.com/v1/messages') + '"></label>' +
    '<label class="field">' + t('模型 ID') + '<input data-f="model" value="' + esc(m.model || '') + '" placeholder="' + t('例如 claude-sonnet-5') + '"></label>' +
    '<label class="field">' + t('思考程度') + '<select data-f="effort">' + EFFORT_LABELS.map(([v, l]) => '<option value="' + v + '"' + ((m.effort || '') === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' +
    '<label class="field">' + t('API 密钥') + '<input data-f="key" type="password" autocomplete="new-password" placeholder="' + hint + '"></label>' +
    '<p class="am-help">' + t('接口地址可以填完整地址，也可以只填服务商给的基础地址（如 …/v1），会按官方 SDK 的规则补全。思考程度按 OpenAI 的 reasoning_effort 或 Anthropic 的 thinking 发送，模型不支持时选「默认」。') + '</p>' +
    '<div class="am-note" hidden></div>' +
    '<div class="actions"><button type="button" class="btn primary" data-am-save>' + t('测试并保存') + '</button><button type="button" class="btn" data-am-cancel>' + t('取消') + '</button></div></div>'
}
// A tool card's model list for 本工具后台写: that tool's own catalog, plus any model typed in earlier.
async function fillModels(select, harness, current) {
  try {
    admin.catalog[harness] ||= await api('/api/models?backend=' + q(harness))
    const models = admin.catalog[harness].models
    select.innerHTML = '<option value="">' + t('跟随 {tool} 当前模型', { tool: toolName(harness) }) + '</option>' + models.map(m => '<option value="' + esc(m.id) + '">' + esc(m.label) + '</option>').join('') +
      (current && !models.some(m => m.id === current) ? '<option value="' + esc(current) + '">' + esc(current) + '</option>' : '') + '<option value="__other">' + t('其他模型…') + '</option>'
    select.value = current || ''
  } catch { /* following the tool's own model still works */ }
}
$('#saveWriter').onclick = () => act(async () => {
  await api('/api/tuning', pickedTuning())
  await loadSettings()
  $('#writerSaved').textContent = t('已保存')
}, $('#saveWriter'))
// Each tool picks its own summary writer on its card; a second row picks the model where there is a choice.
function writerRows(h) {
  const s = admin.settings
  if (!s) return []
  const x = s.settings.find(y => y.harness === h.harness)
  if (!h.supported && !h.detected && !x) return []
  const savedMode=x?x.mode:s.global.mode,mode=h.harness==='dsh'&&!['api','off'].includes(savedMode)?'off':savedMode,rows=[]
  const writers=h.harness==='dsh'?WRITERS.filter(w=>['api','off'].includes(w[0])):WRITERS
  rows.push([t('摘要生成'), '<select aria-label="' + t('摘要生成') + '" data-tool="' + esc(h.harness) + '">' + writers.map(([id, label]) => '<option value="' + id + '"' + (mode === id ? ' selected' : '') + '>' + label + '</option>').join('') + '</select>'])
  if (mode === 'cli' && h.bin) rows.push([t('模型'), '<select aria-label="' + t('模型') + '" data-model="' + esc(h.harness) + '"><option value="' + esc(x?.model || '') + '">' + esc(x?.model || t('跟随 {tool} 当前模型', { tool: toolName(h.harness) })) + '</option></select>'])
  if (mode === 'cli' && h.harness === 'claude-code' && h.claude?.plugin?.enabled) rows.push(['', '<span class="muted">' + t('Claude Code 2.1.286+ 在对话里直接调用这个模型，不另开会话；对话结束后剩下的交给后台命令行补完') + '</span>'])
  if (mode === 'api') {
    const current = s.api_models.find(m => m.id === x?.api_ref) || s.api_models.find(m => m.url === (x || s.global).api_url && m.model === (x || s.global).model)
    rows.push([t('模型'), s.api_models.length ? '<select aria-label="' + t('模型') + '" data-apimodel="' + esc(h.harness) + '">' + (current ? '' : '<option value="" selected disabled>' + t('选择一个模型') + '</option>') +
      s.api_models.map(m => '<option value="' + esc(m.id) + '"' + (m.id === current?.id ? ' selected' : '') + '>' + esc(modelName(m)) + ' · ' + esc(hostOf(m.url)) + '</option>').join('') + '<option value="__add">' + t('+ 添加模型…') + '</option></select>'
      : '<button type="button" class="link" data-add-model>' + t('先去设置里添加模型') + '</button>'])
  }
  return rows
}
function renderTuning(tuning) {
  const tokenMode=tuning.target_tokens!=null,size=tokenMode?tuning.target_tokens:'chars:'+tuning.target_chars
  for (const [id, value, label] of [['#segSize', size, v => tokenMode?t('约 {n} token', { n: fmt(v) }):t('约 {n} 字（旧设置）',{n:fmt(tuning.target_chars)})], ['#fanout', tuning.fanout, v => t('每 {n} 段合并为上一层', { n: v })]]) {
    const select = $(id)
    if (![...select.options].some(o => o.value === String(value))) select.add(new Option(label(value) + ' · ' + t('当前'), String(value)))
    select.value = String(value)
  }
  if(tokenMode) {
    $('#granEst').textContent=t('每段第 1 层原文目标约 {n} token，每 {f} 段合并为上一层。token 按中英文与符号估算。',{n:fmt(tuning.target_tokens),f:tuning.fanout})
    return
  }
  const perL1 = tuning.target_chars, perL2 = perL1 * tuning.fanout, perL3 = perL2 * tuning.fanout
  const big = n => LANG === 'zh' ? (n >= 10000 ? (n / 10000).toFixed(n % 10000 ? 1 : 0) + ' 万' : fmt(n)) : (n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'k' : fmt(n))
  $('#granEst').innerHTML = t('按当前设置：每段第 1 层摘要约覆盖 {a} 字原文，第 2 层约 {b} 字，第 3 层约 {c} 字。一段 100 万字的长对话大约产生 {n} 段第 1 层摘要。', { a: '<b>' + big(perL1) + '</b>', b: '<b>' + big(perL2) + '</b>', c: '<b>' + big(perL3) + '</b>', n: Math.ceil(1e6 / perL1) })
}
// 压缩 panel: changes apply at once; the checks say what the takeover needs on this computer.
// A size that is not one of the presets marks 自定义 and shows its value there.
function markSize(group, key, value) {
  const buttons = [...$(group).querySelectorAll('[data-' + key + ']')], preset = buttons.some(b => Number(b.dataset[key]) === value)
  for (const b of buttons) b.setAttribute('aria-checked', String(Number(b.dataset[key]) === value))
  const custom = $(group).querySelector('[data-custom]')
  custom.setAttribute('aria-checked', String(!preset)); custom.querySelector('small').textContent = preset ? '' : kfmt(value)
  if (preset) $(group + 'Custom').hidden = true
}
function renderTakeover(x) {
  if (!x) return
  $('#takeoverOn').checked = x.enabled
  markSize('#takeoverWindow', 'w', x.window); markSize('#takeoverKeep', 'k', x.keep)
  const c = state.harnesses?.find(h => h.harness === 'claude-code')?.claude, items = []
  if (!c) items.push(['wait', t('正在检查 Claude Code…')])
  else {
    items.push(c.plugin?.enabled ? ['ok', t('SuperLcm 插件已启用 · v{v}', { v: esc(c.plugin.version) })] : ['no', t('还没装 SuperLcm 插件，接管要靠它') + ' <button type="button" class="link" data-goto-connect>' + t('去安装') + '</button>'])
    for (const [name, v, ok] of moduleSupport(c)) items.push(ok ? ['ok', t('{name} Claude Code {v} 支持接管', { name, v: esc(v) })] : ['no', t('{name} Claude Code {v} 还不支持，要 {min} 或更新；它更新后自动生效', { name, v: esc(v), min: c.modules_min })])
  }
  const mode = admin.settings?.settings.find(s => s.harness === 'claude-code')?.mode
  items.push(mode === 'off' ? ['no', t('Claude Code 的摘要是关闭的，没有摘要就只能交回 Claude Code 压缩')] : ['ok', t('Claude Code 的摘要：{m}', { m: esc(writerLabel(mode || 'agent')) })])
  items.push(['info', x.enabled ? t('Claude Code 到 {t} 开始压缩，SuperLcm 当场换上摘要（摘要没跟上时由 Claude Code 自己总结）；它显示的窗口为 {w}，关闭后恢复原来的设置', { t: kfmt(x.window), w: kfmt(x.claude_window || x.window) }) : t('关闭中，Claude Code 的压缩窗口保持 {w}', { w: x.claude_window ? kfmt(x.claude_window) : t('默认') })])
  $('#takeoverChecks').innerHTML = items.map(([cls, text]) => '<li class="' + cls + '">' + text + '</li>').join('')
  $('#takeoverChecks').querySelector('[data-goto-connect]')?.addEventListener('click', () => show('connect'))
}
async function loadCompression() {
  if(admin.outdated) return
  admin.compression = await api('/api/compression')
  const dsh = state.harnesses.find(h => h.harness === 'dsh')
  if (dsh?.dsh?.profiles) {
    const before = JSON.stringify(dsh.dsh.profiles)
    for (const p of dsh.dsh.profiles) {
      if (!p.configured) continue
      Object.assign(p,dshRuntimeState(p,admin.compression.runtimes))
    }
    if(dsh.dsh.global?.configured)dsh.dsh.global.state=dshGlobalState(dsh.dsh.profiles)
    if (before !== JSON.stringify(dsh.dsh.profiles)) { renderTools(); renderStatus() }
  }
}
const saveTakeover = (change, control) => act(async () => {
  const cur = admin.settings.takeover, r = await api('/api/takeover', { enabled: cur.enabled, window: cur.window, keep: cur.keep, ...change })
  admin.settings.takeover = r; renderTakeover(r); if (state.harnesses) renderTools()
  toast(r.enabled ? t('已打开 · 门槛 {w}，保留最近 {k}，新开的 Claude Code 对话生效', { w: kfmt(r.window), k: kfmt(r.keep) }) : t('已关闭，Claude Code 的压缩窗口已恢复'))
}, control)
$('#takeoverOn').onchange = e => saveTakeover({ enabled: e.target.checked }, e.target)
for (const b of $('#takeoverWindow').querySelectorAll('[data-w]')) b.onclick = () => saveTakeover({ window: Number(b.dataset.w) }, b)
for (const b of $('#takeoverKeep').querySelectorAll('[data-k]')) b.onclick = () => saveTakeover({ keep: Number(b.dataset.k) }, b)
// 自定义: opens a box for a size in K, checked against the same limits the server enforces.
for (const [group, field] of [['#takeoverWindow', 'window'], ['#takeoverKeep', 'keep']]) {
  const box = $(group + 'Custom'), input = box.querySelector('input'), save = box.querySelector('button')
  $(group).querySelector('[data-custom]').onclick = () => { box.hidden = false; input.value = Math.round(admin.settings.takeover[field] / 1000); input.focus(); input.select() }
  const submit = () => {
    const k = Number(input.value), min = Number(input.min), max = Number(input.max)
    if (!Number.isFinite(k) || k < min || k > max) { toast(t('请输入 {min} 到 {max} 之间的数', { min, max })); return }
    saveTakeover({ [field]: Math.round(k) * 1000 }, save)
  }
  save.onclick = submit
  input.onkeydown = e => { if (e.key === 'Enter') submit() }
}
const pickedTuning = () => ({...($('#segSize').value.startsWith('chars:')?{target_chars:Number($('#segSize').value.slice(6))}:{target_tokens:Number($('#segSize').value)}), fanout: Number($('#fanout').value) })
for (const id of ['#segSize', '#fanout']) $(id).onchange = () => { renderTuning(pickedTuning()); $('#writerSaved').textContent = t('有未保存的修改') }

/* ---------- storage ---------- */
const bytes = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'
let cleanPlan = null
async function loadStorage() {
  const x = await api('/api/storage')
  $('#storeStats').innerHTML = [[fmt(x.conversations), t('个对话')], [fmt(x.records), t('条原文')], [bytes(x.originals_bytes), t('原文存档')], [bytes(x.index_bytes), t('索引与摘要')]].map(([v, k]) => '<div><b>' + v + '</b><span>' + k + '</span></div>').join('')
  const tools = (state.groups || []).map(g => g.harness), current = $('#cleanTool').value
  $('#cleanTool').innerHTML = '<option value="">' + t('全部工具') + '</option>' + tools.map(h => '<option value="' + esc(h) + '">' + esc(toolName(h)) + '</option>').join('')
  $('#cleanTool').value = tools.includes(current) ? current : ''
  await previewClean()
}
async function previewClean() {
  const days = Number($('#cleanAge').value), before_ms = Date.now() - days * 86400000, harness = $('#cleanTool').value
  const x = await api('/api/delete-preview', { before_ms, harness })
  cleanPlan = x.count ? { before_ms, harness, expect_count: x.count, records: x.records } : null
  $('#cleanPreview').innerHTML = x.count ? t('符合条件的有 {n} 个对话，共 {r} 条原文。', { n: '<b>' + fmt(x.count) + '</b>', r: fmt(x.records) }) + '<br><span class="muted">' + x.sample.map(c => esc(c.name)).join('、') + (x.count > x.sample.length ? ' …' : '') + '</span>' : t('没有符合条件的对话。')
  $('#cleanGo').disabled = !x.count
  $('#cleanGo').textContent = x.count ? t('删除这 {n} 个对话', { n: fmt(x.count) }) : t('删除这些对话')
}
for (const id of ['#cleanTool', '#cleanAge']) $(id).onchange = () => act(previewClean)
$('#cleanGo').onclick = () => {
  const plan = cleanPlan; if (!plan) return
  overlay('<div class="modal" role="dialog" aria-labelledby="bctitle"><div class="card" style="width:min(460px,100%)"><div class="card-h"><h3 id="bctitle">' + t('删除 {n} 个对话？', { n: fmt(plan.expect_count) }) + '</h3><button type="button" class="x" data-close aria-label="' + t('关闭') + '">×</button></div><div class="card-b">' +
    '<p style="margin:0">' + t('将从 SuperLcm 中删除这些对话的 {r} 条原文存档和全部摘要，删除后无法恢复。各工具里的原始对话不受影响。', { r: fmt(plan.records) }) + '</p>' +
    '<div class="actions"><button type="button" class="btn danger" id="bulkGo">' + t('删除') + '</button><button type="button" class="btn" data-close>' + t('取消') + '</button></div></div></div></div>', root => {
    const go = root.querySelector('#bulkGo')
    go.onclick = () => act(async () => {
      const x = await api('/api/delete-bulk', { before_ms: plan.before_ms, harness: plan.harness, expect_count: plan.expect_count })
      closeOverlay(); toast(t('已删除 {n} 个对话', { n: fmt(x.deleted) }))
      state.sel = null; state.detail = null; $('#detail').innerHTML = ''
      await loadConversations(); await loadStorage()
    }, go)
  })
}

/* ---------- appearance ---------- */
function prefs(key, value) {
  try { if (value === undefined) return localStorage.getItem('slcm-' + key); localStorage.setItem('slcm-' + key, value) } catch { return null }
}
function applyLook() {
  const palette = prefs('palette') || 'orange', theme = prefs('theme') || 'system'
  palette === 'orange' ? document.documentElement.removeAttribute('data-palette') : document.documentElement.dataset.palette = palette
  theme === 'system' ? document.documentElement.removeAttribute('data-theme') : document.documentElement.dataset.theme = theme
  $('#palSel').value = palette; $('#themeSel').value = theme
  for (const b of document.querySelectorAll('.sw')) b.setAttribute('aria-pressed', b.dataset.pal === palette)
}
for (const b of document.querySelectorAll('.sw')) b.onclick = () => { prefs('palette', b.dataset.pal); applyLook() }
$('#palSel').onchange = () => { prefs('palette', $('#palSel').value); applyLook() }
$('#themeSel').onchange = () => { prefs('theme', $('#themeSel').value); applyLook() }
$('#langSel').value = prefs('lang') || 'auto'
$('#langSel').onchange = () => { prefs('lang', $('#langSel').value); location.reload() }

function boot() {
  translatePage()
  applyLook()
  show(location.hash.slice(1) || 'conversations', false)
  act(loadConversations)
  act(async()=>{await loadHarnesses();if(!admin.outdated){await loadCompression()}})
  act(loadSettings)
}
let compressionPolling = false
setInterval(async () => {
  if (document.hidden || compressionPolling || (state.view !== 'connect' && state.view !== 'settings')) return
  compressionPolling = true
  try { await loadCompression() } catch {} finally { compressionPolling = false }
}, 5000)
