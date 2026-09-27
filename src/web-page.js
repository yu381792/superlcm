import { readFileSync } from 'node:fs'
import { icons } from './web-icons.js'
const asset = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const logo = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="3" width="16" height="3" rx="1.5" fill="var(--l3)"/><rect x="2" y="8.5" width="11" height="3" rx="1.5" fill="var(--l2)"/><rect x="2" y="14" width="6" height="3" rx="1.5" fill="var(--l1)"/></svg>'
const swatches = [['orange', '陶橙', '#C96442'], ['teal', '松石', '#1E6B57'], ['indigo', '靛青', '#3A4FB0'], ['graphite', '石墨', '#2E2E2C']]

export function page(nonce) {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SuperLcm</title>
<style>${asset('web-style.css')}</style>
</head>
<body>
<div class="app">
  <header class="top">
    <a class="brand" href="#conversations" id="brand" title="返回对话列表">${logo}SuperLcm</a>
    <nav class="nav" aria-label="主菜单">
      <button type="button" data-view="conversations">对话</button>
      <button type="button" data-view="connect">接入</button>
      <button type="button" data-view="settings">设置</button>
    </nav>
    <div class="spacer"></div>
    <div class="swatches" role="group" aria-label="配色">${swatches.map(([id, name, color]) => `<button type="button" class="sw" data-pal="${id}" title="${name}" style="background:${color}"></button>`).join('')}</div>
    <button type="button" class="pill" id="statusPill"><span class="dot" id="statusDot"></span><span id="statusText">检测中…</span></button>
  </header>
  <p class="banner" id="error" role="alert" hidden><span id="errorText"></span><button type="button" class="link" id="errorClose">关闭</button></p>

  <section class="view" id="view-conversations">
    <div class="conv" id="conv">
      <aside class="list">
        <div class="list-head">
          <label class="search"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><input id="q" type="search" placeholder="搜索对话、摘要与原文" autocomplete="off" aria-label="搜索"><kbd>/</kbd></label>
          <div class="chips" id="chips"></div>
        </div>
        <div class="rows" id="rows" role="listbox" aria-label="对话列表"></div>
        <div class="list-foot"><span id="listCount"></span><button type="button" class="link" id="more" hidden>加载更多</button></div>
      </aside>
      <main class="detail" id="detail"></main>
    </div>
  </section>

  <section class="view page" id="view-connect" hidden>
    <div class="page-inner">
      <div class="page-h"><h1>接入</h1><p>接入后，该工具的对话会自动存入 SuperLcm，其中的 AI 也可查阅全部已存对话。</p></div>
      <div class="tools" id="tools"></div>
      <p class="page-note">导入：接入之前的对话，或暂不支持自动接入的工具（如 Hermes、Pi），可以从本机记录中挑选导入。只读取你选中的对话，不会调用模型。</p>
    </div>
  </section>

  <section class="view page" id="view-settings" hidden>
    <div class="page-inner">
      <div class="page-h"><h1>设置</h1></div>
      <div class="set-layout">
        <nav class="set-nav" id="setNav" aria-label="设置分类"><button type="button" data-sec="look" aria-current="true">外观</button><button type="button" data-sec="storage">存储</button><button type="button" data-sec="summary">摘要</button><button type="button" data-sec="mcp">MCP 工具</button></nav>
        <div class="set-body">
      <div class="panel" data-sec="look">
        <h2>外观</h2>
        <div class="fields">
          <label class="field">配色<select id="palSel">${swatches.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label>
          <label class="field">明暗<select id="themeSel"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <label class="field">语言<select id="langSel"><option value="auto">跟随浏览器</option><option value="zh">中文</option><option value="en">English</option></select></label>
        </div>
      </div>
      <div class="panel" data-sec="storage" hidden>
        <h2>存储</h2>
        <p class="desc">所有对话、原文存档和摘要都只存在这台电脑上的这个目录里。</p>
        <div class="fields"><label class="field">数据位置<input id="dataDir" readonly></label></div>
        <div class="stat-row" id="storeStats"></div>
        <h3>清理旧对话</h3>
        <p class="desc">按最后更新时间批量删除。只删除 SuperLcm 里的原文存档和摘要，各工具里的原始对话不受影响。</p>
        <div class="fields">
          <label class="field">工具<select id="cleanTool"></select></label>
          <label class="field">最后更新早于<select id="cleanAge"><option value="30">30 天前</option><option value="90" selected>90 天前</option><option value="180">半年前</option><option value="365">一年前</option></select></label>
        </div>
        <div class="notice calm"><span id="cleanPreview"></span></div>
        <div class="actions"><button type="button" class="btn danger" id="cleanGo" disabled>删除这些对话</button></div>
      </div>
      <div class="panel" data-sec="summary" hidden>
        <h2>摘要（全局默认）</h2>
        <p class="desc">所有工具默认按这里生成摘要；某个工具想用别的方式，到「接入」页它的卡片上单独改。摘要仅用于导航，原文始终完整保存。</p>
        <h3>生成方式</h3>
        <p class="desc">「对话模型生成」由当前对话的 AI 顺带完成，它读到的内容大多已在缓存中，费用最低；其他方式会在后台自动补齐。</p>
        <div class="seg-ctl" id="writer"></div>
        <div class="fields" id="writerFields"></div>
        <h3>粒度</h3>
        <p class="desc">只影响之后新生成的摘要，已有摘要保持不变。</p>
        <div class="fields">
          <label class="field">第 1 层每段原文<select id="segSize"><option value="6000">约 6,000 字 · 更细</option><option value="12000">约 12,000 字 · 推荐</option><option value="24000">约 24,000 字 · 更省</option></select></label>
          <label class="field">单段最多消息数<select id="segMsgs"><option value="16">16 条</option><option value="32">32 条 · 推荐</option><option value="64">64 条</option></select></label>
          <label class="field">合并方式<select id="fanout"><option value="3">每 3 段合并为上一层</option><option value="4">每 4 段合并为上一层 · 推荐</option><option value="6">每 6 段合并为上一层</option></select></label>
        </div>
        <div class="notice calm"><span id="granEst"></span></div>
        <div class="actions"><button type="button" class="btn primary" id="saveWriter">保存</button><span class="saved" id="writerSaved" aria-live="polite"></span></div>
      </div>
      <div class="panel" data-sec="mcp" hidden>
        <h2>AI 可用的 MCP 工具</h2>
        <p class="desc">接入后，对话中的 AI 可调用以下工具。接入、导入、重命名等管理操作仅在控制台和命令行中进行。</p>
        <div class="toolref">
          <div><code>lcm_continue</code><span>接续另一个对话：获取其顶层摘要与最近原文。</span></div>
          <div><code>lcm_find</code><span>按名称、编号或关键词查找对话，并在摘要与原文中全文搜索。</span></div>
          <div><code>lcm_outline</code><span>逐层展开摘要目录。</span></div>
          <div><code>lcm_read</code><span>按编号读取原文，与原始记录逐字一致。</span></div>
          <div><code>lcm_summary_task</code><span>领取待摘要的原文（仅「对话模型生成」模式可用）。</span></div>
          <div><code>lcm_summary_submit</code><span>提交摘要，服务器校验原文后保存（同上）。</span></div>
        </div>
      </div>
        </div>
      </div>
    </div>
  </section>
</div>
<div id="overlay"></div>
<div id="toast" class="toast" role="status" hidden></div>
<script nonce="${nonce}">
const ICONS = ${JSON.stringify(icons)};
${asset('web-i18n.js')}
${asset('web-client.js')}
${asset('web-admin.js')}
boot();
</script>
</body>
</html>`
}
