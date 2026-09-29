// Connect view (setup + local import), status pill, settings, appearance and boot().
const WRITERS = [
  ['agent', t('对话模型生成'), t('正在聊天的 AI 凭记忆顺手写，几乎不多花钱')],
  ['cli', t('本工具后台写'), t('另起一个该工具的进程来写，用它已配置的模型，不占用正在聊的对话')],
  ['api', t('自定义 API'), t('后台单独写 · 使用你的 API 密钥')],
  ['off', t('关闭（摘要方式）'), t('不生成摘要，原文照常保存')]
]
const writerLabel = mode => WRITERS.find(w => w[0] === mode)?.[1] || mode
const admin = { settings: null, catalog: {}, modelEdit: null }

// Short badge plus a plain-language detail line, both from real evidence.
function connState(h) {
  const e = h.connection_evidence, tool = toolName(h.harness)
  if (!h.supported) return { cls: 'off', badge: t('仅导入'), text: h.local_conversations ? t('暂不支持自动接入，可导入本机对话') : t('暂不支持自动接入') }
  if (!h.bin) return { cls: 'off', badge: t('未安装'), text: t('未找到 {tool} 命令行', { tool }) }
  if (!h.configuration_matches) return h.configured ? { cls: 'warn', badge: t('需更新'), text: t('点「接入」更新一次，以后 {tool} 升级不会影响 SuperLcm', { tool }) } : { cls: 'warn', badge: t('未接入'), text: t('接入后，新对话会自动存入 SuperLcm') }
  if (h.capture_stale) return { cls: 'warn', badge: t('没在存'), text: h.harness === 'codex' ? t('最近的 Codex 对话没有存进来，多半是 Codex 在等你允许钩子。点「检查接入」可以一键允许') : t('最近的 {tool} 对话没有存进来。点「检查接入」看看哪里不对', { tool }) }
  if (h.node_borrowed) return { cls: 'warn', badge: t('已接入'), text: t('借用 {owner} 自带的 node 运行；{owner} 升级后若失灵，点「接入」即可恢复', { owner: h.node_borrowed }) }
  // Capture is what shows the connection works; the AI calling SuperLcm's tools is optional and rarer.
  if (h.hook_seen) return { cls: 'on', badge: t('已接入'), text: t('最近一次存入：{t}', { t: ago(Date.parse(h.hook_seen.replace(' ', 'T') + 'Z')) }) }
  if (e?.last_call_at) return { cls: 'on', badge: t('已接入'), text: t('AI 最近一次调用：{t}', { t: ago(Date.parse(e.last_call_at)) }) }
  if (e?.state === 'tool_verified') return { cls: 'on', badge: t('已接入'), text: t('AI 已成功调用') }
  if (e?.state === 'mcp_loaded') return { cls: 'on', badge: t('已接入'), text: t('已加载，等待 AI 首次调用') }
  return { cls: 'warn', badge: t('待重启'), text: t('已写入配置 · 重启 {tool} 后生效', { tool }) }
}

/* ---------- connect view ---------- */
async function loadHarnesses() {
  state.harnesses = (await api('/api/harnesses')).harnesses
  renderTools(); renderStatus()
}
function renderStatus() {
  const ready = state.harnesses.filter(h => h.configuration_matches)
  $('#statusDot').className = 'dot ' + (ready.length ? 'on' : 'warn')
  $('#statusText').textContent = ready.length ? t('已接入 {tools}', { tools: ready.map(h => toolName(h.harness)).join(LANG === 'zh' ? '、' : ', ') }) : t('尚未接入工具')
}
function renderTools() {
  $('#tools').innerHTML = state.harnesses.map(h => {
    const s = connState(h), count = state.groups?.find(g => g.harness === h.harness)?.n || 0
    const buttons = (h.supported ? '<button type="button" class="btn' + (h.configuration_matches ? '' : ' primary') + '" data-setup="' + esc(h.harness) + '"' + (h.bin ? '' : ' disabled') + '>' + (h.configuration_matches ? t('检查接入') : t('接入')) + '</button>' : '') +
      (h.local_conversations && h.detected ? '<button type="button" class="btn" data-import="' + esc(h.harness) + '">' + t('导入历史对话') + '</button>' : '')
    const rows = [[t('状态'), esc(s.text)], [t('已存对话'), count ? t('{n} 个', { n: fmt(count) }) : '<span class="muted">' + t('暂无') + '</span>']]
    rows.push(...writerRows(h))
    return '<article class="tcard' + (h.detected ? '' : ' dim') + '"><header class="tc-h">' + mark(h.harness, 'lg') + '<div class="tc-name"><div class="tn">' + esc(toolName(h.harness)) + '</div><div class="tv">' + esc(h.version || (h.detected ? '' : t('本机未检测到'))) + '</div></div><span class="state ' + s.cls + '">' + esc(s.badge) + '</span></header>' +
      '<dl class="tc-kv">' + rows.map(([k, v]) => '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>').join('') + '</dl>' +
      (buttons ? '<footer class="tc-f">' + buttons + '</footer>' : '') + '</article>'
  }).join('') || '<div class="empty">' + t('本机未检测到支持的工具。') + '</div>'
  for (const b of $('#tools').querySelectorAll('[data-setup]')) b.onclick = () => openSetup(b.dataset.setup)
  for (const b of $('#tools').querySelectorAll('[data-import]')) b.onclick = () => openImport(b.dataset.import)
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
  renderApiModels(); renderTuning(s.tuning)
  if (state.harnesses) renderTools()
  $('#dataDir').value = s.index_home || ''
}
const hostOf = url => { try { return new URL(url).host } catch { return url || '' } }
const isLocal = url => /^https?:\/\/(127\.|localhost|\[::1\])/.test(url || '')
function addApiModel() { admin.modelEdit = 'new'; show('settings'); settingsSection('summary'); renderApiModels(); $('#apiModels [data-f="url"]')?.focus() }
// Settings › 摘要: the custom API models any tool card can pick.
function renderApiModels() {
  const list = admin.settings.api_models, edit = admin.modelEdit
  const row = m => '<div class="am-row"><div class="am-main"><b>' + esc(m.model) + '</b><span>' + esc(hostOf(m.url)) + ' · ' + (m.provider === 'openai' ? t('OpenAI 兼容') : 'Anthropic Messages') + ' · ' +
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
  form.querySelector('[data-am-save]').onclick = event => act(async () => {
    const payload = { api_provider: f('provider').value, api_url: f('url').value.trim(), model: f('model').value.trim() }
    if (form.dataset.id) payload.id = form.dataset.id
    if (f('key').value) payload.api_key = f('key').value
    await api('/api/api-models', payload)
    admin.modelEdit = null; await loadSettings(); toast(t('已保存'))
  }, event.currentTarget)
}
function modelForm(m) {
  const models = admin.settings.api_models, sameHost = !m.id && models.some(y => y.key_configured)
  const hint = m.key_configured ? t('已保存，留空保持不变') : sameHost ? t('地址和已添加的模型相同时可留空，沿用它的密钥') : t('首次保存必须填写；本机地址不需要可留空')
  return '<div class="am-form fields" data-id="' + esc(m.id || '') + '">' +
    '<label class="field">' + t('接口协议') + '<select data-f="provider"><option value="anthropic">Anthropic Messages</option><option value="openai"' + (m.provider === 'openai' ? ' selected' : '') + '>' + t('OpenAI 兼容') + '</option></select></label>' +
    '<label class="field">' + t('接口地址') + '<input data-f="url" type="url" value="' + esc(m.url || 'https://api.anthropic.com/v1/messages') + '"></label>' +
    '<label class="field">' + t('模型 ID') + '<input data-f="model" value="' + esc(m.model || '') + '" placeholder="' + t('例如 claude-sonnet-5') + '"></label>' +
    '<label class="field">' + t('API 密钥') + '<input data-f="key" type="password" autocomplete="new-password" placeholder="' + hint + '"></label>' +
    '<div class="actions"><button type="button" class="btn primary" data-am-save>' + t('保存') + '</button><button type="button" class="btn" data-am-cancel>' + t('取消') + '</button></div></div>'
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
  const mode = x ? x.mode : s.global.mode, rows = []
  rows.push([t('摘要生成'), '<select aria-label="' + t('摘要生成') + '" data-tool="' + esc(h.harness) + '">' + WRITERS.map(([id, label]) => '<option value="' + id + '"' + (mode === id ? ' selected' : '') + '>' + label + '</option>').join('') + '</select>'])
  if (mode === 'cli' && h.bin) rows.push([t('模型'), '<select aria-label="' + t('模型') + '" data-model="' + esc(h.harness) + '"><option value="' + esc(x?.model || '') + '">' + esc(x?.model || t('跟随 {tool} 当前模型', { tool: toolName(h.harness) })) + '</option></select>'])
  if (mode === 'api') {
    const current = s.api_models.find(m => m.id === x?.api_ref) || s.api_models.find(m => m.url === (x || s.global).api_url && m.model === (x || s.global).model)
    rows.push([t('模型'), s.api_models.length ? '<select aria-label="' + t('模型') + '" data-apimodel="' + esc(h.harness) + '">' + (current ? '' : '<option value="" selected disabled>' + t('选择一个模型') + '</option>') +
      s.api_models.map(m => '<option value="' + esc(m.id) + '"' + (m.id === current?.id ? ' selected' : '') + '>' + esc(m.model) + ' · ' + esc(hostOf(m.url)) + '</option>').join('') + '<option value="__add">' + t('+ 添加模型…') + '</option></select>'
      : '<button type="button" class="link" data-add-model>' + t('先去设置里添加模型') + '</button>'])
  }
  return rows
}
function renderTuning(tuning) {
  for (const [id, value, label] of [['#segSize', tuning.target_chars, v => t('约 {n} 字', { n: fmt(v) })], ['#fanout', tuning.fanout, v => t('每 {n} 段合并为上一层', { n: v })]]) {
    const select = $(id)
    if (![...select.options].some(o => o.value === String(value))) select.add(new Option(label(value) + ' · ' + t('当前'), String(value)))
    select.value = String(value)
  }
  const perL1 = tuning.target_chars, perL2 = perL1 * tuning.fanout, perL3 = perL2 * tuning.fanout
  const big = n => LANG === 'zh' ? (n >= 10000 ? (n / 10000).toFixed(n % 10000 ? 1 : 0) + ' 万' : fmt(n)) : (n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'k' : fmt(n))
  $('#granEst').innerHTML = t('按当前设置：每段第 1 层摘要约覆盖 {a} 字原文，第 2 层约 {b} 字，第 3 层约 {c} 字。一段 100 万字的长对话大约产生 {n} 段第 1 层摘要。', { a: '<b>' + big(perL1) + '</b>', b: '<b>' + big(perL2) + '</b>', c: '<b>' + big(perL3) + '</b>', n: Math.ceil(1e6 / perL1) })
}
const pickedTuning = () => ({ target_chars: Number($('#segSize').value), fanout: Number($('#fanout').value) })
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
  act(loadHarnesses)
  act(loadSettings)
}
