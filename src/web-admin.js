// Connect view (setup + local import), status pill, settings, appearance and boot().
const WRITERS = [
  ['agent', '对话内生成', '由对话中的 AI 顺带完成，读取多为缓存，最省钱'],
  ['cli', 'Claude 订阅', '后台自动补齐 · 调用 Claude CLI'],
  ['codex-cli', 'Codex 订阅', '后台自动补齐 · 调用 Codex CLI'],
  ['api', '自定义 API', '后台自动补齐 · 使用你的 API 密钥'],
  ['off', '关闭', '不生成摘要，原文照常保存']
]
const writerLabel = mode => WRITERS.find(w => w[0] === mode)?.[1] || mode
const admin = { settings: null, writer: 'agent', catalog: {} }

function connState(h) {
  const e = h.connection_evidence
  if (!h.supported) return { cls: 'off', text: h.local_conversations ? '暂不支持自动接入，可导入本机对话' : '暂不支持自动接入' }
  if (!h.bin) return { cls: 'off', text: '未找到 ' + toolName(h.harness) + ' 命令行' }
  if (!h.configuration_matches) return { cls: 'warn', text: h.configured ? '配置指向其他位置，需要重新接入' : '尚未接入' }
  if (e?.state === 'tool_verified' || e?.last_call_at) return { cls: 'on', text: '已接入 · AI 已成功调用' }
  if (e?.state === 'mcp_loaded') return { cls: 'on', text: '已接入 · 等待首次调用' }
  return { cls: 'warn', text: '已写入配置 · 重启 ' + toolName(h.harness) + ' 后生效' }
}

/* ---------- connect view ---------- */
async function loadHarnesses() {
  state.harnesses = (await api('/api/harnesses')).harnesses
  renderTools(); renderStatus()
}
function renderStatus() {
  const ready = state.harnesses.filter(h => h.configuration_matches)
  $('#statusDot').className = 'dot ' + (ready.length ? 'on' : 'warn')
  $('#statusText').textContent = ready.length ? '已接入 ' + ready.map(h => toolName(h.harness)).join('、') : '尚未接入工具'
}
function renderTools() {
  $('#tools').innerHTML = state.harnesses.map(h => {
    const s = connState(h)
    const button = h.supported
      ? '<button type="button" class="btn' + (h.configuration_matches ? '' : ' primary') + '" data-setup="' + esc(h.harness) + '"' + (h.bin ? '' : ' disabled') + '>' + (h.configuration_matches ? '检查' : '接入') + '</button>'
      : h.local_conversations ? '<button type="button" class="btn" data-import="' + esc(h.harness) + '">导入对话</button>' : ''
    return '<div class="tool' + (h.detected ? '' : ' dim') + '">' + mark(h.harness, 'lg') + '<div><div class="tn">' + esc(toolName(h.harness)) + (h.version ? '<span class="tp">' + esc(h.version) + '</span>' : '') + '</div><div class="ts"><span class="state ' + s.cls + '">' + esc(s.text) + '</span></div>' +
      (h.connection_evidence?.last_call_at ? '<div class="tp">最近调用：' + esc(h.connection_evidence.last_tool) + ' · ' + ago(Date.parse(h.connection_evidence.last_call_at)) + '</div>' : '') + '</div><div class="actions">' + button + '</div></div>'
  }).join('') || '<div class="empty">本机未检测到支持的工具。</div>'
  for (const b of $('#tools').querySelectorAll('[data-setup]')) b.onclick = () => openSetup(b.dataset.setup)
  for (const b of $('#tools').querySelectorAll('[data-import]')) b.onclick = () => openImport(b.dataset.import)
  const importable = state.harnesses.filter(h => h.local_conversations && h.detected)
  $('#importTools').innerHTML = importable.map(h => '<button type="button" class="btn" data-import="' + esc(h.harness) + '">' + mark(h.harness, 'sm') + esc(toolName(h.harness)) + '</button>').join('') || '<span class="muted">本机没有可导入的对话记录。</span>'
  for (const b of $('#importTools').querySelectorAll('[data-import]')) b.onclick = () => openImport(b.dataset.import)
}

// Setup: preview what changes → user confirms → write config → check it loads.
async function openSetup(harness) {
  const name = toolName(harness)
  const steps = [['检查本机配置', ''], ['写入 SuperLcm 配置（先备份原文件）', ''], ['验证能否正常加载', '']]
  let preview = null, busy = false
  const render = (message = '', cls = 'calm', finished = false) => overlay('<div class="modal" role="dialog" aria-labelledby="stitle"><div class="card"><div class="card-h"><div><h3 id="stitle">接入 ' + esc(name) + '</h3><p>接入后，' + esc(name) + ' 的对话会自动保存，其中的 AI 也能查阅全部已存对话。</p></div><button type="button" class="x" data-close aria-label="关闭"' + (busy ? ' disabled' : '') + '>×</button></div><div class="card-b">' +
    '<ol class="steps">' + steps.map(([t, s]) => '<li class="' + s + '"><span>' + esc(t) + '</span></li>').join('') + '</ol>' +
    (preview ? '<details><summary>将修改的文件</summary><div class="packet">' + esc(['MCP 配置：' + preview.files.mcp + (preview.mcp_action === 'preserve' ? '（已存在，保持不变）' : ''), '事件钩子：' + preview.files.hooks + (preview.hook_events_added.length ? '（新增 ' + preview.hook_events_added.join('、') + '）' : '（已齐全）'), '数据位置：' + preview.index_home].join('\n')) + '</div></details>' : '') +
    (message ? '<div class="notice ' + cls + '"><span>' + message + '</span></div>' : '') +
    '<div class="actions">' + (finished ? '<button type="button" class="btn primary" data-close>完成</button>' : '<button type="button" class="btn primary" id="applySetup"' + (preview?.can_apply && !busy ? '' : ' disabled') + '>确认接入</button><button type="button" class="btn" data-close' + (busy ? ' disabled' : '') + '>取消</button>') + '</div></div></div></div>', root => {
    root.querySelector('#applySetup')?.addEventListener('click', apply)
  })
  render('正在检查…')
  try {
    preview = await api('/api/setup-preview', { harness })
    steps[0][1] = 'done'
    render(preview.can_apply ? (preview.mcp_action === 'preserve' && !preview.hook_events_added.length ? '配置已齐全，可以直接验证。' : '确认后才会修改配置文件，原文件会先备份。') : esc(preview.blocker), preview.can_apply ? 'calm' : 'bad')
  } catch (error) { steps[0][1] = 'fail'; render('检查失败：' + esc(error.message), 'bad') }
  async function apply() {
    busy = true; render('正在写入…')
    try {
      const x = await api('/api/setup-apply', { harness, revision: preview.revision, confirm: true })
      if (!x.configuration_verified) throw new Error('配置已写入，但读回时不一致')
      steps[1][1] = 'done'; render('正在验证…')
      const check = await api('/api/connection-check', { harness })
      const ok = harness === 'claude-code' ? check.ok : check.protocol?.ok
      steps[2][1] = ok ? 'done' : 'fail'
      busy = false
      const next = harness === 'codex'
        ? '<b>还差一步：</b>在 Codex 中输入 <span class="mono">/hooks</span> 信任 SuperLcm 的钩子，然后新开一个对话即可使用。'
        : '<b>接入完成。</b>新开的 Claude Code 对话会自动加载；已打开的对话需要在 <span class="mono">/mcp</span> 中重连或重开。'
      render(ok ? next : '配置已保存，但验证未通过：' + esc(check.message || check.protocol?.error || '未知原因'), ok ? 'calm' : 'bad', true)
      await loadHarnesses()
    } catch (error) { busy = false; steps[1][1] ||= 'fail'; render('接入失败：' + esc(error.message), 'bad') }
  }
}

// Import: pick past conversations from this computer's native records.
async function openImport(harness) {
  let page = { conversations: [], next_offset: 0 }, rows = []
  const render = () => overlay('<div class="modal" role="dialog" aria-labelledby="ititle"><div class="card"><div class="card-h"><div><h3 id="ititle">导入 ' + esc(toolName(harness)) + ' 的对话</h3><p>只读取你选中的对话，不调用模型。导入后可以接续到任何已接入的工具。</p></div><button type="button" class="x" data-close aria-label="关闭">×</button></div><div class="card-b">' +
    '<div class="local-list">' + (rows.length ? rows.map((c, i) => '<div class="local-row"><span class="n" title="' + esc(c.path) + '">' + esc(c.name) + '<span class="muted"> · ' + ago(Date.parse(c.updated_at)) + (c.bytes ? ' · ' + (c.bytes >= 1048576 ? (c.bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(c.bytes / 1024)) + ' KB') : '') + '</span></span>' +
      (c.indexed ? '<button type="button" class="btn small" data-open="' + esc(c.session) + '">已导入 · 查看</button>' : c.can_index ? '<button type="button" class="btn small" data-i="' + i + '">导入</button>' : '<span class="muted">' + esc(c.error || '无法导入') + '</span>') + '</div>').join('') : '<div class="empty">读取中…</div>') + '</div>' +
    (page.next_offset !== null ? '<div class="actions"><button type="button" class="btn small" id="moreLocal">加载更多</button></div>' : '') + '</div></div></div>', root => {
    for (const b of root.querySelectorAll('[data-i]')) b.onclick = () => act(async () => {
      const c = rows[Number(b.dataset.i)], x = await api('/api/index-local', { harness, key: c.key })
      c.indexed = true; c.session = x.source?.session || c.session
      toast('已导入「' + c.name + '」'); render(); loadConversations()
    }, b)
    for (const b of root.querySelectorAll('[data-open]')) b.onclick = () => { closeOverlay(); show('conversations'); select(b.dataset.open) }
    root.querySelector('#moreLocal')?.addEventListener('click', event => act(more, event.target))
  })
  async function more() {
    page = await api('/api/local-conversations?harness=' + q(harness) + '&offset=' + page.next_offset)
    rows.push(...page.conversations); render()
    if (!rows.length) $('#overlay .local-list').innerHTML = '<div class="empty">没有找到本机对话记录。</div>'
  }
  render(); await act(more)
}

/* ---------- settings ---------- */
async function loadSettings() {
  const s = admin.settings = await api('/api/settings')
  admin.writer = s.global.mode
  renderWriter(); renderPerTool(); renderTuning(s.tuning)
  $('#dataDir').value = s.harnesses.find(h => h.index_home)?.index_home || ''
}
function renderWriter() {
  $('#writer').innerHTML = WRITERS.map(([id, t, d]) => '<button type="button" class="opt" data-w="' + id + '" aria-pressed="' + (admin.writer === id) + '"><span class="o1">' + t + '</span><span class="o2">' + d + '</span></button>').join('')
  for (const b of $('#writer').querySelectorAll('.opt')) b.onclick = () => { admin.writer = b.dataset.w; renderWriter() }
  const g = admin.settings.global, same = g.mode === admin.writer, mode = admin.writer
  let html = ''
  if (mode === 'cli' || mode === 'codex-cli') html = '<label class="field">模型<select id="wModel"><option value="">使用 CLI 默认模型</option>' + (same && g.model ? '<option value="' + esc(g.model) + '" selected>' + esc(g.model) + '</option>' : '') + '</select></label>'
  if (mode === 'api') html = '<label class="field">接口协议<select id="wProvider"><option value="anthropic">Anthropic Messages</option><option value="openai"' + (same && g.api_provider === 'openai' ? ' selected' : '') + '>OpenAI 兼容</option></select></label>' +
    '<label class="field">接口地址<input id="wUrl" type="url" value="' + esc(same && g.api_url || 'https://api.anthropic.com/v1/messages') + '"></label>' +
    '<label class="field">模型 ID<input id="wModelId" value="' + esc(same && g.model || '') + '" placeholder="例如 claude-sonnet-5"></label>' +
    '<label class="field">API 密钥<input id="wKey" type="password" autocomplete="new-password" placeholder="' + (g.api_key_configured ? '已保存，留空保持不变' : '首次保存必须填写') + '"></label>'
  if (mode === 'agent') html = '<div class="notice calm"><span>对话中的 AI 每轮回答后顺带整理一段摘要。对话停下时摘要也会停；需要补齐时，可以在对话详情页用订阅一键生成。</span></div>'
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
    select.innerHTML = '<option value="">使用 CLI 默认模型</option>' + admin.catalog[mode].models.map(m => '<option value="' + esc(m.id) + '">' + esc(m.label) + '</option>').join('') +
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
  $('#writerSaved').textContent = '已保存'
}, $('#saveWriter'))
function renderPerTool() {
  const s = admin.settings, own = new Map(s.settings.map(x => [x.harness, x]))
  const rows = s.harnesses.filter(h => h.supported || h.detected || own.has(h.harness))
  $('#perTool').innerHTML = rows.map(h => {
    const x = own.get(h.harness)
    return '<tr><td><span class="d-meta">' + mark(h.harness, 'sm') + esc(toolName(h.harness)) + '</span></td><td><select data-tool="' + esc(h.harness) + '"><option value="inherit">沿用默认</option>' +
      WRITERS.filter(w => w[0] !== 'api' || x?.mode === 'api').map(([id, t]) => '<option value="' + id + '"' + (x?.mode === id ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></td><td class="muted">' + writerLabel(x?.mode || s.global.mode) + '</td></tr>'
  }).join('')
  for (const select of $('#perTool').querySelectorAll('select')) select.onchange = () => act(async () => {
    const x = own.get(select.dataset.tool)
    if (select.value === 'api') return
    await api('/api/settings', { scope: 'harness', harness: select.dataset.tool, mode: select.value, model: x?.mode === select.value ? x.model : null })
    await loadSettings(); toast('已保存')
  }, select)
}
function renderTuning(t) {
  for (const [id, value, label] of [['#segSize', t.target_chars, v => '约 ' + fmt(v) + ' 字'], ['#segMsgs', t.batch_size, v => v + ' 条'], ['#fanout', t.fanout, v => '每 ' + v + ' 段合并为上一层']]) {
    const select = $(id)
    if (![...select.options].some(o => o.value === String(value))) select.add(new Option(label(value) + ' · 当前', String(value)))
    select.value = String(value)
  }
  const perL1 = t.target_chars, perL2 = perL1 * t.fanout, perL3 = perL2 * t.fanout
  const wan = n => n >= 10000 ? (n / 10000).toFixed(n % 10000 ? 1 : 0) + ' 万' : fmt(n)
  $('#granEst').innerHTML = '按当前设置：每段第 1 层摘要约覆盖 <b>' + wan(perL1) + '</b> 字原文，第 2 层约 <b>' + wan(perL2) + '</b> 字，第 3 层约 <b>' + wan(perL3) + '</b> 字。一段 100 万字的长对话大约产生 ' + Math.ceil(1e6 / perL1) + ' 段第 1 层摘要。'
}
for (const id of ['#segSize', '#segMsgs', '#fanout']) $(id).onchange = () => act(async () => {
  const t = await api('/api/tuning', { target_chars: Number($('#segSize').value), batch_size: Number($('#segMsgs').value), fanout: Number($('#fanout').value) })
  renderTuning(t); toast('已保存，只影响之后的新摘要')
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

function boot() {
  applyLook()
  show(location.hash.slice(1) || 'conversations', false)
  act(loadConversations)
  act(loadHarnesses)
  act(loadSettings)
}
