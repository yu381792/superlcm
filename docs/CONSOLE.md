# Local console

`node src/cli.js web` serves the console at the fixed address `http://127.0.0.1:8791/` (pass another port as an argument if 8791 is taken; if the console is already running, the command says so). The server binds only to 127.0.0.1 and needs no login. It refuses requests whose Host header is not `127.0.0.1:<port>` (which stops DNS-rebinding pages), refuses cross-origin writes, accepts writes only as JSON (so a foreign web page cannot send them without a failing preflight), and serves a strict CSP. Web pages on other sites cannot read its responses. Any program running as your user on this computer can open it, the same as it can read the index files directly. Opening the page never calls a model.

## 对话 (Conversations)

The list shows every stored conversation, newest activity first, with its tool logo, record count, last update and summary coverage. Filter chips are built from the tools that actually have conversations. The search box (shortcut `/`) matches conversation names, `#codes`, summaries and original text (substring match, works for Chinese).

The detail view shows:

- **摘要层级** — one lane per summary level plus the raw-record lane. Higher-level segments are clickable and jump to that summary. The hatched tail is records not yet summarized; their originals are still readable.
- **摘要目录** — the top-level summaries (nodes not yet merged upward). Higher nodes expand into their children; first-level nodes open the original records.
- **原文 drawer** — the exact records for a range, with tool calls and system records collapsed. This is the same text `lcm_read` returns.
- **Notices** — when in-conversation summaries fall far behind, or a conversation has none, buttons start a one-off background pass (`POST /api/summarize`, which spawns `cli.js summarize … --backend`). Only methods this computer can run are shown: the Claude or Codex subscription when that CLI is installed, and the custom API when one is saved in Settings. With none available, the notice links to Settings. The view polls while a pass holds the summary lease.
- **接续到其他工具** — pick a target tool and copy the one-line handoff (or a terminal command). The packet preview shows exactly what `lcm_continue` returns.
- **重命名** — a manual name that later hook updates do not overwrite.

## 接入 (Connect)

One card per detected tool. The status comes from real evidence: configuration match, then whether a SuperLcm MCP process loaded, then whether the AI has actually called a tool. **接入** opens a dialog that previews the files it will change, applies only after confirmation (official CLI registration + hook merge, with private backups), reads the config back, and runs a load check. Claude is checked by an ephemeral `claude` process that reports `mcp_status` without any prompt; Codex by a protocol and hook self-test. Codex still needs its native `/hooks` trust review.

Tools without automatic capture (Hermes, Pi) and past conversations of any supported tool can be imported from **导入本机的历史对话**; only the selected conversation is read, and no model is called.

## 设置 (Settings)

- **摘要生成方式** — 对话内生成 (the conversation's own AI, via `lcm_summary_task`/`lcm_summary_submit`), Claude 订阅, Codex 订阅, 自定义 API, or 关闭. CLI modes list models from the installed CLI's own catalog. API keys are write-only and stored outside SQLite.
- **摘要粒度** — first-level segment size (6k / 12k / 24k characters), maximum messages per segment (16 / 32 / 64), and merge width (3 / 4 / 6). Changes apply to new summaries only.
- **按工具设置** — per-tool overrides of the default writer.
- Language: follows the browser (Chinese for `zh*`, otherwise English) unless set here. To add a language, add a table to `src/web-i18n.js` keyed by the Chinese source strings and an option to the language menu.
- Palette (陶橙 default, 松石, 靛青, 石墨) and light/dark follow-system are stored per browser.

## How summaries grow

The planner always merges before it summarizes new text: whenever a level has at least `fanout` adjacent nodes not yet owned by a parent, the next task is to merge them. Otherwise it closes the next first-level segment once it reaches the message or character target. Each task is verified against the original byte ranges before and after the model call, so a changed source fails closed.

## Tests

    npm test
    python3 scripts/test-ui.py

`npm test` is offline (temporary indexes, fake providers, real hook subprocesses). `scripts/test-ui.py` drives the real console in headless Chrome through Playwright against a temporary fixture index, checks every view at desktop and phone width, and confirms the user's real CLI config files are unchanged.
