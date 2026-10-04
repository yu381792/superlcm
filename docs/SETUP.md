# SuperLcm setup and reference (preview)

SuperLcm is a shared local archive with adapters for Claude Code, Codex, Hermes, Pi and DSH. Claude Code supports plugin compaction takeover; SuperLcm also takes over DSH compaction through its plugin, with models and retention configured in the same console. The current Codex, Hermes and Pi adapters provide summaries and recall only. Configuration changes require the reviewed Web installer or explicit `setup --apply`; startup does not install integrations. For DSH's portable installer and downloadable package, see [DSH setup](DSH.md) and [distribution](RELEASE.md).

## Requirements and data ownership

- Node.js 22.16+ (`node:sqlite`), local stdio MCP, no additional runtime dependencies or always-on service.
- Claude Code CLI sessions: original source is Claude Code's local JSONL under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`). Hook `transcript_path` may lag behind the current in-memory turn; indexing waits for complete JSONL lines. The index never modifies the transcript.
- Ordinary Claude Desktop chat: MCP does **not** expose the whole chat transcript. You must explicitly export a conversation to a `.jsonl` or UTF-8 `.txt` file and import it. A `.txt` file is copied byte-for-byte and each line (including newlines) is indexed as an exact source event; no claim is made that a partial export contains every chat message. Claude Code sessions inside the Desktop application follow the Code path only when their hooks and transcript are accessible.
- The shared local index defaults to `~/.superlcm-claude/lcm.sqlite` (override with `SUPERLCM_HOME`; the old `SUPERLCM_CLAUDE_HOME` still works). Point all local MCP clients at the **same** home. Every indexed record is also copied byte for byte into `originals/` under that home, as a prefix of the host transcript, so the event offsets address both. Reads use this private copy first and fall back to the host transcript; both are checked against the stored SHA-256, and a mismatch is refused. The copy is filled as hooks index new records; `node src/cli.js archive` fills it for existing conversations and finds Codex transcripts that were moved into `archived_sessions/`. Disk use is roughly the size of the indexed transcripts. Files are created with private permissions.
- Indexed text and summaries can contain secrets. Keep the index local and restrict filesystem backups and permissions. In `cli` mode (本工具后台写), bounded excerpts go to a separate background run of the conversation's own tool, which sends them wherever that tool is configured to (its login, subscription or API provider, and its billing). `api` mode sends them to the explicitly selected HTTPS endpoint and incurs separate API billing. Neither mode asks the main agent to write summaries.

## Simple installation and local detection

Run `node src/cli.js web`, then open **接入** and click **接入** on the detected tool. Review and confirm the shown files. The installer backs up configuration and preserves unrelated entries. With the dialog's approval box checked (the default) it also approves SuperLcm's own hooks in Codex and Hermes; otherwise Codex still requires its `/hooks` review. Terminal alternatives:

    node src/cli.js doctor-local
    node src/cli.js setup codex
    node src/cli.js setup codex --apply
    node src/cli.js setup claude-code --apply

Hermes (`HERMES_HOME`, default `~/.hermes`) and Pi (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) are supported too. See [capabilities and test contract](CONSOLE.md).

**Hermes.** Setup edits `config.yaml` only through Hermes' own Python (`load_config` / `save_config` / `_save_mcp_server`, run with the interpreter of the installed `hermes` launcher), adding the `superlcm` MCP server (with `SUPERLCM_CLIENT=hermes`, since Hermes' MCP client sends no name) and `on_session_end` / `on_session_finalize` shell hooks that run `cli.js hermes-hook`. Hermes asks once whether to allow new hooks. If the 接入 dialog's approval box is checked, SuperLcm records that approval for its own hook command only, through Hermes' `agent.shell_hooks._record_approval` (the documented `shell-hooks-allowlist.json`); otherwise start Hermes once and approve there. Hermes stores messages in `state.db` and may rewrite them, so each hook appends every new message row (tool and inactive rows included) to SuperLcm's own JSONL copy under `SUPERLCM_HOME/hermes/` and indexes that copy as `hermes-<root id>`. A compression continuation (parent ended by compression, child not branched, delegated or reset) joins the same conversation; branches and subagents do not.

**Pi.** Setup writes one auto-discovered file, `extensions/superlcm.ts`, and refuses if a file of that name that SuperLcm did not write already exists. The extension reports `session_start`, `turn_end`, `agent_settled`, `session_compact` and `session_shutdown` to `cli.js pi-hook`, which indexes the append-only session file byte for byte (all branches), and registers the SuperLcm MCP tools as Pi tools; `/superlcm-status` lists them. Open Pi sessions pick it up after `/reload`.

**Which node launches SuperLcm.** Setup writes the path of a Node.js 22.16+ that no AI tool ships inside its own folder (it checks the node running the console, then `/usr/local/bin/node`, `/opt/homebrew/bin/node` and `PATH`), so updating Hermes, which bundles a node under `~/.hermes/node`, cannot remove it. If only a tool-bundled node exists, the card says so. Connecting again replaces SuperLcm's own older MCP entry and hooks in place (never duplicates them); Codex and Hermes then need the changed hooks approved again, which the dialog's approval box does.

Conversations imported earlier as one-off snapshots stay as separate entries.

## Local Web control console (opt-in)

Run `node /ABSOLUTE_PATH_TO_REPO/src/cli.js web` and open `http://127.0.0.1:8791/` (or pass another port). The server binds only to 127.0.0.1 and needs no login. It refuses requests whose Host header is not `127.0.0.1:<port>` (which stops DNS-rebinding pages), refuses cross-origin writes, accepts writes only as JSON (so a foreign web page cannot send them without a failing preflight), and serves a strict CSP. Web pages on other sites cannot read its responses. Any program running as your user on this computer can open it, the same as it can read the index files directly. Opening the page never calls a model. See [CONSOLE.md](CONSOLE.md) for what each view does.

To continue a conversation in another tool, open it in **对话**, click **换个工具继续**, and paste the one-line instruction (for example `通过 SuperLcm 接续对话 #6e94e`) into a new conversation of the target tool. Its AI calls `lcm_continue`, receives the top-level outline plus recent messages, and reads anything older with `lcm_read`. Nothing is pushed into another process; the target pulls what it needs.

Each connected tool card shows evidence in order of strength: configuration matches, a SuperLcm MCP process loaded, and the AI actually called a tool. A self-test proves the configuration and protocol work, not that an already-open session reloaded it. There is no remote multi-device sync or per-client ACL: every client sharing the index can read every stored conversation, so connect only trusted local clients.

Summary settings have **one global default** plus optional per-tool overrides (set on each tool's card under 接入); there is no per-conversation selector. The choices are 对话模型生成 (the conversation's own AI, the default), 本工具后台写 (a background run of the conversation's own tool), 自定义 API and 关闭. Saving never invokes a model. For 本工具后台写 each tool card has a model picker filled from that tool itself (Claude `initialize.models`, Codex `debug models`, Pi `--list-models`, Hermes the model in its `config.yaml`), plus 其他模型… to type any ID; by default the tool's current model is used. A listed model does not prove entitlement. Custom API takes Anthropic Messages or OpenAI-compatible Chat Completions, a full endpoint URL, a model ID and a write-only key stored in `SUPERLCM_HOME/api-credentials.json` (0600 on POSIX), never echoed back. A local gateway on this computer (`http://127.0.0.1…` or `http://[::1]…`, for example an OpenAI-compatible proxy) may be saved without a key; requests to it then carry no authorization header. Segment size (characters) and merge width are set under **摘要粒度** and apply to new summaries only; each record goes to the summarizer whole (one summary call takes at most 64,000 characters).

## Shared conversations across harnesses

Storage and the MCP tools are **tool-independent**. Each conversation keeps its own originals, source tool label, summary nodes and exact byte offsets, and has a short `#code` (first five hex digits of a hash of its key). `lcm_find` resolves a `#code`, name or ID (ambiguous names return candidates) and searches summaries and originals. `lcm_outline` walks the summary tree; `lcm_read` returns exact originals, verified by SHA-256 against the source file.

For Codex on the **same machine and user index**, register the same stdio server once (example command; the package does not run it for you):

```bash
codex mcp add superlcm -- node /ABSOLUTE_PATH_TO_REPO/src/cli.js mcp
```

Then in Codex say: “通过 SuperLcm 接续对话 #xxxxx” or “find the Claude Code conversation about X and check decision Y against the originals.” **MCP registration alone does not capture Codex history**; configure the Codex hooks below (the console does this for you). For unsupported tools, import a user-exported UTF-8 `.txt` or portable `.jsonl` of `{"role":"user|assistant","content":"..."}` messages (Codex rollout `response_item` / `event_msg` messages are also recognized):

```bash
node /ABSOLUTE_PATH_TO_REPO/src/cli.js import /path/to/export.jsonl codex-my-session codex
node /ABSOLUTE_PATH_TO_REPO/src/cli.js summarize codex-my-session   # optional; invokes the configured model
```

If JSONL contains no visible user/assistant text, import rejects it; use a readable `.txt` export instead. Imports copy the original into the private index, preserving exact expansion if the exported file moves. For manual imports, harness and session ID are user-supplied provenance labels, not independently verified native IDs. The source harness, reading harness, and summarizer backend (`cli` or `api`) are independent.

## Codex CLI automatic conversation capture (opt-in)

Codex CLI 0.155.1 exposes command hooks with `session_id` and `transcript_path` ([official hook contract](https://learn.chatgpt.com/docs/hooks.md)); the local rollout format is **not a stable hook API**, so upgrades can require parser changes. Merge the following into your **own** `~/.codex/hooks.json` on the machine running Codex; manual configuration is optional because the reviewed installer can merge the same lifecycle events without an agent hand-editing this file:

```json
{
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js codex-hook", "timeout": 15}]}],
    "PostCompact": [{"hooks": [{"type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js codex-hook", "timeout": 15}]}],
    "SessionStart": [{"matcher": "startup|resume|compact", "hooks": [{"type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js codex-hook", "timeout": 15}]}],
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js codex-hook", "timeout": 15}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js codex-hook", "timeout": 3}]}]
  }
}
```

Codex requires new/changed non-managed hooks to be trusted. When the user leaves the 接入 dialog's approval box checked, SuperLcm asks Codex's own app-server to record that trust (`config/batchWrite` upserting `hooks.state.<key>.trusted_hash = currentHash`, the same entry `/hooks` writes), only for hooks whose command is exactly SuperLcm's, then reads `hooks/list` again to confirm. After setup and on **检查接入**, the console asks Codex's own app-server (`codex app-server`, `hooks/list`) whether SuperLcm's hooks are already trusted, read-only, and only asks for review when some are not. **打开 Codex 确认** opens Codex in a new terminal window (macOS Terminal via a private `.command` file, Windows `cmd`, Linux `x-terminal-emulator`), where Codex's own startup screen lists the new hooks for you to trust; **重新检查** reads the status again. Unless that box was checked, SuperLcm never writes trust state. `SessionStart` and `UserPromptSubmit` index complete local JSONL records first, so in in-conversation mode the AI can call `lcm_summary_task` and `lcm_summary_submit` during that turn; `Stop`/`PostCompact` also index and may start a background summary worker, and `SessionEnd` catches the final tail. A lagging transcript stays pending until a later hook; nothing is invented. After native compaction, `SessionStart(compact)` adds a short note that all originals are preserved under the conversation's `#code` and how to read them. Transcript paths must be under `$CODEX_HOME/sessions/` or the session working directory's `.codex/` folder. The key `codex-<session_id>` and the original `session_id` are both recorded.

Claude Code captures its `custom-title`/`ai-title` transcript records when present (custom title wins); otherwise the name comes from the first visible user message. Codex names come from its local state SQLite when the read-only schema and rollout path match. Rename any conversation in the console or with `node /ABSOLUTE_PATH_TO_REPO/src/cli.js name <conversation> "Human title"`; a manual name wins over later hook updates. MCP has no rename tool.

Codex hooks use the same summary setting as Claude hooks: `cli` means a background `codex exec` run with your Codex configuration, `api` means the custom API, and `off` indexes/searches originals without generating summaries. Set `SUPERLCM_HOME` identically for all tools if overriding the default.

**Privacy boundary:** every process configured to use this local MCP and the same index can read *all* indexed sessions; there is no per-client authorization. Configure only trusted clients. Local stdio does not bridge separate computers: a Windows Claude Code session and a Mac Codex client do not share an index unless you arrange a secure common deployment and source access. No such sync/remote server is provided.

## Claude Code: the plugin (recommended)

`/plugin marketplace add yu381792/superlcm` then `/plugin install superlcm@superlcm` (or **安装插件** on the console's Claude card). The plugin carries the same capture hooks (`hooks/hooks.json`, run through `src/launch.js`), the lookup tools as the plugin's MCP server, the `/superlcm:console` skill, and a Claude Code module, `hooks/compact-mod.js`, which Claude Code 2.1.286+ loads (the terminal `claude` and the desktop app's bundled engine alike; older engines ignore it). The module does two things:

- **Compaction takeover** (console › Settings › Compaction, off by default). On `session.compact` for the main conversation it runs `launch.js compact-packet <session>` with the live messages; the reply replaces the part covered by summaries with the fewest layered summaries, keeps the newest stretch word for word (Keep recent originals: 40K tokens by default, at most half the context, never fewer than the last two prompts) and calls no model. Claude Code's precompute (the compaction it prepares ahead of time and swaps in at the threshold) is answered the same way, so the prepared result is SuperLcm's whenever the summaries are ready. Any doubt (takeover off, a subagent, summaries lagging, the result still over 60% of the window) returns the compaction to Claude Code. Turning it on makes Claude Code's own compaction start at the console's size, where the module answers it: it sets `autoCompactWindow` and `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` in Claude's `settings.json` to 100K above that size (at most 1M; the desktop app reads only the env), and `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to the percentage that puts the start at the size itself (Claude Code 2.1.287 compacts at min(E × pct / 100, E − 13K), E being its window less 20K for output; 78.9474 for 300K). On a model whose window is smaller than that, Claude Code clamps to the model's window and the start scales down with it. When the summaries lag, Claude Code then summarizes at that same size the usual way. The module never starts a compaction itself: on a plugin's own `$.session.compact()` Claude Code skips the calling plugin's hooks, so the result would always be Claude Code's own summary (checked on 2.1.287). The threshold can be a preset or a custom size from 100K to 950K, the recent originals kept from 5K to 200K. The earlier values of the three keys are remembered and restored when it is turned off; a key that the version which turned it on did not set is left as it is.
- **本工具后台写 inside the conversation.** When Claude Code's summaries are written by Claude Code itself (`cli`), each `turn.complete` writes the waiting pieces with `$.model.complete` on the session's own login (`summary-claim` → model → `summary-save`), without starting another Claude Code and without the turn waiting. `session.start` marks the session (`summary-host`) so the `Stop` hook does not also start `claude -p`; `session.end`, or a failed model call, hands what is left back to that worker (`summary-handoff`).

When the plugin is enabled, an older manual connection (the settings.json hooks below) stays quiet, and the console's Claude card offers to remove it and the old user-level MCP entry, backing both files up first.

## Claude Code CLI integration (older manual setup, no configuration is written for you)

Replace `/ABSOLUTE_PATH_TO_REPO` with the repository's absolute path. Add this server and the hook blocks to the relevant Claude Code user or project settings *only if you choose to enable them*. An example server stanza for `.mcp.json` is:

```json
{
  "mcpServers": {
    "superlcm": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE_PATH_TO_REPO/src/cli.js", "mcp"]
    }
  }
}
```

Example `.claude/settings.json` hook block (merge with your existing `hooks` rather than replacing it):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook", "async": true }] }],
    "PostCompact": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook", "async": true }] }],
    "SessionStart": [{ "matcher": "startup|resume|compact", "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook" }] }]
  }
}
```

`Stop`/`PostCompact` asynchronously index complete JSONL records and, when a segment is ready, start the selected background worker. `SessionStart(compact)` adds a short retrieval note after Claude's native compaction. `UserPromptSubmit` nudges summarization **only** when that tool (or the inherited global default) selects 对话模型生成. It cannot ensure the model calls tools.

## Summary modes

Without a saved setting, `SUPERLCM_SUMMARY_MODE=auto` means `agent` (对话模型生成), or `api` when `SUPERLCM_ANTHROPIC_API_KEY` is set. `SUPERLCM_SUMMARY_MODE=agent|cli|api|off|auto` selects one explicitly; settings saved in the console take precedence (`codex-cli`, the retired name, is read as `cli`). `agent` exposes `lcm_summary_task` and `lcm_summary_submit`; they are hidden from `tools/list` when no tool uses this mode. Existing summary nodes are always preserved.

### 本工具后台写 (`cli`)

When a piece is ready (Claude Code/Codex `Stop`, `PostCompact`, `SessionEnd`; Hermes session end; Pi turn end and compaction), the hook starts a background worker that runs **the conversation's own tool** once, non-interactively, with the account, provider and model you configured in that tool; a model picked on the tool's card is passed explicitly. The live conversation is not involved. (Claude Code with the plugin on 2.1.286+ writes from inside the conversation instead; see the plugin section above.) An imported conversation whose tool is not installed uses the first installed one (Claude Code, Codex, Hermes, Pi).

| Tool | Command (prompt on stdin) | Kept out of history and capture |
|---|---|---|
| Claude Code | `claude --print --output-format json [--model M] --no-session-persistence --settings {"disableAllHooks":true} --tools '' --strict-mcp-config --system-prompt …` | no session file, hooks off |
| Codex | `codex exec --ephemeral --ignore-rules -c mcp_servers={} --skip-git-repo-check -s read-only [-m M] --json -` | ephemeral thread, no MCP servers started |
| Hermes | `hermes chat --query-file - --format stream-json --source tool --ignore-rules --max-turns 1 [-m M]` | tagged `tool`, which Hermes keeps out of user session lists |
| Pi | `pi -p --no-session --no-tools --no-extensions --no-skills --no-context-files --no-prompt-templates --no-themes --system-prompt … [--model M]` | no session file, no extensions |

Every run carries `SUPERLCM_CLI_WORKER=1`; all SuperLcm hooks (`hook`, `codex-hook`, `hermes-hook`, `pi-hook`) skip a run with that marker, so a summary job is never stored as a conversation. SuperLcm's own `SUPERLCM_ANTHROPIC_API_KEY` is not passed on; everything else in the environment is, so the tool routes exactly as it does when you chat with it. Each run is bounded (64,000 characters in, 1 MiB out, 180 s), runs in a private scratch folder under the index home, and its stderr is discarded. `SUPERLCM_CLAUDE_CLI_MODEL` / `SUPERLCM_CODEX_CLI_MODEL` still set a model when none is picked; `SUPERLCM_CLAUDE_CLI_BIN`, `SUPERLCM_CODEX_CLI_BIN`, `SUPERLCM_HERMES_BIN` and `SUPERLCM_PI_BIN` point at a specific executable. Summary failures set `summary_error`; raw records remain searchable.

### 对话模型生成 (`agent`, default)

This is the default. When a whole piece is waiting, the hook adds one short note to that turn (Claude Code and Codex `UserPromptSubmit`, Hermes `pre_llm_call`, Pi `before_agent_start`) asking the AI to call `lcm_summary_task` with `recent:true` after answering, then `lcm_summary_submit`. A piece the AI has just been through comes back as `from_memory`: only where it starts and ends, so the AI writes it from its own context and nothing is sent again; the cost is the few hundred tokens of the summary itself. SuperLcm records where the host tool compacted the conversation (Claude Code/Codex `PostCompact`, a Hermes continuation session, Pi `session_compact`); a piece that begins before that point is no longer in the AI's context, so it comes with its original text instead, and nothing is skipped. Merges always come with the child summaries. A summary written from memory cannot be checked word for word against the originals; it is navigation only, and the originals stay exact. The console's 补齐摘要 button catches up in the background with whatever method this computer has. The local stdio MCP cannot authenticate which conversation is calling, so the stored model label is `mcp-agent`, and `recent:true` should only be used from inside that conversation.

### Custom API backend (explicit opt-in)

In **Model Settings**, choose “自定义 API” for global or per-harness use. Select **Anthropic Messages** or **OpenAI-compatible Chat Completions**, enter the full endpoint URL, explicit model ID and independent API key. Remote endpoints require HTTPS; plain HTTP is allowed only for numeric loopback (127.0.0.1 or ::1). An origin alone gets the standard `/v1/messages` or `/v1/chat/completions` route appended; an explicit path is used as supplied. The key is written to a separate private local file and never returned by the Web API; leave the field blank to keep the saved key when editing. Global and harness overrides use **separate keys**—an override never borrows a key for another endpoint. The file is not encrypted against code running as the same OS user. Only choose a trusted endpoint: summary batches include conversation content.

The older environment route remains for setups with **no saved API policy**: `SUPERLCM_SUMMARY_MODE=api`, `SUPERLCM_CLAUDE_MODEL`, `SUPERLCM_ANTHROPIC_API_KEY`, and optional `SUPERLCM_CLAUDE_API_URL` (Anthropic Messages). This never falls back to the main Claude Code `ANTHROPIC_API_KEY`. An explicitly saved API policy needs its scoped stored key. No paid provider was contacted for validation: both protocols were tested with mock fetch, and the real background worker was exercised against a **local fake HTTP endpoint**.

### Desktop surfaces are different

The Desktop **Code tab in a Local session** uses the same Claude Code engine, MCP settings, and hooks as the CLI. Both modes apply if its transcript is local and the hooks run in that local environment. A Cloud or SSH session runs elsewhere; a local stdio server cannot read the remote transcript. The ordinary Desktop **Chat tab** can use MCP tools but does not expose its entire live chat transcript or Claude Code hooks to this adapter.

This package exposes **local stdio MCP only**. A Windows Desktop connected to another remote MCP via `mcp-remote` does not automatically expose this Mac-only process: install this repo and Node 22.16+ on Windows for a local server, or separately provide a secure remote bridge. Never expose the local transcript index on a public network.

## Optional: ordinary Desktop Chat (not the Code tab)

Configure the same local stdio server under `mcpServers` in Claude Desktop's MCP configuration using the server stanza above. This grants **retrieval**, not access to the current chat's hidden history. To add an export yourself:

```
node /ABSOLUTE_PATH_TO_REPO/src/cli.js import /absolute/path/to/export.txt desktop-my-chat
node /ABSOLUTE_PATH_TO_REPO/src/cli.js summarize desktop-my-chat
```

The second command uses the configured backend. MCP cannot capture the Chat tab's hidden history; you must export it yourself. Importing and indexing are CLI/console operations only; MCP has no import or index tool. Never expose this stdio server remotely.

## Tool contract and current limitations

- `lcm_continue {conversation, max_chars?}`: bounded handoff packet: header, top-level outline with node ids and record ranges, the unsummarized-tail note, the most recent messages, and how to dig deeper. Labelled as untrusted data.
- `lcm_find {query?, conversation?, harness?, limit?}`: without a query, lists conversations; with one, returns matching conversations, summaries and original snippets.
- `lcm_outline {conversation, node?}`: conversation stats and top-level nodes, or a node's children, or the record range under a first-level node.
- `lcm_read {conversation, from, to?, char_offset?, max_chars?}`: exact original records decoded as UTF-8, paginated by the returned next position. `lcm_summary_task` / `lcm_summary_submit`: in-conversation mode only (see above).
- Import/index are side-effecting, explicit, local operations. They do not replace native context compaction. There is no claim that original JSONL contains model-internal hidden state; "exact" means the retained on-disk source record. Search indexes visible user/assistant text (not every tool-result field), while expansion returns the full retained record.
- A modified/truncated source is not silently reindexed. Expansion verifies the raw SHA-256 and fails closed if changed. The per-source cap is 4 GiB (read in pieces; a larger source is marked `too-large` instead of indexed), shared per-JSONL-line cap 32 MiB (including large Codex compaction records), and manual import cap 32 MiB. DSH projected events retain their separate 4 MiB cap. Session IDs isolate records. The implementation accepts both legacy MCP `initialize` and current `2026-07-28` `server/discover` request formats; actual Claude/Codex client interoperability still needs testing on target installations.

## Documentation consulted

- Claude Code hooks and async transcript caveat: https://code.claude.com/docs/en/hooks
- Claude Code JSONL sessions: https://code.claude.com/docs/en/how-claude-code-works
- Claude Code MCP config: https://code.claude.com/docs/en/mcp
- Claude connector limits: https://claude.com/docs/connectors/overview
- Current MCP discovery, tools: https://modelcontextprotocol.io/specification/2026-07-28/server/discover and https://modelcontextprotocol.io/specification/2026-07-28/server/tools

Native Claude metadata probing can refresh its own cachedGrowthBookFeatures, cachedGrowthBookFeaturesAt and cachedExperimentData fields in .claude.json. It does not send a model prompt. The browser test compares real user settings after excluding only those observed runtime-cache fields; all MCP, hook, model and trust configuration remains included in the comparison.
