// Shared helpers, navigation and the conversations view. Loaded as a plain script with web-admin.js.
history.replaceState(null, '', '/' + location.hash)
const $ = selector => document.querySelector(selector)
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmt = n => Number(n || 0).toLocaleString(LOCALE)
const q = encodeURIComponent
const NAMES = { codex: 'Codex', 'claude-code': 'Claude Code', hermes: 'Hermes', pi: 'Pi', dsh: 'DSH', opencode: 'OpenCode', gemini: 'Gemini CLI', import: t('导入'), legacy: t('早期记录') }
const toolName = h => NAMES[h] || h
const state = { view: 'conversations', harnesses: [], rows: [], total: 0, offset: 0, groups: [], h: '', sel: null, query: '', detail: null, open: new Set(), children: new Map(), target: null }

async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json()
  if (!response.ok) throw new Error(t(data.error || '请求失败'))
  return data
}
function showError(message) { $('#errorText').textContent = message; $('#error').hidden = false }
$('#errorClose').onclick = () => { $('#error').hidden = true }
async function act(fn, button) {
  if (button) button.disabled = true
  try { return await fn() } catch (error) { showError(error.message) } finally { if (button) button.disabled = false }
}
function toast(message) { const t = $('#toast'); t.textContent = message; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true }, 2400) }
function ago(ms) {
  if (!ms) return t('时间未知')
  const diff = Date.now() - ms, minute = 60000, hour = 60 * minute
  if (diff < minute) return t('刚刚')
  if (diff < hour) return t('{n} 分钟前', { n: Math.floor(diff / minute) })
  if (diff < 24 * hour) return t('{n} 小时前', { n: Math.floor(diff / hour) })
  if (diff < 48 * hour) return t('昨天')
  return new Date(ms).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' })
}
function mark(h, size = '') {
  const icon = ICONS[h]
  return '<span class="hmark ' + size + '" title="' + esc(toolName(h)) + '">' + (icon || esc(toolName(h).slice(0, 2))) + '</span>'
}
async function copyText(text, button, label = t('复制')) {
  try { await navigator.clipboard.writeText(text); button.textContent = t('已复制') } catch { button.textContent = t('请手动选中复制') }
  setTimeout(() => { button.textContent = label }, 1600)
}
function closeOverlay() { $('#overlay').innerHTML = '' }
function overlay(html, bind) {
  $('#overlay').innerHTML = '<div class="scrim" data-close></div>' + html
  for (const el of $('#overlay').querySelectorAll('[data-close]')) el.onclick = closeOverlay
  bind?.($('#overlay'))
}

/* ---------- navigation ---------- */
const views = ['conversations', 'connect', 'settings']
function show(view, updateHash = true) {
  if (!views.includes(view)) view = 'conversations'
  state.view = view
  for (const b of document.querySelectorAll('.nav button')) b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')
  for (const v of views) $('#view-' + v).hidden = v !== view
  if (updateHash) history.replaceState(null, '', '#' + view)
}
for (const b of document.querySelectorAll('.nav button')) b.onclick = () => show(b.dataset.view)
// The brand always returns to the conversation list (also leaving the phone detail view).
$('#brand').onclick = event => { event.preventDefault(); $('#conv').classList.remove('show-detail'); show('conversations') }
// Settings show one section at a time, picked from the side list.
function settingsSection(sec) {
  for (const x of document.querySelectorAll('#setNav button')) x.dataset.sec === sec ? x.setAttribute('aria-current', 'true') : x.removeAttribute('aria-current')
  for (const p of document.querySelectorAll('.set-body .panel')) p.hidden = p.dataset.sec !== sec
}
for (const b of document.querySelectorAll('#setNav button')) b.onclick = () => { settingsSection(b.dataset.sec); if (b.dataset.sec === 'storage') act(loadStorage) }
window.addEventListener('hashchange', () => show(location.hash.slice(1), false))
$('#statusPill').onclick = () => show('connect')
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); show('conversations'); $('#q').focus() }
  if (event.key === 'Escape') closeOverlay()
})

/* ---------- conversation list ---------- */
async function loadConversations(reset = true) {
  if (reset) { state.offset = 0; state.rows = [] }
  const data = await api('/api/conversations?offset=' + state.offset + (state.h ? '&harness=' + q(state.h) : ''))
  state.rows.push(...data.sessions); state.total = data.total; state.groups = data.groups; state.offset = data.next_offset
  renderChips(); renderList()
  if (state.harnesses) renderTools()
  if (!state.sel && state.rows[0] && window.innerWidth > 860) select(state.rows[0].session)
}
function renderChips() {
  // Early records (no known tool) stay under 全部 without a filter of their own.
  const chips = [['', t('全部')]].concat(state.groups.filter(g => g.harness !== 'legacy').map(g => [g.harness, toolName(g.harness)]))
  $('#chips').innerHTML = chips.map(([h, name]) => '<button type="button" class="chip" aria-pressed="' + (state.h === h) + '" data-h="' + esc(h) + '">' + (h ? mark(h) : '') + esc(name) + '</button>').join('')
  for (const b of $('#chips').querySelectorAll('button')) b.onclick = () => act(() => { state.h = b.dataset.h; return state.query ? runSearch() : loadConversations() }, b)
}
function renderList() {
  if (state.query) return
  $('#rows').innerHTML = state.rows.length ? state.rows.map(c => {
    const pct = c.records ? Math.round(Math.min(c.summarized_to, c.records) / c.records * 100) : 0
    return '<div class="row-wrap"><button type="button" class="row" role="option" aria-selected="' + (c.session === state.sel) + '" data-id="' + esc(c.session) + '">' + mark(c.harness) +
      '<span class="name">' + esc(c.name) + '</span><span class="meta"><span class="num">' + t('{n} 条', { n: fmt(c.records) }) + '</span><span>·</span><span>' + ago(c.updated_ms) + '</span>' +
      (c.summary_count ? '<span class="mini" title="' + t('摘要覆盖 {n}%', { n: pct }) + '"><i style="width:' + pct + '%"></i></span>' : '<span>' + t('暂无摘要') + '</span>') + '</span></button>' + delButton(c) + '</div>'
  }).join('') : '<div class="empty"><span>' + t('还没有对话记录。') + '</span><button type="button" class="btn primary" id="goConnect">' + t('接入第一个工具') + '</button></div>'
  $('#listCount').textContent = t('{n} 个对话', { n: state.total })
  $('#more').hidden = state.offset === null
  for (const b of $('#rows').querySelectorAll('.row')) b.onclick = () => select(b.dataset.id)
  for (const b of $('#rows').querySelectorAll('[data-del]')) b.onclick = () => { const c = state.rows.find(x => x.session === b.dataset.del); if (c) openDelete(c) }
  const go = $('#goConnect'); if (go) go.onclick = () => show('connect')
}
$('#more').onclick = () => act(() => loadConversations(false), $('#more'))
const TRASH = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
function delButton(c) { return '<button type="button" class="row-del" data-del="' + esc(c.session) + '" title="' + t('删除对话') + '" aria-label="' + t('删除对话') + '">' + TRASH + '</button>' }
// Delete one conversation from SuperLcm after an explicit confirmation. The tool's own transcript is untouched.
function openDelete(c) {
  overlay('<div class="modal" role="dialog" aria-labelledby="dtitle"><div class="card" style="width:min(460px,100%)"><div class="card-h"><h3 id="dtitle">' + t('删除对话？') + '</h3><button type="button" class="x" data-close aria-label="' + t('关闭') + '">×</button></div><div class="card-b">' +
    '<p style="margin:0"><b>' + esc(c.name) + '</b></p>' +
    '<p style="margin:0">' + t('将从 SuperLcm 中删除它的 {n} 条原文存档和全部摘要，删除后无法恢复。', { n: fmt(c.records) }) + '</p>' +
    '<p class="muted" style="margin:0">' + t('{tool} 里的原始对话不受影响。之后这个对话即使继续，SuperLcm 也不会再自动收录；需要时可以在「接入」页重新导入。', { tool: esc(toolName(c.harness)) }) + '</p>' +
    '<div class="actions"><button type="button" class="btn danger" id="delGo">' + t('删除') + '</button><button type="button" class="btn" data-close>' + t('取消') + '</button></div></div></div></div>', root => {
    const go = root.querySelector('#delGo')
    go.onclick = () => act(async () => {
      await api('/api/delete', { session: c.session })
      closeOverlay(); toast(t('已删除'))
      if (state.sel === c.session) { state.sel = null; state.detail = null; $('#detail').innerHTML = ''; $('#conv').classList.remove('show-detail') }
      await loadConversations()
    }, go)
  })
}

/* ---------- search ---------- */
let searchTimer
$('#q').oninput = event => { state.query = event.target.value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(() => act(runSearch), 250) }
async function runSearch() {
  if (!state.query) { renderList(); return }
  const query = state.query, data = await api('/api/search?q=' + q(query) + (state.h ? '&harness=' + q(state.h) : ''))
  if (query !== state.query) return
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  const hl = text => esc(text).replace(pattern, m => '<mark>' + m + '</mark>')
  const hits = [
    ...data.summaries.map(s => ({ c: s.conversation, where: t('摘要 · 第 {n} 层', { n: s.level + 1 }) + ' · #' + s.first + '–' + s.last, text: s.summary.slice(0, 300), node: s })),
    ...data.events.map(e => ({ c: e.conversation, where: t('原文') + ' · #' + e.ordinal, text: e.snippet.replace(/^(user|assistant):\s*/, ''), ordinal: e.ordinal }))
  ]
  $('#rows').innerHTML =
    (data.conversations.length ? '<div class="group-label">' + t('对话') + '</div>' + data.conversations.map(c => '<button type="button" class="row" data-id="' + esc(c.session) + '">' + mark(c.harness) + '<span class="name">' + hl(c.name) + '</span><span class="meta">#' + esc(c.code) + '</span></button>').join('') : '') +
    (hits.length ? '<div class="group-label">' + t('内容 · {n} 处', { n: hits.length }) + '</div>' + hits.map((h, i) => '<button type="button" class="hit" data-i="' + i + '"><span class="where">' + esc(h.where) + ' · ' + esc(h.c.name) + '</span><span class="snip">' + hl(h.text) + '</span></button>').join('') : '') +
    (!data.conversations.length && !hits.length ? '<div class="empty">' + t('未找到「{q}」', { q: esc(query) }) + '</div>' : '')
  $('#listCount').textContent = t('搜索结果')
  $('#more').hidden = true
  for (const b of $('#rows').querySelectorAll('.row')) b.onclick = () => select(b.dataset.id)
  for (const b of $('#rows').querySelectorAll('.hit')) b.onclick = () => act(async () => {
    const hit = hits[Number(b.dataset.i)]
    await select(hit.c.session)
    state.selSeq++
    if (hit.node) await revealNode(hit.node)
    else openRaw(hit.ordinal - 3, hit.ordinal + 8, hit.ordinal)
  }, b)
}

/* ---------- conversation detail ---------- */
async function select(session) {
  state.sel = session; state.open = new Set(); state.children = new Map()
  $('#conv').classList.add('show-detail')
  for (const b of $('#rows').querySelectorAll('.row')) b.setAttribute('aria-selected', b.dataset.id === session)
  const seq = state.selSeq = (state.selSeq || 0) + 1
  await act(loadDetail)
  if (seq === state.selSeq) $('#detail').scrollTop = 0
}
async function loadDetail() {
  const session = state.sel
  const detail = await api('/api/conversation?session=' + q(session))
  if (session !== state.sel) return
  state.detail = detail
  renderDetail()
  clearTimeout(loadDetail.timer)
  if (detail.summarizing) loadDetail.timer = setTimeout(() => act(loadDetail), 4000)
}
const pct = (x, total) => (x / total * 100).toFixed(3) + '%'
function stripHtml(d) {
  const total = Math.max(d.records, 1), tail = d.records - d.summarized_to
  const maxLevel = d.bands.reduce((m, b) => Math.max(m, b.level), 0)
  let lanes = ''
  for (let level = maxLevel; level >= 1; level--) {
    lanes += '<span class="lane-label">' + t('第 {n} 层', { n: level + 1 }) + '</span><div class="lane">' + d.bands.filter(b => b.level === level).map(b =>
      '<button type="button" class="seg ' + (level > 3 ? 'lx' : 'l' + level) + '" data-node="' + esc(b.id) + '" title="' + t('第 {n} 层', { n: level + 1 }) + ' · #' + b.first + '–' + b.last + '" style="left:calc(' + pct(b.first, total) + ' + 1px);width:calc(' + pct(b.last - b.first + 1, total) + ' - 2px)"></button>').join('') + '</div>'
  }
  if (d.summary_count) lanes += '<span class="lane-label">' + t('第 {n} 层', { n: 1 }) + '</span><div class="lane l0" style="--p:' + pct(d.summarized_to, total) + '"></div>'
  lanes += '<span class="lane-label">' + t('原文') + '</span><div class="lane raw">' + (tail > 0 && d.summary_count ? '<span class="seg tail" style="left:' + pct(d.summarized_to, total) + ';right:0" title="' + t('最新 {n} 条尚未摘要', { n: tail }) + '"></span>' : '') + '</div>'
  const note = d.summary_count ? '<div class="strip-note">' + (d.bands.length ? '<span><i class="k" style="background:var(--l3)"></i>' + t('层级越高越概括') + '</span>' : '') + (tail > 0 ? '<span><i class="k" style="background:var(--tail)"></i>' + t('最新 {n} 条尚未摘要，原文可查', { n: fmt(tail) }) + '</span>' : '') + '<span style="margin-left:auto">' + t('摘要生成：') + writerLabel(d.setting.mode) + '</span></div>' : ''
  return '<div><div class="section-h"><h2>' + t('摘要层级') + '</h2>' + (d.bands.length ? '<span class="aside">' + t('点击色块定位到对应摘要') + '</span>' : '') + '</div><div class="strip"><div class="lanes">' + lanes + '</div><div class="axis"><span>#0</span>' + (d.records > 2 ? '<span>#' + Math.round(d.records / 2) + '</span>' : '') + '<span>#' + Math.max(d.records - 1, 0) + '</span></div>' + note + '</div></div>'
}
// One clear action; the method (and whose quota it spends) is chosen in a confirmation dialog.
// Only methods this computer can run are offered: installed CLIs and a saved custom API.
const BACKENDS = {
  cli: ['{tool} 后台写', '另起一个 {tool} 进程，用你在 {tool} 里配置的账号和模型来写，额度或计费也算在那边；不占用正在聊的对话。'],
  api: ['自定义 API', '使用设置里保存的接口和密钥，按服务商价格计费。']
}
function generateButton(label, cls = 'btn small') {
  const d = state.detail
  if (!(d.backends || []).length) return '<span class="muted">' + t('本机没有可用的摘要生成方式。') + '</span><button type="button" class="' + cls + '" data-goto="settings">' + t('配置自定义 API') + '</button>'
  if (!d.estimate?.calls) return '<span class="muted">' + t('未摘要的对话文字约 {a} 字，还不到一段摘要（{b} 字），暂不需要生成。', { a: fmt(d.estimate.tail_chars), b: fmt(d.estimate.target_chars) }) + '</span>'
  return '<button type="button" class="' + cls + '" data-generate>' + t(label) + '</button>'
}
function openGenerate() {
  const d = state.detail, e = d.estimate, list = d.backends
  let pick = list[0]
  const opts = () => list.map(b => '<button type="button" class="target" data-b="' + b + '" aria-pressed="' + (b === pick) + '"><span class="t1">' + t(BACKENDS[b][0], { tool: toolName(d.writer_tool) }) + '</span><span class="t2">' + t(BACKENDS[b][1], { tool: toolName(d.writer_tool) }) + '</span></button>').join('')
  overlay('<div class="modal" role="dialog" aria-labelledby="gtitle"><div class="card" style="width:min(520px,100%)"><div class="card-h"><h3 id="gtitle">' + t('生成摘要') + '</h3><button type="button" class="x" data-close aria-label="' + t('关闭') + '">×</button></div><div class="card-b">' +
    '<p style="margin:0">' + t('把尚未摘要的 {n} 条原文整理成分层摘要，方便浏览和接续。原文不会改动。', { n: fmt(e.records) }) + '</p>' +
    '<p class="muted" style="margin:0">' + t('预计调用模型约 {c} 次，在后台运行，可以关掉此页。', { c: fmt(e.calls) }) + (e.tail_chars ? t('最后约 {n} 字还不够一段，暂时只保留原文。', { n: fmt(e.tail_chars) }) : '') + '</p>' +
    '<div class="section-h"><h2>' + t('用哪种方式生成') + '</h2></div><div class="targets" id="genOpts">' + opts() + '</div>' +
    '<div class="actions"><button type="button" class="btn primary" id="genGo">' + t('开始生成') + '</button><button type="button" class="btn" data-close>' + t('取消') + '</button></div></div></div></div>', root => {
    const bind = () => { for (const b of root.querySelectorAll('[data-b]')) b.onclick = () => { pick = b.dataset.b; root.querySelector('#genOpts').innerHTML = opts(); bind() } }
    bind()
    const go = root.querySelector('#genGo')
    go.onclick = () => act(async () => {
      const x = await api('/api/summarize', { session: state.sel, backend: pick })
      closeOverlay(); toast(x.running ? t('已经在生成中') : t('已开始在后台生成摘要'))
      await loadDetail()
    }, go)
  })
}
function renderDetail() {
  const d = state.detail, c = d.source, tail = d.records - d.summarized_to
  let html = '<div class="detail-inner"><button type="button" class="btn small back" id="back">← ' + t('返回列表') + '</button>' +
    '<div class="d-head"><div class="d-title"><h1 title="' + esc(c.name) + '">' + esc(c.name) + '</h1><div class="d-meta">' + mark(c.harness, 'sm') + '<span>' + esc(toolName(c.harness)) + '</span><span class="tag" title="' + t('对话编号，接续时使用') + '">#' + esc(c.code) + '</span><span class="num">' + t('{n} 条原文', { n: fmt(d.records) }) + '</span><span>' + t('更新于 {t}', { t: ago(d.updated_ms) }) + '</span></div></div>' +
    '<div class="actions"><button type="button" class="btn icon" id="delete" title="' + t('删除对话') + '" aria-label="' + t('删除对话') + '">' + TRASH + '</button><button type="button" class="btn" id="rename">' + t('重命名') + '</button><button type="button" class="btn primary" id="continue">' + t('换个工具继续') + '</button></div></div>'
  html += stripHtml(d)
  if (d.summarizing) html += '<div class="notice calm"><span><b>' + t('正在生成摘要…') + '</b>' + t('完成的部分会陆续出现在下方。') + '</span></div>'
  else if (d.status === 'summary_error') html += '<div class="notice bad"><span><b>' + t('上次摘要生成失败。') + '</b>' + t('请确认所选方式可用（命令行工具已登录，或 API 密钥有效），然后重试。') + '</span><span class="actions">' + generateButton('重新生成摘要…') + '</span></div>'
  // Count pending work, not records: most records are tool calls with no text and need no summary.
  else if (d.summary_count && d.estimate?.calls >= 2 && d.setting.mode === 'agent') html += '<div class="notice"><span><b>' + t('摘要滞后：还差约 {n} 次摘要（含向上合并）。', { n: fmt(d.estimate.calls) }) + '</b>' + t('对话模型生成每轮只处理一段，跟不上新增内容。可以在后台一次补齐。') + '</span><span class="actions">' + generateButton('补齐摘要…') + '</span></div>'
  if (d.summary_count) {
    html += '<div><div class="section-h"><h2>' + t('摘要目录') + '</h2><span class="aside"><button type="button" class="link" id="collapseAll">' + t('收起全部') + '</button></span></div><div class="tree">' + d.nodes.map(nodeHtml).join('') +
      (tail > 0 ? '<div class="tail-row"><span>' + t('最新 {n} 条（{r}）尚未摘要', { n: '<b class="num">' + fmt(tail) + '</b>', r: '#' + d.summarized_to + '–#' + (d.records - 1) }) + '</span><button type="button" class="btn small" data-raw="' + Math.max(d.summarized_to, d.records - 60) + '-' + (d.records - 1) + '">' + t('查看原文') + '</button></div>' : '') + '</div></div>'
  } else {
    html += '<div class="notice calm"><span><b>' + t('此对话暂无摘要。') + '</b>' + t('{n} 条原文已完整保存，AI 可按编号读取和搜索；接续时将提供最近的原文。', { n: fmt(d.records) }) + (d.setting.mode === 'agent' ? t('对话模型生成只在该对话继续进行时才会写摘要。') : '') + '</span></div>' +
      '<div class="actions">' + (d.summarizing ? '' : generateButton('生成摘要…', 'btn primary')) + '<button type="button" class="btn" data-raw="' + Math.max(0, d.records - 60) + '-' + Math.max(d.records - 1, 0) + '">' + t('查看最近原文') + '</button></div>'
  }
  $('#detail').innerHTML = html + '</div>'
  bindDetail()
}
function nodeHtml(n) {
  const open = state.open.has(n.id), kids = state.children.get(n.id)
  const inner = !open ? '' : n.level > 0
    ? '<div class="children">' + (kids ? kids.map(nodeHtml).join('') : '<div class="tail-row">' + t('读取中…') + '</div>') + '</div>'
    : '<div class="raw-link"><button type="button" class="btn small" data-raw="' + n.first + '-' + n.last + '">' + t('查看 {n} 条原文', { n: n.last - n.first + 1 }) + '</button></div>'
  return '<div class="node" data-id="' + esc(n.id) + '" aria-expanded="' + open + '"><button type="button" class="node-h" data-toggle="' + esc(n.id) + '"><span class="caret"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5L7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></span>' +
    '<span class="lv l' + Math.min(n.level, 3) + '">' + t('第{n}层', { n: n.level + 1 }) + '</span><span class="node-text">' + esc(n.summary) + '</span><span class="range">#' + n.first + '–' + n.last + '</span></button>' + inner + '</div>'
}
async function ensureChildren(id) {
  if (state.children.has(id)) return
  const x = await api('/api/outline?session=' + q(state.sel) + '&node=' + q(id))
  if (x.nodes) state.children.set(id, x.nodes)
}
function findNode(id, list = state.detail.nodes) {
  for (const n of list) { if (n.id === id) return n; const kids = state.children.get(n.id); const hit = kids && findNode(id, kids); if (hit) return hit }
}
function bindDetail() {
  const d = state.detail, all = s => $('#detail').querySelectorAll(s)
  $('#back').onclick = () => $('#conv').classList.remove('show-detail')
  $('#continue').onclick = () => act(openContinue, $('#continue'))
  $('#rename').onclick = openRename
  $('#delete').onclick = () => openDelete({ ...d.source, session: state.sel, records: d.records })
  const collapse = $('#collapseAll'); if (collapse) collapse.onclick = () => { state.open.clear(); renderDetail() }
  for (const b of all('[data-toggle]')) b.onclick = () => act(async () => {
    const id = b.dataset.toggle, node = findNode(id)
    if (state.open.has(id)) state.open.delete(id)
    else { state.open.add(id); if (node?.level > 0) await ensureChildren(id) }
    renderDetail()
  })
  for (const b of all('[data-raw]')) b.onclick = () => { const [a, z] = b.dataset.raw.split('-').map(Number); openRaw(a, z) }
  for (const b of all('.seg[data-node]')) b.onclick = () => act(() => revealNode(d.bands.find(x => x.id === b.dataset.node), true))
  for (const b of all('[data-goto]')) b.onclick = () => { show(b.dataset.goto); if (b.dataset.goto === 'settings') settingsSection('summary') }
  for (const b of all('[data-generate]')) b.onclick = openGenerate
}
// Expand every ancestor of a node (found by range containment), then scroll to it.
async function revealNode(target, expand = false) {
  const d = state.detail
  const ancestors = [...d.nodes, ...d.bands].filter(n => n.level > target.level && n.first <= target.first && n.last >= target.last).sort((a, b) => b.level - a.level)
  for (const a of ancestors) { state.open.add(a.id); await ensureChildren(a.id) }
  if (expand && target.level > 0) { state.open.add(target.id); await ensureChildren(target.id) }
  renderDetail()
  const el = $('#detail').querySelector('.node[data-id="' + CSS.escape(target.id) + '"]')
  $('#detail').querySelector('.seg[data-node="' + CSS.escape(target.id) + '"]')?.setAttribute('aria-pressed', 'true')
  if (el) { el.classList.add('flash'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => el.classList.remove('flash'), 1600) }
}

/* ---------- original records drawer ---------- */
function describe(preview) {
  const m = /^(user|assistant):\s*/.exec(preview)
  if (m) return { who: m[1] === 'user' ? t('用户') : 'AI', text: preview.slice(m[0].length) }
  if (/^(custom-title|ai-title):/.test(preview)) return { who: t('标题'), text: preview.replace(/^[a-z-]+:\s*/, ''), other: true }
  return { who: '', text: preview }
}
async function openRaw(from, to, focus) {
  const d = state.detail, a = Math.max(0, from), z = Math.min(d.records - 1, Math.max(to, a))
  const x = await act(() => api('/api/events?session=' + q(state.sel) + '&from=' + a + '&to=' + z))
  if (!x) return
  const rows = []
  for (const e of x.events) {
    if (!e.preview.trim()) { const last = rows.at(-1); if (last?.hidden) { last.to = e.ordinal; last.n++ } else rows.push({ hidden: true, from: e.ordinal, to: e.ordinal, n: 1 }); continue }
    rows.push({ ordinal: e.ordinal, ...describe(e.preview) })
  }
  const body = rows.map(r => r.hidden
    ? '<div class="ev other"><span class="o">#' + r.from + (r.to !== r.from ? '–' + r.to : '') + '</span><div class="body">' + t('{n} 条工具调用或系统记录（完整内容可用 lcm_read 读取）', { n: r.n }) + '</div></div>'
    : '<div class="ev' + (r.other ? ' other' : '') + (r.ordinal === focus ? ' focus' : '') + '" data-o="' + r.ordinal + '"><span class="o">#' + r.ordinal + '</span><div><div class="who">' + esc(r.who) + '</div><div class="body">' + esc(r.text) + '</div></div></div>').join('')
  const ref = '#' + d.source.code + ' ' + t('原文') + ' ' + a + (z !== a ? '–' + z : '')
  overlay('<aside class="drawer" role="dialog" aria-label="' + t('原文') + '"><div class="drawer-h"><div><h3>' + t('原文') + ' · <span class="mono">#' + a + (z !== a ? '–' + z : '') + '</span></h3><div class="hint">' + esc(d.source.name) + ' · ' + t('与原始记录逐字一致') + '</div></div><button type="button" class="x" data-close aria-label="' + t('关闭') + '">×</button></div>' +
    '<div class="drawer-b">' + (body || '<div class="empty">' + t('这一段没有可显示的消息。') + '</div>') + '</div><div class="drawer-f"><span>' + t('AI 通过 {tool} 读取的内容与此一致', { tool: '<span class="mono">lcm_read</span>' }) + '</span><button type="button" class="btn small" id="copyRef">' + t('复制引用') + '</button></div></aside>', root => {
    root.querySelector('#copyRef').onclick = event => copyText(ref, event.target, t('复制引用'))
    root.querySelector('.ev.focus')?.scrollIntoView({ block: 'center' })
  })
}

/* ---------- continue in another tool ---------- */
async function openContinue() {
  const d = state.detail, x = await api('/api/continue?session=' + q(state.sel))
  if (LANG !== 'zh') x.line = t('通过 SuperLcm 接续对话 #{code}「{name}」，继续之前的任务。', { code: x.code, name: x.name })
  const tools = state.harnesses.filter(h => h.supported || h.detected)
  if (!state.target || !tools.some(h => h.harness === state.target)) state.target = (tools.find(h => h.configuration_matches && h.harness !== d.source.harness) || tools[0])?.harness
  const render = () => {
    const tool = tools.find(h => h.harness === state.target), ready = tool?.configuration_matches
    const quoted = "'" + x.line.replace(/'/g, "'\\''") + "'", cmd = { 'claude-code': 'claude ' + quoted, codex: 'codex ' + quoted, pi: 'pi ' + quoted }[state.target]
    overlay('<div class="modal" role="dialog" aria-labelledby="ctitle"><div class="card"><div class="card-h"><div><h3 id="ctitle">' + t('换个工具继续') + '</h3><p>' + t('在目标工具中新建对话，发送下方指令即可接续。原文完整保留，可随时查证。') + '</p></div><button type="button" class="x" data-close aria-label="' + t('关闭') + '">×</button></div><div class="card-b">' +
      '<div><div class="section-h"><h2>' + t('目标工具') + '</h2></div><div class="targets">' + tools.map(h => '<button type="button" class="target" data-t="' + esc(h.harness) + '" aria-pressed="' + (h.harness === state.target) + '"><span class="t1">' + mark(h.harness, 'sm') + esc(toolName(h.harness)) + '</span><span class="t2">' + (h.configuration_matches ? t('已接入') : h.supported ? t('未接入') : t('暂不支持自动接入')) + (h.harness === d.source.harness ? ' · ' + t('当前来源') : '') + '</span></button>').join('') + '</div></div>' +
      (ready
        ? '<div><div class="section-h"><h2>' + t('在 {tool} 新对话中发送', { tool: esc(toolName(state.target)) }) + '</h2></div><div class="say"><div class="say-h"><span>' + t('接续指令') + '</span><button type="button" class="btn small" id="cp1">' + t('复制') + '</button></div><div class="say-b">' + esc(x.line) + '</div></div></div>' +
          (cmd ? '<div class="say"><div class="say-h"><span>' + t('或在终端中启动') + '</span><button type="button" class="btn small" id="cp2">' + t('复制') + '</button></div><div class="say-b mono">' + esc(cmd) + '</div></div>' : '') +
          '<div><div class="section-h"><h2>' + t('目标对话将获得') + '</h2></div><ul class="gets"><li>' + t('顶层摘要目录：已完成的工作与已定事项') + '</li><li>' + t('最近的原文：衔接中断处的上下文') + '</li><li>' + t('按编号读取任意原文：细节不因压缩失真') + '</li></ul></div>' +
          '<details><summary>' + t('预览发送内容（{n} 字）', { n: fmt(x.packet.content.length) }) + '</summary><div class="packet">' + esc(x.packet.content) + '</div></details>'
        : '<div class="notice"><span><b>' + (tool?.supported ? t('{tool} 尚未接入。', { tool: esc(toolName(state.target)) }) : t('{tool} 暂不支持自动接入。', { tool: esc(toolName(state.target)) })) + '</b>' + (tool?.supported ? t('完成一次接入后，即可从任意工具接续到这里。') : t('可以在它的 MCP 设置中手动添加 SuperLcm 后再接续。')) + '</span></div>' +
          (tool?.supported ? '<div class="actions"><button type="button" class="btn primary" id="goSetup">' + t('接入 {tool}', { tool: esc(toolName(state.target)) }) + '</button></div>' : '')) +
      '</div></div></div>', root => {
      for (const b of root.querySelectorAll('.target')) b.onclick = () => { state.target = b.dataset.t; render() }
      root.querySelector('#cp1')?.addEventListener('click', event => copyText(x.line, event.target))
      root.querySelector('#cp2')?.addEventListener('click', event => copyText(cmd, event.target))
      root.querySelector('#goSetup')?.addEventListener('click', () => { closeOverlay(); show('connect'); openSetup(state.target) })
    })
  }
  render()
}
function openRename() {
  const c = state.detail.source
  overlay('<div class="modal" role="dialog" aria-labelledby="rtitle"><div class="card" style="width:min(440px,100%)"><div class="card-h"><h3 id="rtitle">' + t('重命名') + '</h3><button type="button" class="x" data-close aria-label="' + t('关闭') + '">×</button></div><form class="card-b" id="renameForm"><label class="field">' + t('对话名称') + '<input id="newName" maxlength="160" value="' + esc(c.name) + '"></label><div class="actions"><button type="submit" class="btn primary">' + t('保存') + '</button><button type="button" class="btn" data-close>' + t('取消') + '</button></div></form></div></div>', root => {
    root.querySelector('#newName').select()
    root.querySelector('#renameForm').onsubmit = event => {
      event.preventDefault()
      const name = root.querySelector('#newName').value.trim()
      if (!name) return
      act(async () => { await api('/api/rename', { session: state.sel, name }); closeOverlay(); toast(t('已重命名')); await loadDetail(); await loadConversations() })
    }
  })
}
