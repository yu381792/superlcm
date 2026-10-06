import { readFileSync } from 'node:fs'
import { icons } from './web-icons.js'
import { dshRuntimeState,dshGlobalState } from './dsh-live-state.js'
const asset = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const logo = asset('../dsh/ui/icon.svg').trim().replace('<svg ', '<svg width="20" height="20" aria-hidden="true" ').replace('#B5532F', 'var(--l3)').replace('#CF7A56', 'var(--l2)').replace('#E6AE93', 'var(--l1)')
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
      <button type="button" data-view="compression">压缩</button>
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
      <p class="page-note">导入：接入之前的旧对话，可以从本机记录中挑选导入。只读取你选中的对话，不会调用模型。</p>
    </div>
  </section>

  <section class="view page" id="view-compression" hidden>
    <div class="page-inner compression-inner">
      <div class="page-h"><h1>压缩</h1><p>分别管理 Claude 和 DSH 的压缩方式。后台摘要在接入页面设置。</p></div>
      <div class="compression-tabs" role="tablist" aria-label="压缩工具">
        <button type="button" id="compression-tab-claude" role="tab" data-compression-tool="claude-code" aria-controls="compression-claude-code" aria-selected="true">Claude Code</button>
        <button type="button" id="compression-tab-dsh" role="tab" data-compression-tool="dsh" aria-controls="compression-dsh" aria-selected="false">dsh harness</button>
      </div>
      <section class="compression-card" id="compression-claude-code" data-compression="claude-code" role="tabpanel" aria-labelledby="compression-tab-claude">
        <div class="compression-card-head"><div><span class="eyebrow">Claude Code</span><h2>Claude 压缩</h2></div><span class="state" id="claudeCompressionOwner">正在读取…</span></div>
        <p class="desc">Claude Code 的对话太长时会压缩。交给 SuperLcm 后，旧的部分换成后台写好的摘要，最近几轮原样留下，原文随时能用 lcm_read 调回。</p>
        <label class="toggle-row"><span><b>由 SuperLcm 接管压缩</b><span>到门槛时直接换上现成的摘要，不调用模型，几乎不用等</span></span><span class="switch"><input type="checkbox" id="takeoverOn" role="switch"><i></i></span></label>
        <h3>压缩门槛</h3>
        <p class="desc">上下文到这个大小，SuperLcm 换上摘要；模型窗口放不下时自动调低。</p>
        <div class="choice" id="takeoverWindow" role="radiogroup" aria-label="压缩门槛"><button type="button" role="radio" data-w="200000">200K</button><button type="button" role="radio" data-w="300000">300K<small>推荐</small></button><button type="button" role="radio" data-w="500000">500K</button><button type="button" role="radio" data-w="800000">800K</button><button type="button" role="radio" data-custom>自定义<small></small></button></div>
        <div class="custom-size" id="takeoverWindowCustom" hidden><input type="number" inputmode="numeric" min="100" max="950" step="10" aria-label="自定义压缩门槛"><span>K</span><button type="button" class="btn small">保存</button><span class="hint">100K–950K</span></div>
        <h3>最近原文保留</h3>
        <p class="desc">替换时最近这么多内容一字不改地留下，接着干活不丢细节；更早的才换成摘要。最多保留当前上下文的一半。</p>
        <div class="choice" id="takeoverKeep" role="radiogroup" aria-label="最近原文保留"><button type="button" role="radio" data-k="20000">20K</button><button type="button" role="radio" data-k="40000">40K<small>推荐</small></button><button type="button" role="radio" data-k="80000">80K</button><button type="button" role="radio" data-custom>自定义<small></small></button></div>
        <div class="custom-size" id="takeoverKeepCustom" hidden><input type="number" inputmode="numeric" min="5" max="200" step="5" aria-label="自定义最近原文保留"><span>K</span><button type="button" class="btn small">保存</button><span class="hint">5K–200K</span></div>
        <h3>运行条件</h3>
        <ul class="checks" id="takeoverChecks"></ul>
        <details class="how"><summary>它怎么工作</summary><p>SuperLcm 平时就在后台把对话写成分层摘要，但不动 Claude Code 的上下文。到了门槛，Claude Code 要压缩时，SuperLcm 把已经被摘要覆盖的旧对话换成这些摘要，没覆盖到的部分和最近一段（按「最近原文保留」，至少两轮）一字不改地保留。</p><p>摘要还没跟上、对不上号、换完仍然太大，或者是子代理的对话，都照旧交给 Claude Code 自己压缩，对话不会因此卡住。打开时会改 Claude Code 的设置，让它正好在门槛开始压缩，由 SuperLcm 当场换上摘要；它显示的窗口是门槛再加 100K（最多 1M）。关闭时恢复原来的设置。</p></details>
      </section>
      <section class="compression-card" id="compression-dsh" data-compression="dsh" role="tabpanel" aria-labelledby="compression-tab-dsh" hidden>
        <div class="compression-card-head"><div><span class="eyebrow">dsh harness</span><h2>DSH 压缩</h2></div><span class="state" id="dshCompressionOwner">正在读取…</span></div>
        <p class="desc">可选择由 SuperLcm 接管。关闭接管时，DSH 使用原生压缩，后台摘要和归档继续独立运行。</p>
        <div id="dshCompressionSettings"><p class="muted">正在读取压缩设置…</p></div>
      </section>
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
        <h2>摘要</h2>
        <p class="desc">每个工具用哪种方式写摘要，在「接入」页它的卡片上选：「对话模型生成」由正在聊天的 AI 顺手写，几乎不多花钱；「本工具后台写」和「自定义 API」在后台单独调用模型，不占用主对话。摘要仅用于导航，原文始终完整保存。</p>
        <h3>自定义 API 模型</h3>
        <p class="desc">在这里添加模型，之后在「接入」页任意工具的卡片上选「自定义 API」就能挑它来写摘要。改了这里，用它的工具一起生效。密钥只存在这台电脑上。</p>
        <div id="apiModels"></div>
        <h3>粒度</h3>
        <p class="desc">只影响之后新生成的摘要，已有摘要保持不变。</p>
        <div class="fields">
          <label class="field">第 1 层每段原文<select id="segSize"><option value="10000">约 10,000 token · 更细</option><option value="20000">约 20,000 token · 推荐</option><option value="40000">约 40,000 token · 更省</option></select></label>
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
          <div><code>lcm_summary_task</code><span>领取下一段待写的摘要（仅「对话模型生成」模式可用）。</span></div>
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
${dshRuntimeState.toString()}
${dshGlobalState.toString()}
${asset('web-compression.js')}
${asset('web-admin.js')}
${asset('web-dsh-controls.js')}
${asset('web-dsh.js')}
boot();
</script>
</body>
</html>`
}
