# Local console

`node src/cli.js web` serves the console at the fixed address `http://127.0.0.1:8791/` (pass another port as an argument if 8791 is taken; if the console is already running, the command says so). The server binds only to 127.0.0.1 and needs no login. It refuses requests whose Host header is not `127.0.0.1:<port>` (which stops DNS-rebinding pages), refuses cross-origin writes, accepts writes only as JSON (so a foreign web page cannot send them without a failing preflight), and serves a strict CSP. Web pages on other sites cannot read its responses. Any program running as your user on this computer can open it, the same as it can read the index files directly. Opening the page never calls a model.

## 对话 (Conversations)

The list shows every stored conversation, newest activity first, with its tool logo, record count, last update and summary coverage. Filter chips are built from the tools that actually have conversations. The search box (shortcut `/`) matches conversation names, `#codes`, summaries and original text (substring match, works for Chinese).

The detail view shows:

- **摘要层级** — one lane per summary level plus the raw-record lane. Higher-level segments are clickable and jump to that summary. The hatched tail is records not yet summarized; their originals are still readable.
- **摘要目录** — the top-level summaries (nodes not yet merged upward). Higher nodes expand into their children; first-level nodes open the original records.
- **原文 drawer** — the exact records for a range, with tool calls and system records collapsed. This is the same text `lcm_read` returns.
- **生成摘要 / 补齐摘要** — when a conversation has no summary, in-conversation summaries fall far behind, or the last pass failed, one button opens a confirmation dialog. The lag notice counts pending model calls (new segments plus merges), not records, since most records are tool calls with no text. It says how many records will be summarized and about how many model calls that takes (a dry run of the planner), and lists only the methods this computer can run, each saying whose quota or bill it uses: the conversation's own tool in the background (for example “Codex 后台写”, using the account and model configured in Codex), or the custom API saved in Settings. Nothing starts until **开始生成**, which calls `POST /api/summarize` to spawn `cli.js summarize … --backend`. With no method available the notice links to Settings; when the unsummarized part is shorter than one segment, no button is shown. The view polls while a pass holds the summary lease.
- **换个工具继续** — pick a target tool and copy the one-line handoff (or a terminal command). The packet preview shows exactly what `lcm_continue` returns.
- **重命名** — a manual name that later hook updates do not overwrite.
- **删除** — the trash button on a list row (on hover) or in the detail header asks for confirmation, then removes that conversation's records, summaries and SuperLcm's archived copy. The tool's own transcript is untouched. A deleted conversation is remembered, so hooks do not capture it again if it continues; importing it again from 接入 revives it.

## 接入 (Connect)

A two-column grid of tool cards (one column on phones). Each card shows a status badge, a plain status line, how many conversations are stored, the per-tool summary writer, and its actions (接入 / 检查接入, 导入历史对话). The status comes from real evidence: configuration match, then whether a SuperLcm MCP process loaded, then whether the AI has actually called a tool. **接入** opens a dialog that previews the files it will change, applies only after confirmation (official CLI registration + hook merge, with private backups), reads the config back, and runs a load check. Claude is checked by an ephemeral `claude` process that reports `mcp_status` without any prompt; Codex by a protocol and hook self-test plus a read-only hook-trust query (`codex app-server` `hooks/list`); Hermes by `hermes mcp test superlcm` plus its hook allowlist; Pi by an offline RPC run that loads only the SuperLcm extension and lists its `lcm_` tools (no model call). Codex and Hermes require new hooks to be approved. The dialog has a checkbox (on by default) that approves only SuperLcm's own hooks through each tool's official route: Codex's app-server `config/batchWrite` records each hook's `currentHash` as `hooks.state.<key>.trusted_hash` (the same entry Codex's `/hooks` review writes), and Hermes' own `agent.shell_hooks._record_approval` adds the documented allowlist entry. If the box is unchecked or approval fails, the dialog offers **打开 Codex/Hermes 确认**, which opens the tool in a terminal window so its own approval prompt appears, and **重新检查**. Each card also has a **摘要生成** picker that overrides the default summary writer for that tool (default: 默认（对话模型生成）). When the tool uses 本工具后台写, a second picker chooses the model from that tool's own list (跟随当前模型 by default, or 其他模型… to type an ID).

Past conversations of any supported tool can be imported from **导入历史对话**; only the selected conversation is read, and no model is called. Hermes lists one entry per compression chain and hides delegated subagent sessions.

## 设置 (Settings)

**存储** shows the data folder, counts and sizes, and **清理旧对话**: pick a tool and a last-activity cutoff (30 / 90 / 180 / 365 days), preview the matching conversations, then confirm to delete them. The server re-checks that the matching set has not changed since the preview.

A side list (a scrolling row on phones) shows one section at a time, in the order 外观, 存储, 摘要, MCP 工具. 摘要 holds the global default: method, model and granularity, saved together with one button. Clicking the SuperLcm logo in the top-left always returns to the conversation list.

- **摘要生成方式** — 对话模型生成 (the default: the conversation's own AI, via `lcm_summary_task`/`lcm_summary_submit`), 本工具后台写 (a separate background run of the conversation's own tool, with the model it is configured with; pick another model per tool on the 接入 cards), 自定义 API (SuperLcm calls the endpoint directly), or 关闭. API keys are write-only and stored outside SQLite.
- **摘要粒度** — first-level segment size (6k / 12k / 24k characters of dialogue) and merge width (3 / 4 / 6). Segments are sized by characters only: each record is sent whole, a segment closes before the record that would pass the target, and a single record longer than a whole segment forms its own segment with its head and tail kept (the middle is marked, and `lcm_read` returns it in full). Tool calls with no text do not count. A hidden cap of 200 messages per segment only guards extreme cases. Changes apply to new summaries only.
- Language: follows the browser (Chinese for `zh*`, otherwise English) unless set here. To add a language, add a table to `src/web-i18n.js` keyed by the Chinese source strings and an option to the language menu.
- Palette (陶橙 default, 松石, 靛青, 石墨) and light/dark follow-system are stored per browser.

## How summaries grow

The planner always merges before it summarizes new text: whenever a level has at least `fanout` adjacent nodes not yet owned by a parent, the next task is to merge them. Otherwise it closes the next first-level segment once the next record would push it past the character target. Each task is verified against the original byte ranges before and after the model call, so a changed source fails closed.

## Tests

    npm test
    python3 scripts/test-ui.py

`npm test` is offline (temporary indexes, fake providers, real hook subprocesses). `scripts/test-ui.py` drives the real console in headless Chrome through Playwright against a temporary fixture index, checks every view at desktop and phone width, and confirms the user's real CLI config files are unchanged.
