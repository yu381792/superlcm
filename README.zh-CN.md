<h1 align="center">SuperLcm</h1>

<p align="center"><b>永久上下文，把上下文变成档案馆。</b></p>

<p align="center"><a href="README.md">English</a> · <b>中文</b></p>

你和 AI 说过的每一句话，一字不差地存在你自己的电脑上。摘要像一本书的章节那样一层层归档，任何细节都能原样调出来引用，哪怕上下文早就被压缩过好几轮。Claude Code、Codex、Hermes、Pi 共用同一座档案馆，在一个工具里开的头，可以到另一个工具里接着干。

## 普通压缩把原文扔掉，SuperLcm 把原文归档

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/compare-zh-dark.gif"><img src="docs/images/compare-zh-light.gif" alt="动画：普通压缩把 18 条消息挤成越来越短的摘要，端口号丢了；SuperLcm 把每条消息完整存档，建起 L1、L2 摘要卡，并把第 005 条原文一字不差地读回来。"></picture>

两边是同样的 18 条消息，上下文窗口都只装得下 6 条。普通压缩每次都把所有内容挤成一段更短的摘要，原文就此没了。SuperLcm 把每一组消息完整存档，写一张摘要卡指回原文，卡片再装订成上一层。很多轮之后问“控制台端口定的是多少”，AI 用 `lcm_find` 找、`lcm_outline` 翻目录、`lcm_read` 读原文，一路查下去把原话引出来。

## 把整段对话连同摘要，整个搬进另一个工具

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/handoff-zh-dark.gif"><img src="docs/images/handoff-zh-light.gif" alt="动画：Claude Code 用量到了上限；到 Codex 里一句话接续对话 #6e94e，lcm_continue 带来目录和最近几条原文，lcm_read 再从共用的档案馆读出更早的一条。"></picture>

- **停在哪，就从哪接着干。** 额度用完、被限速，或者想让另一个模型看看，到另一个工具里说一句 `通过 SuperLcm 接续对话 #6e94e`，任务就接着往下走。
- **不用复述，不用整段粘贴。** `lcm_continue` 交过去的是分层目录加最近几条原文，新的 AI 一开局上下文就小而准，不是把整份聊天记录硬塞进去。
- **每个细节随时一查就有。** 整段对话都在档案馆里。早先的某个决定要紧时，新的 AI 用 `lcm_read` 按编号把那条原文一字不差地读出来。
- **任意方向，来回都行。** Claude Code、Codex、Hermes、Pi 读写的是同一座档案馆，接着干的内容也会存进去，以后可以用同样的办法再交还回去。

## 怎么做到的

**每一轮对话，说完就存。** 你的消息、AI 的回复和它调用的工具，每一轮结束后都从工具自己的对话记录里逐字节抄进本机数据库，并用 SHA-256 校验。每条记录都有编号，以后能像账本页码一样被引用。不上传任何地方，整个档案馆就是你用户目录里的一个 SQLite 文件。

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/fig1-zh-dark.png"><img src="docs/images/fig1-zh-light.png" alt="记录落进档案馆的样子（示例），编号 #1841 到 #1845" width="560"></picture>

**摘要分层，每一层都指回原文页码。** 一段消息（约 12,000 字，可调）写成一条短摘要，每 4 条相邻摘要再合成上一层。树顶读起来就像整段对话的目录，每一条都带着它来自哪些记录的编号。摘要只是路标，不是替代品。

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/fig2-zh-dark.png"><img src="docs/images/fig2-zh-light.png" alt="摘要树：一个 L2 卷，下面三个 L1 章，再下面是原始记录" width="560"></picture>

**AI 先读原文，再回答。** 每次压缩之后，AI 会收到一句提醒，告诉它完整记录存在哪。它的查档工具能搜摘要和原文（中英文都行）、翻目录、按编号读原文，读出来的内容会和原始对话文件核对。

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/fig3-zh-dark.png"><img src="docs/images/fig3-zh-light.png" alt="压缩后 AI 看到的提醒，以及随后 lcm_find、lcm_read 读回第 #1842 条" width="560"></picture>

## 四个工具，一座档案馆

| 工具 | 怎么接入 |
|---|---|
| Claude Code | 装 Claude 插件（见下），或在控制台接入 |
| Codex | 控制台一键接入：钩子和 MCP 工具写进 Codex 自己的配置 |
| Hermes | 控制台一键接入，通过 Hermes 自己的配置代码写入 |
| Pi | 控制台一键接入：一个扩展文件，同样的查档工具和逐轮记录 |

## 摘要谁来写

在控制台里按工具分别选：**对话里的 AI 自己写**（默认，它刚经历过这段，凭记忆就能写）、**本工具后台写**（单独起一次该工具的命令行，用你已经配好的账号和模型）、**自定义 API**（任何兼容 Anthropic 或 OpenAI 的地址，包括你电脑上自己跑的网关），或者**关闭**（照样全部存下、能搜）。

## 压缩 vs 档案馆

| | 普通压缩 | SuperLcm |
|---|---|---|
| 原话 | 压缩后 AI 就够不着了 | 完整保存，按编号随时读 |
| 摘要形态 | 一段扁平摘要，每压一次更短 | 像书一样分层，每层指回页码 |
| 300 轮前的一个细节 | 摘要碰巧留下了才有 | 搜得到，原样引用 |
| 换个工具接着干 | 从头再讲一遍 | 一句话，带着目录和最近原文 |
| 存在哪 | — | 你电脑上的一个文件 |

## 安装成 Claude 插件

在 Claude Code 里：

    /plugin marketplace add yu381792/superlcm
    /plugin install superlcm@superlcm

插件自带 Claude Code 的逐轮记录和查档工具；`/superlcm:console` 打开控制台，在那里把 Codex、Hermes、Pi 接进同一座档案馆。能用的地方是 Claude 能启动本机程序的地方：Claude Code，以及在你自己电脑上运行的 Cowork；claude.ai 网页版和手机聊天用不了。需要 PATH 里有 Node.js 22.16 或更新版本；如果默认的 `node` 太旧，而电脑上装有更新的版本，会自动换用新的。

插件更新会替换插件文件夹，所以从插件控制台接入的其他工具会连到 SuperLcm 文件夹里一个固定的入口文件（`~/.superlcm-claude/superlcm.js`），它会跟着插件更新走。如果之前已经从控制台接入过 Claude Code，启用插件后设置里的旧钩子会自动静默；再用 `claude mcp remove superlcm -s user` 删掉旧的 `superlcm` MCP 条目，工具就不会列两遍。

## 从源码运行

    node src/cli.js web

打开 `http://127.0.0.1:8791/`（不用登录，只在本机监听），在“接入”页选工具并确认即可。更多说明见英文文档：[安装、安全与限制](docs/SETUP.md) · [控制台说明](docs/CONSOLE.md)。

## 许可

[AGPL-3.0](LICENSE)。Claude、Claude Code、Codex、Hermes、Pi 的名称和标志归各自所有者，这里只用来说明兼容的工具；SuperLcm 是独立项目，与它们没有隶属或背书关系。
