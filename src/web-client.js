// Shared helpers, navigation and the conversations view. Loaded as a plain script with web-admin.js.
history.replaceState(null, '', '/' + location.hash)
const $ = selector => document.querySelector(selector)
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmt = n => Number(n || 0).toLocaleString('zh-CN')
const q = encodeURIComponent
const NAMES = { codex: 'Codex', 'claude-code': 'Claude Code', hermes: 'Hermes', pi: 'Pi', opencode: 'OpenCode', gemini: 'Gemini CLI', import: '导入', legacy: '早期记录' }
const toolName = h => NAMES[h] || h
const state = { view: 'conversations', harnesses: [], rows: [], total: 0, offset: 0, groups: [], h: '', sel: null, query: '', detail: null, open: new Set(), children: new Map(), target: null }

async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '请求失败')
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
  if (!ms) return '时间未知'
  const diff = Date.now() - ms, minute = 60000, hour = 60 * minute
  if (diff < minute) return '刚刚'
  if (diff < hour) return Math.floor(diff / minute) + ' 分钟前'
  if (diff < 24 * hour) return Math.floor(diff / hour) + ' 小时前'
  if (diff < 48 * hour) return '昨天'
  const d = new Date(ms); return (d.getMonth() + 1) + '月' + d.getDate() + '日'
}
function mark(h, size = '') {
  const icon = ICONS[h]
  return '<span class="hmark ' + size + '" title="' + esc(toolName(h)) + '">' + (icon || esc(toolName(h).slice(0, 2))) + '</span>'
}
async function copyText(text, button, label = '复制') {
  try { await navigator.clipboard.writeText(text); button.textContent = '已复制' } catch { button.textContent = '请手动选中复制' }
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
  if (!state.sel && state.rows[0] && window.innerWidth > 860) select(state.rows[0].session)
}
function renderChips() {
  const chips = [['', '全部']].concat(state.groups.map(g => [g.harness, toolName(g.harness)]))
  $('#chips').innerHTML = chips.map(([h, name]) => '<button type="button" class="chip" aria-pressed="' + (state.h === h) + '" data-h="' + esc(h) + '">' + (h ? mark(h) : '') + esc(name) + '</button>').join('')
  for (const b of $('#chips').querySelectorAll('button')) b.onclick = () => act(() => { state.h = b.dataset.h; return state.query ? runSearch() : loadConversations() }, b)
}
function renderList() {
  if (state.query) return
  $('#rows').innerHTML = state.rows.length ? state.rows.map(c => {
    const pct = c.records ? Math.round(Math.min(c.summarized_to, c.records) / c.records * 100) : 0
    return '<button type="button" class="row" role="option" aria-selected="' + (c.session === state.sel) + '" data-id="' + esc(c.session) + '">' + mark(c.harness) +
      '<span class="name">' + esc(c.name) + '</span><span class="meta"><span class="num">' + fmt(c.records) + ' 条</span><span>·</span><span>' + ago(c.updated_ms) + '</span>' +
      (c.summary_count ? '<span class="mini" title="摘要覆盖 ' + pct + '%"><i style="width:' + pct + '%"></i></span>' : '<span>暂无摘要</span>') + '</span></button>'
  }).join('') : '<div class="empty"><span>还没有对话记录。</span><button type="button" class="btn primary" id="goConnect">接入第一个工具</button></div>'
  $('#listCount').textContent = state.total + ' 个对话'
  $('#more').hidden = state.offset === null
  for (const b of $('#rows').querySelectorAll('.row')) b.onclick = () => select(b.dataset.id)
  const go = $('#goConnect'); if (go) go.onclick = () => show('connect')
}
$('#more').onclick = () => act(() => loadConversations(false), $('#more'))

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
    ...data.summaries.map(s => ({ c: s.conversation, where: '摘要 · 第 ' + (s.level + 1) + ' 层 · #' + s.first + '–' + s.last, text: s.summary.slice(0, 300), node: s })),
    ...data.events.map(e => ({ c: e.conversation, where: '原文 · #' + e.ordinal, text: e.snippet.replace(/^(user|assistant):\s*/, ''), ordinal: e.ordinal }))
  ]
  $('#rows').innerHTML =
    (data.conversations.length ? '<div class="group-label">对话</div>' + data.conversations.map(c => '<button type="button" class="row" data-id="' + esc(c.session) + '">' + mark(c.harness) + '<span class="name">' + hl(c.name) + '</span><span class="meta">#' + esc(c.code) + '</span></button>').join('') : '') +
    (hits.length ? '<div class="group-label">内容 · ' + hits.length + ' 处</div>' + hits.map((h, i) => '<button type="button" class="hit" data-i="' + i + '"><span class="where">' + esc(h.where) + ' · ' + esc(h.c.name) + '</span><span class="snip">' + hl(h.text) + '</span></button>').join('') : '') +
    (!data.conversations.length && !hits.length ? '<div class="empty">未找到「' + esc(query) + '」</div>' : '')
  $('#listCount').textContent = '搜索结果'
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
    lanes += '<span class="lane-label">第 ' + (level + 1) + ' 层</span><div class="lane">' + d.bands.filter(b => b.level === level).map(b =>
      '<button type="button" class="seg ' + (level > 3 ? 'lx' : 'l' + level) + '" data-node="' + esc(b.id) + '" title="第 ' + (level + 1) + ' 层 · #' + b.first + '–' + b.last + '" style="left:calc(' + pct(b.first, total) + ' + 1px);width:calc(' + pct(b.last - b.first + 1, total) + ' - 2px)"></button>').join('') + '</div>'
  }
  if (d.summary_count) lanes += '<span class="lane-label">第 1 层</span><div class="lane l0" style="--p:' + pct(d.summarized_to, total) + '"></div>'
  lanes += '<span class="lane-label">原文</span><div class="lane raw">' + (tail > 0 && d.summary_count ? '<span class="seg tail" style="left:' + pct(d.summarized_to, total) + ';right:0" title="最新 ' + tail + ' 条尚未摘要"></span>' : '') + '</div>'
  const note = d.summary_count ? '<div class="strip-note">' + (d.bands.length ? '<span><i class="k" style="background:var(--l3)"></i>层级越高越概括</span>' : '') + (tail > 0 ? '<span><i class="k" style="background:var(--tail)"></i>最新 ' + fmt(tail) + ' 条尚未摘要，原文可查</span>' : '') + '<span style="margin-left:auto">摘要生成：' + writerLabel(d.setting.mode) + '</span></div>' : ''
  return '<div><div class="section-h"><h2>摘要层级</h2>' + (d.bands.length ? '<span class="aside">点击色块定位到对应摘要</span>' : '') + '</div><div class="strip"><div class="lanes">' + lanes + '</div><div class="axis"><span>#0</span>' + (d.records > 2 ? '<span>#' + Math.round(d.records / 2) + '</span>' : '') + '<span>#' + Math.max(d.records - 1, 0) + '</span></div>' + note + '</div></div>'
}
function generateButtons(label) {
  return '<button type="button" class="btn small" data-generate="cli">' + label + 'Claude 订阅</button><button type="button" class="btn small" data-generate="codex-cli">' + label + 'Codex 订阅</button>'
}
function renderDetail() {
  const d = state.detail, c = d.source, tail = d.records - d.summarized_to
  let html = '<div class="detail-inner"><button type="button" class="btn small back" id="back">← 返回列表</button>' +
    '<div class="d-head"><div class="d-title"><h1 title="' + esc(c.name) + '">' + esc(c.name) + '</h1><div class="d-meta">' + mark(c.harness, 'sm') + '<span>' + esc(toolName(c.harness)) + '</span><span class="tag" title="对话编号，接续时使用">#' + esc(c.code) + '</span><span class="num">' + fmt(d.records) + ' 条原文</span><span>更新于 ' + ago(d.updated_ms) + '</span></div></div>' +
    '<div class="actions"><button type="button" class="btn" id="rename">重命名</button><button type="button" class="btn primary" id="continue">接续到其他工具</button></div></div>'
  html += stripHtml(d)
  if (d.summarizing) html += '<div class="notice calm"><span><b>正在生成摘要…</b>完成的部分会陆续出现在下方。</span></div>'
  else if (d.status === 'summary_error') html += '<div class="notice bad"><span><b>上次摘要生成失败。</b>请确认对应的 CLI 已登录，然后重试。</span><span class="actions">' + generateButtons('用 ') + '</span></div>'
  else if (d.summary_count && tail > 64 && d.setting.mode === 'agent') html += '<div class="notice"><span><b>摘要滞后 ' + fmt(tail) + ' 条。</b>对话内生成每轮只处理一段，跟不上新增内容。可以用订阅在后台补齐。</span><span class="actions">' + generateButtons('用 ') + '</span></div>'
  if (d.summary_count) {
    html += '<div><div class="section-h"><h2>摘要目录</h2><span class="aside"><button type="button" class="link" id="collapseAll">收起全部</button></span></div><div class="tree">' + d.nodes.map(nodeHtml).join('') +
      (tail > 0 ? '<div class="tail-row"><span>最新 <b class="num">' + fmt(tail) + '</b> 条（#' + d.summarized_to + '–#' + (d.records - 1) + '）尚未摘要</span><button type="button" class="btn small" data-raw="' + Math.max(d.summarized_to, d.records - 60) + '-' + (d.records - 1) + '">查看原文</button></div>' : '') + '</div></div>'
  } else {
    html += '<div class="notice calm"><span><b>此对话暂无摘要。</b>' + fmt(d.records) + ' 条原文已完整保存，AI 可按编号读取和搜索；接续时将提供最近的原文。' + (d.setting.mode === 'agent' ? '对话内生成只在该对话继续进行时才会写摘要。' : '') + '</span></div>' +
      '<div class="actions">' + (d.summarizing ? '' : generateButtons('用 ').replace(/btn small/g, 'btn')) + '<button type="button" class="btn" data-raw="' + Math.max(0, d.records - 60) + '-' + Math.max(d.records - 1, 0) + '">查看最近原文</button></div>'
  }
  $('#detail').innerHTML = html + '</div>'
  bindDetail()
}
function nodeHtml(n) {
  const open = state.open.has(n.id), kids = state.children.get(n.id)
  const inner = !open ? '' : n.level > 0
    ? '<div class="children">' + (kids ? kids.map(nodeHtml).join('') : '<div class="tail-row">读取中…</div>') + '</div>'
    : '<div class="raw-link"><button type="button" class="btn small" data-raw="' + n.first + '-' + n.last + '">查看 ' + (n.last - n.first + 1) + ' 条原文</button></div>'
  return '<div class="node" data-id="' + esc(n.id) + '" aria-expanded="' + open + '"><button type="button" class="node-h" data-toggle="' + esc(n.id) + '"><span class="caret"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5L7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></span>' +
    '<span class="lv l' + Math.min(n.level, 3) + '">第' + (n.level + 1) + '层</span><span class="node-text">' + esc(n.summary) + '</span><span class="range">#' + n.first + '–' + n.last + '</span></button>' + inner + '</div>'
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
  const collapse = $('#collapseAll'); if (collapse) collapse.onclick = () => { state.open.clear(); renderDetail() }
  for (const b of all('[data-toggle]')) b.onclick = () => act(async () => {
    const id = b.dataset.toggle, node = findNode(id)
    if (state.open.has(id)) state.open.delete(id)
    else { state.open.add(id); if (node?.level > 0) await ensureChildren(id) }
    renderDetail()
  })
  for (const b of all('[data-raw]')) b.onclick = () => { const [a, z] = b.dataset.raw.split('-').map(Number); openRaw(a, z) }
  for (const b of all('.seg[data-node]')) b.onclick = () => act(() => revealNode(d.bands.find(x => x.id === b.dataset.node), true))
  for (const b of all('[data-generate]')) b.onclick = () => act(async () => {
    const x = await api('/api/summarize', { session: state.sel, backend: b.dataset.generate })
    toast(x.running ? '已经在生成中' : '已开始在后台生成摘要')
    await loadDetail()
  }, b)
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
  if (m) return { who: m[1] === 'user' ? '用户' : 'AI', text: preview.slice(m[0].length) }
  if (/^(custom-title|ai-title):/.test(preview)) return { who: '标题', text: preview.replace(/^[a-z-]+:\s*/, ''), other: true }
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
    ? '<div class="ev other"><span class="o">#' + r.from + (r.to !== r.from ? '–' + r.to : '') + '</span><div class="body">' + r.n + ' 条工具调用或系统记录（完整内容可用 lcm_read 读取）</div></div>'
    : '<div class="ev' + (r.other ? ' other' : '') + (r.ordinal === focus ? ' focus' : '') + '" data-o="' + r.ordinal + '"><span class="o">#' + r.ordinal + '</span><div><div class="who">' + esc(r.who) + '</div><div class="body">' + esc(r.text) + '</div></div></div>').join('')
  const ref = '#' + d.source.code + ' 原文 ' + a + (z !== a ? '–' + z : '')
  overlay('<aside class="drawer" role="dialog" aria-label="原文"><div class="drawer-h"><div><h3>原文 · <span class="mono">#' + a + (z !== a ? '–' + z : '') + '</span></h3><div class="hint">' + esc(d.source.name) + ' · 与原始记录逐字一致</div></div><button type="button" class="x" data-close aria-label="关闭">×</button></div>' +
    '<div class="drawer-b">' + (body || '<div class="empty">这一段没有可显示的消息。</div>') + '</div><div class="drawer-f"><span>AI 通过 <span class="mono">lcm_read</span> 读取的内容与此一致</span><button type="button" class="btn small" id="copyRef">复制引用</button></div></aside>', root => {
    root.querySelector('#copyRef').onclick = event => copyText(ref, event.target, '复制引用')
    root.querySelector('.ev.focus')?.scrollIntoView({ block: 'center' })
  })
}

/* ---------- continue in another tool ---------- */
async function openContinue() {
  const d = state.detail, x = await api('/api/continue?session=' + q(state.sel))
  const tools = state.harnesses.filter(h => h.supported || h.detected)
  if (!state.target || !tools.some(h => h.harness === state.target)) state.target = (tools.find(h => h.configuration_matches && h.harness !== d.source.harness) || tools[0])?.harness
  const render = () => {
    const t = tools.find(h => h.harness === state.target), ready = t?.configuration_matches
    const quoted = "'" + x.line.replace(/'/g, "'\\''") + "'", cmd = { 'claude-code': 'claude ' + quoted, codex: 'codex ' + quoted }[state.target]
    overlay('<div class="modal" role="dialog" aria-labelledby="ctitle"><div class="card"><div class="card-h"><div><h3 id="ctitle">接续到其他工具</h3><p>在目标工具中新建对话，发送下方指令即可接续。原文完整保留，可随时查证。</p></div><button type="button" class="x" data-close aria-label="关闭">×</button></div><div class="card-b">' +
      '<div><div class="section-h"><h2>目标工具</h2></div><div class="targets">' + tools.map(h => '<button type="button" class="target" data-t="' + esc(h.harness) + '" aria-pressed="' + (h.harness === state.target) + '"><span class="t1">' + mark(h.harness, 'sm') + esc(toolName(h.harness)) + '</span><span class="t2">' + (h.configuration_matches ? '已接入' : h.supported ? '未接入' : '暂不支持自动接入') + (h.harness === d.source.harness ? ' · 当前来源' : '') + '</span></button>').join('') + '</div></div>' +
      (ready
        ? '<div><div class="section-h"><h2>在 ' + esc(toolName(state.target)) + ' 新对话中发送</h2></div><div class="say"><div class="say-h"><span>接续指令</span><button type="button" class="btn small" id="cp1">复制</button></div><div class="say-b">' + esc(x.line) + '</div></div></div>' +
          (cmd ? '<div class="say"><div class="say-h"><span>或在终端中启动</span><button type="button" class="btn small" id="cp2">复制</button></div><div class="say-b mono">' + esc(cmd) + '</div></div>' : '') +
          '<div><div class="section-h"><h2>目标对话将获得</h2></div><ul class="gets"><li>顶层摘要目录：已完成的工作与已定事项</li><li>最近的原文：衔接中断处的上下文</li><li>按编号读取任意原文：细节不因压缩失真</li></ul></div>' +
          '<details><summary>预览发送内容（' + fmt(x.packet.content.length) + ' 字）</summary><div class="packet">' + esc(x.packet.content) + '</div></details>'
        : '<div class="notice"><span><b>' + esc(toolName(state.target)) + (t?.supported ? ' 尚未接入。' : ' 暂不支持自动接入。') + '</b>' + (t?.supported ? '完成一次接入后，即可从任意工具接续到这里。' : '可以在它的 MCP 设置中手动添加 SuperLcm 后再接续。') + '</span></div>' +
          (t?.supported ? '<div class="actions"><button type="button" class="btn primary" id="goSetup">接入 ' + esc(toolName(state.target)) + '</button></div>' : '')) +
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
  overlay('<div class="modal" role="dialog" aria-labelledby="rtitle"><div class="card" style="width:min(440px,100%)"><div class="card-h"><h3 id="rtitle">重命名</h3><button type="button" class="x" data-close aria-label="关闭">×</button></div><form class="card-b" id="renameForm"><label class="field">对话名称<input id="newName" maxlength="160" value="' + esc(c.name) + '"></label><div class="actions"><button type="submit" class="btn primary">保存</button><button type="button" class="btn" data-close>取消</button></div></form></div></div>', root => {
    root.querySelector('#newName').select()
    root.querySelector('#renameForm').onsubmit = event => {
      event.preventDefault()
      const name = root.querySelector('#newName').value.trim()
      if (!name) return
      act(async () => { await api('/api/rename', { session: state.sel, name }); closeOverlay(); toast('已重命名'); await loadDetail(); await loadConversations() })
    }
  })
}
