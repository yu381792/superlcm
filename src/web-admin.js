// Connect view (setup + local import), status pill, settings, appearance and boot().
const WRITERS = [
  ['agent', t('对话内生成'), t('由对话中的 AI 顺带完成，读取多为缓存，最省钱')],
  ['cli', t('Claude 订阅'), t('后台自动补齐 · 调用 Claude CLI')],
  ['codex-cli', t('Codex 订阅'), t('后台自动补齐 · 调用 Codex CLI')],
  ['api', t('自定义 API'), t('后台自动补齐 · 使用你的 API 密钥')],
  ['off', t('关闭（摘要方式）'), t('不生成摘要，原文照常保存')]
]
const writerLabel = mode => WRITERS.find(w => w[0] === mode)?.[1] || mode
const admin = { settings: null, writer: 'agent', catalog: {} }

function connState(h) {
  const e = h.connection_evidence
  if (!h.supported) return { cls: 'off', text: h.local_conversations ? t('暂不支持自动接入，可导入本机对话') : t('暂不支持自动接入') }
  if (!h.bin) return { cls: 'off', text: t('未找到 {tool} 命令行', { tool: toolName(h.harness) }) }
  if (!h.configuration_matches) return { cls: 'warn', text: h.configured ? t('配置指向其他位置，需要重新接入') : t('尚未接入') }
  if (e?.state === 'tool_verified' || e?.last_call_at) return { cls: 'on', text: t('已接入 · AI 已成功调用') }
  if (e?.state === 'mcp_loaded') return { cls: 'on', text: t('已接入 · 等待首次调用') }
  return { cls: 'warn', text: t('已写入配置 · 重启 {tool} 后生效', { tool: toolName(h.harness) }) }
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
    const s = connState(h)
    const button = h.supported
      ? '<button type="button" class="btn' + (h.configuration_matches ? '' : ' primary') + '" data-setup="' + esc(h.harness) + '"' + (h.bin ? '' : ' disabled') + '>' + (h.configuration_matches ? t('检查') : t('接入')) + '</button>'
      : h.local_conversations ? '<button type="button" class="btn" data-import="' + esc(h.harness) + '">' + t('导入对话') + '</button>' : ''
    return '<div class="tool' + (h.detected ? '' : ' dim') + '">' + mark(h.harness, 'lg') + '<div><div class="tn">' + esc(toolName(h.harness)) + (h.version ? '<span class="tp">' + esc(h.version) + '</span>' : '') + '</div><div class="ts"><span class="state ' + s.cls + '">' + esc(s.text) + '</span></div>' +
      (h.connection_evidence?.last_call_at ? '<div class="tp">' + t('最近调用：') + esc(h.connection_evidence.last_tool) + ' · ' + ago(Date.parse(h.connection_evidence.last_call_at)) + '</div>' : '') + writerPicker(h) + '</div><div class="actions">' + button + '</div></div>'
  }).join('') || '<div class="empty">' + t('本机未检测到支持的工具。') + '</div>'
  for (const b of $('#tools').querySelectorAll('[data-setup]')) b.onclick = () => openSetup(b.dataset.setup)
  for (const select of $('#tools').querySelectorAll('select[data-tool]')) select.onchange = () => act(async () => {
    const x = admin.settings.settings.find(y => y.harness === select.dataset.tool)
    await api('/api/settings', { scope: 'harness', harness: select.dataset.tool, mode: select.value, model: x?.mode === select.value ? x.model : null })
    await loadSettings(); toast(t('已保存'))
  }, select)
  for (const b of $('#tools').querySelectorAll('[data-import]')) b.onclick = () => openImport(b.dataset.import)
  const importable = state.harnesses.filter(h => h.local_conversations && h.detected)
  $('#importTools').innerHTML = importable.map(h => '<button type="button" class="btn" data-import="' + esc(h.harness) + '">' + mark(h.harness, 'sm') + esc(toolName(h.harness)) + '</button>').join('') || '<span class="muted">' + t('本机没有可导入的对话记录。') + '</span>'
  for (const b of $('#importTools').querySelectorAll('[data-import]')) b.onclick = () => openImport(b.dataset.import)
}

// Setup: preview what changes → user confirms → write config → check it loads.
async function openSetup(harness) {
  const name = toolName(harness)
  const steps = [[t('检查本机配置'), ''], [t('写入 SuperLcm 配置（先备份原文件）'), ''], [t('验证能否正常加载'), '']]
  let preview = null, busy = false
  const render = (message = '', cls = 'calm', finished = false) => overlay('<div class="modal" role="dialog" aria-labelledby="stitle"><div class="card"><div class="card-h"><div><h3 id="stitle">' + t('接入 {tool}', { tool: esc(name) }) + '</h3><p>' + t('接入后，{tool} 的对话会自动保存，其中的 AI 也能查阅全部已存对话。', { tool: esc(name) }) + '</p></div><button type="button" class="x" data-close aria-label="' + t('关闭') + '"' + (busy ? ' disabled' : '') + '>×</button></div><div class="card-b">' +
    '<ol class="steps">' + steps.map(([t, s]) => '<li class="' + s + '"><span>' + esc(t) + '</span></li>').join('') + '</ol>' +
    (preview ? '<details><summary>' + t('将修改的文件') + '</summary><div class="packet">' + esc([t('MCP 配置：') + preview.files.mcp + (preview.mcp_action === 'preserve' ? t('（已存在，保持不变）') : ''), t('事件钩子：') + preview.files.hooks + (preview.hook_events_added.length ? t('（新增 {list}）', { list: preview.hook_events_added.join(', ') }) : t('（已齐全）')), t('数据位置：') + preview.index_home].join('\n')) + '</div></details>' : '') +
    (message ? '<div class="notice ' + cls + '"><span>' + message + '</span></div>' : '') +
    '<div class="actions">' + (finished ? '<button type="button" class="btn primary" data-close>' + t('完成') + '</button>' : '<button type="button" class="btn primary" id="applySetup"' + (preview?.can_apply && !busy ? '' : ' disabled') + '>' + t('确认接入') + '</button><button type="button" class="btn" data-close' + (busy ? ' disabled' : '') + '>' + t('取消') + '</button>') + '</div></div></div></div>', root => {
    root.querySelector('#applySetup')?.addEventListener('click', apply)
  })
  render(t('正在检查…'))
  try {
    preview = await api('/api/setup-preview', { harness })
    steps[0][1] = 'done'
    render(preview.can_apply ? (preview.mcp_action === 'preserve' && !preview.hook_events_added.length ? t('配置已齐全，可以直接验证。') : t('确认后才会修改配置文件，原文件会先备份。')) : esc(t(preview.blocker)), preview.can_apply ? 'calm' : 'bad')
  } catch (error) { steps[0][1] = 'fail'; render(t('检查失败：') + esc(error.message), 'bad') }
  async function apply() {
    busy = true; render(t('正在写入…'))
    try {
      const x = await api('/api/setup-apply', { harness, revision: preview.revision, confirm: true })
      if (!x.configuration_verified) throw new Error(t('配置已写入，但读回时不一致'))
      steps[1][1] = 'done'; render(t('正在验证…'))
      const check = await api('/api/connection-check', { harness })
      const ok = harness === 'claude-code' ? check.ok : check.protocol?.ok
      steps[2][1] = ok ? 'done' : 'fail'
      busy = false
      const next = harness === 'codex'
        ? '<b>' + t('还差一步：') + '</b>' + t('在 Codex 中输入 {cmd} 信任 SuperLcm 的钩子，然后新开一个对话即可使用。', { cmd: '<span class="mono">/hooks</span>' })
        : '<b>' + t('接入完成。') + '</b>' + t('新开的 Claude Code 对话会自动加载；已打开的对话需要在 {cmd} 中重连或重开。', { cmd: '<span class="mono">/mcp</span>' })
      render(ok ? next : t('配置已保存，但验证未通过：') + esc(t(check.message || check.protocol?.error || '未知原因')), ok ? 'calm' : 'bad', true)
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
  admin.writer = s.global.mode
  renderWriter(); renderTuning(s.tuning)
  if (state.harnesses) renderTools()
  $('#dataDir').value = s.harnesses.find(h => h.index_home)?.index_home || ''
}
function renderWriter() {
  $('#writer').innerHTML = WRITERS.map(([id, t, d]) => '<button type="button" class="opt" data-w="' + id + '" aria-pressed="' + (admin.writer === id) + '"><span class="o1">' + t + '</span><span class="o2">' + d + '</span></button>').join('')
  for (const b of $('#writer').querySelectorAll('.opt')) b.onclick = () => { admin.writer = b.dataset.w; renderWriter() }
  const g = admin.settings.global, same = g.mode === admin.writer, mode = admin.writer
  let html = ''
  if (mode === 'cli' || mode === 'codex-cli') html = '<label class="field">' + t('模型') + '<select id="wModel"><option value="">' + t('使用 CLI 默认模型') + '</option>' + (same && g.model ? '<option value="' + esc(g.model) + '" selected>' + esc(g.model) + '</option>' : '') + '</select></label>'
  if (mode === 'api') html = '<label class="field">' + t('接口协议') + '<select id="wProvider"><option value="anthropic">Anthropic Messages</option><option value="openai"' + (same && g.api_provider === 'openai' ? ' selected' : '') + '>' + t('OpenAI 兼容') + '</option></select></label>' +
    '<label class="field">' + t('接口地址') + '<input id="wUrl" type="url" value="' + esc(same && g.api_url || 'https://api.anthropic.com/v1/messages') + '"></label>' +
    '<label class="field">' + t('模型 ID') + '<input id="wModelId" value="' + esc(same && g.model || '') + '" placeholder="' + t('例如 claude-sonnet-5') + '"></label>' +
    '<label class="field">' + t('API 密钥') + '<input id="wKey" type="password" autocomplete="new-password" placeholder="' + (g.api_key_configured ? t('已保存，留空保持不变') : t('首次保存必须填写')) + '"></label>'
  if (mode === 'agent') html = '<div class="notice calm"><span>' + t('对话中的 AI 每轮回答后顺带整理一段摘要。对话停下时摘要也会停；需要补齐时，可以在对话详情页一键补齐。') + '</span></div>'
  $('#writerFields').innerHTML = html
  $('#writerSaved').textContent = ''
  const provider = $('#wProvider')
  if (provider) provider.onchange = () => { const url = $('#wUrl'); if (/api\.(anthropic|openai)\.com/.test(url.value) || !url.value) url.value = provider.value === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.anthropic.com/v1/messages' }
  if ($('#wModel')) fillModels(mode, same ? g.model : null)
}
async function fillModels(mode, current) {
  try {
    admin.catalog[mode] ||= await api('/api/models?backend=' + q(mode))
    const select = $('#wModel'); if (!select || admin.writer !== mode) return
    select.innerHTML = '<option value="">' + t('使用 CLI 默认模型') + '</option>' + admin.catalog[mode].models.map(m => '<option value="' + esc(m.id) + '">' + esc(m.label) + '</option>').join('') +
      (current && !admin.catalog[mode].models.some(m => m.id === current) ? '<option value="' + esc(current) + '">' + esc(current) + '</option>' : '')
    select.value = current || ''
  } catch { /* the default model still works */ }
}
$('#saveWriter').onclick = () => act(async () => {
  const mode = admin.writer, payload = { scope: 'global', mode, model: null }
  if (mode === 'cli' || mode === 'codex-cli') payload.model = $('#wModel').value || null
  if (mode === 'api') { payload.api_provider = $('#wProvider').value; payload.api_url = $('#wUrl').value.trim(); payload.model = $('#wModelId').value.trim() || null; const key = $('#wKey').value; if (key) payload.api_key = key }
  await api('/api/settings', payload)
  await loadSettings()
  $('#writerSaved').textContent = t('已保存')
}, $('#saveWriter'))
// Per-tool summary writer, shown on each connect card. Custom API stays a global choice unless already saved per tool.
function writerPicker(h) {
  const s = admin.settings
  if (!s) return ''
  const x = s.settings.find(y => y.harness === h.harness)
  if (!h.supported && !h.detected && !x) return ''
  return '<label class="tw">' + t('摘要生成') + '<select data-tool="' + esc(h.harness) + '"><option value="inherit">' + t('沿用默认（{w}）', { w: writerLabel(s.global.mode) }) + '</option>' +
    WRITERS.filter(w => w[0] !== 'api' || x?.mode === 'api').map(([id, label]) => '<option value="' + id + '"' + (x?.mode === id ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label>'
}
function renderTuning(tuning) {
  for (const [id, value, label] of [['#segSize', tuning.target_chars, v => t('约 {n} 字', { n: fmt(v) })], ['#segMsgs', tuning.batch_size, v => t('{n} 条', { n: v })], ['#fanout', tuning.fanout, v => t('每 {n} 段合并为上一层', { n: v })]]) {
    const select = $(id)
    if (![...select.options].some(o => o.value === String(value))) select.add(new Option(label(value) + ' · ' + t('当前'), String(value)))
    select.value = String(value)
  }
  const perL1 = tuning.target_chars, perL2 = perL1 * tuning.fanout, perL3 = perL2 * tuning.fanout
  const big = n => LANG === 'zh' ? (n >= 10000 ? (n / 10000).toFixed(n % 10000 ? 1 : 0) + ' 万' : fmt(n)) : (n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'k' : fmt(n))
  $('#granEst').innerHTML = t('按当前设置：每段第 1 层摘要约覆盖 {a} 字原文，第 2 层约 {b} 字，第 3 层约 {c} 字。一段 100 万字的长对话大约产生 {n} 段第 1 层摘要。', { a: '<b>' + big(perL1) + '</b>', b: '<b>' + big(perL2) + '</b>', c: '<b>' + big(perL3) + '</b>', n: Math.ceil(1e6 / perL1) })
}
for (const id of ['#segSize', '#segMsgs', '#fanout']) $(id).onchange = () => act(async () => {
  const tuning = await api('/api/tuning', { target_chars: Number($('#segSize').value), batch_size: Number($('#segMsgs').value), fanout: Number($('#fanout').value) })
  renderTuning(tuning); toast(t('已保存，只影响之后的新摘要'))
})

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
