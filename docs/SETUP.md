# SuperLcm setup and reference (preview)

This is an **independent cross-harness MCP package (not a DSH plugin)**. It does not replace any harness's native compaction. It builds an external layered summary DAG and retrieves the original conversation on demand. Summary modes are exclusive: default `auto` uses a separate `claude --print` subprocess (`cli` mode) with selectable model, and a dedicated `SUPERLCM_ANTHROPIC_API_KEY` selects the separate paid `api` backend. Explicit `off` disables summaries. The current-session agent writes summaries **only** when explicitly selecting advisory `agent` mode; it remains off by default. Claude Code and Codex CLI each have an opt-in automatic hook adapter; other harnesses need an explicit export/import or their own adapter. No harness configuration is modified on startup. The explicit reviewed Web installer or setup --apply command can register MCP and merge hooks for supported harnesses.

## Requirements and data ownership

- Node.js 22.16+ (`node:sqlite`), local stdio MCP, no additional runtime dependencies or always-on service.
- Claude Code CLI sessions: original source is Claude Code's local JSONL under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`). Hook `transcript_path` may lag behind the current in-memory turn; indexing waits for complete JSONL lines. The index never modifies the transcript.
- Ordinary Claude Desktop chat: MCP does **not** expose the whole chat transcript. You must explicitly export a conversation to a `.jsonl` or UTF-8 `.txt` file and import it. A `.txt` file is copied byte-for-byte and each line (including newlines) is indexed as an exact source event; no claim is made that a partial export contains every chat message. Claude Code sessions inside the Desktop application follow the Code path only when their hooks and transcript are accessible.
- The shared local index defaults to `~/.superlcm-claude/lcm.sqlite` (override with `SUPERLCM_HOME`; the old `SUPERLCM_CLAUDE_HOME` still works). Point all local MCP clients at the **same** home. Every indexed record is also copied byte for byte into `originals/` under that home, as a prefix of the host transcript, so the event offsets address both. Reads use this private copy first and fall back to the host transcript; both are checked against the stored SHA-256, and a mismatch is refused. The copy is filled as hooks index new records; `node src/cli.js archive` fills it for existing conversations and finds Codex transcripts that were moved into `archived_sessions/`. Disk use is roughly the size of the indexed transcripts. Files are created with private permissions.
- Indexed text and summaries can contain secrets. Keep the index local and restrict filesystem backups and permissions. In `cli` mode, bounded excerpts go to a separate Claude CLI subprocess using that machine's own login and subscription allowance (subject to its configured auth/billing and usage limits). `api` mode sends them to the explicitly selected HTTPS endpoint and incurs separate API billing. Neither mode asks the main agent to write summaries.

## Simple installation and local detection

Run `node src/cli.js web`, then open **接入** and click **接入** on the detected tool. Review and confirm the shown files. The installer backs up configuration, preserves unrelated entries and does not grant hook trust. Codex still requires its `/hooks` review. Terminal alternatives:

    node src/cli.js doctor-local
    node src/cli.js setup codex
    node src/cli.js setup codex --apply
    node src/cli.js setup claude-code --apply

Hermes (`HERMES_HOME`, default `~/.hermes`) and Pi (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) are supported too. See [capabilities and test contract](CONSOLE.md).

**Hermes.** Setup edits `config.yaml` only through Hermes' own Python (`load_config` / `save_config` / `_save_mcp_server`, run with the interpreter of the installed `hermes` launcher), adding the `superlcm` MCP server (with `SUPERLCM_CLIENT=hermes`, since Hermes' MCP client sends no name) and `on_session_end` / `on_session_finalize` shell hooks that run `cli.js hermes-hook`. Hermes asks once, in a terminal, whether to allow new hooks; SuperLcm only reads `shell-hooks-allowlist.json`. Hermes stores messages in `state.db` and may rewrite them, so each hook appends every new message row (tool and inactive rows included) to SuperLcm's own JSONL copy under `SUPERLCM_HOME/hermes/` and indexes that copy as `hermes-<root id>`. A compression continuation (parent ended by compression, child not branched, delegated or reset) joins the same conversation; branches and subagents do not.

**Pi.** Setup writes one auto-discovered file, `extensions/superlcm.ts`, and refuses if a file of that name that SuperLcm did not write already exists. The extension reports `session_start`, `turn_end`, `agent_settled`, `session_compact` and `session_shutdown` to `cli.js pi-hook`, which indexes the append-only session file byte for byte (all branches), and registers the SuperLcm MCP tools as Pi tools; `/superlcm-status` lists them. Open Pi sessions pick it up after `/reload`.

**Which node launches SuperLcm.** Setup writes the path of a Node.js 22.16+ that no AI tool ships inside its own folder (it checks the node running the console, then `/usr/local/bin/node`, `/opt/homebrew/bin/node` and `PATH`), so updating Hermes, which bundles a node under `~/.hermes/node`, cannot remove it. If only a tool-bundled node exists, the card says so. Connecting again replaces SuperLcm's own older MCP entry and hooks in place (never duplicates them); Codex and Hermes then ask you to approve the changed hooks once more.

In-conversation summaries (`agent` mode) get no per-turn nudge in Hermes or Pi yet; choose a background method for those tools. Conversations imported earlier as one-off snapshots stay as separate entries.

## Local Web control console (opt-in)

Run `node /ABSOLUTE_PATH_TO_REPO/src/cli.js web` and open `http://127.0.0.1:8791/` (or pass another port). The server binds only to 127.0.0.1 and needs no login. It refuses requests whose Host header is not `127.0.0.1:<port>` (which stops DNS-rebinding pages), refuses cross-origin writes, accepts writes only as JSON (so a foreign web page cannot send them without a failing preflight), and serves a strict CSP. Web pages on other sites cannot read its responses. Any program running as your user on this computer can open it, the same as it can read the index files directly. Opening the page never calls a model. See [CONSOLE.md](CONSOLE.md) for what each view does.

To continue a conversation in another tool, open it in **对话**, click **换个工具继续**, and paste the one-line instruction (for example `通过 SuperLcm 接续对话 #6e94e`) into a new conversation of the target tool. Its AI calls `lcm_continue`, receives the top-level outline plus recent messages, and reads anything older with `lcm_read`. Nothing is pushed into another process; the target pulls what it needs.

Each connected tool card shows evidence in order of strength: configuration matches, a SuperLcm MCP process loaded, and the AI actually called a tool. A self-test proves the configuration and protocol work, not that an already-open session reloaded it. There is no remote multi-device sync or per-client ACL: every client sharing the index can read every stored conversation, so connect only trusted local clients.

Summary settings have **one global default** plus optional per-tool overrides (set on each tool's card under 接入); there is no per-conversation selector. The choices are 对话模型生成 (the conversation's own AI), Claude 订阅, Codex 订阅, 自定义 API and 关闭. Saving never invokes a model. CLI model lists come from the installed CLI's own catalog (Codex `debug models`, Claude `initialize.models`); a listed model does not prove entitlement. Custom API takes Anthropic Messages or OpenAI-compatible Chat Completions, a full endpoint URL, a model ID and a write-only key stored in `SUPERLCM_HOME/api-credentials.json` (0600 on POSIX), never echoed back. Segment size (characters) and merge width are set under **摘要粒度** and apply to new summaries only; each record goes to the summarizer whole (one summary call takes at most 64,000 characters).

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

Codex requires a user to review and trust new/changed non-managed hooks with `/hooks`; do **not** bypass trust. After setup and on **检查接入**, the console asks Codex's own app-server (`codex app-server`, `hooks/list`) whether SuperLcm's hooks are already trusted, read-only, and only asks for review when some are not. **打开 Codex 确认** opens Codex in a new terminal window (macOS Terminal via a private `.command` file, Windows `cmd`, Linux `x-terminal-emulator`), where Codex's own startup screen lists the new hooks for you to trust; **重新检查** reads the status again. SuperLcm never writes trust state. `SessionStart` and `UserPromptSubmit` index complete local JSONL records first, so in in-conversation mode the AI can call `lcm_summary_task` and `lcm_summary_submit` during that turn; `Stop`/`PostCompact` also index and may start a background summary worker, and `SessionEnd` catches the final tail. A lagging transcript stays pending until a later hook; nothing is invented. After native compaction, `SessionStart(compact)` adds a short note that all originals are preserved under the conversation's `#code` and how to read them. Transcript paths must be under `$CODEX_HOME/sessions/` or the session working directory's `.codex/` folder. The key `codex-<session_id>` and the original `session_id` are both recorded.

Claude Code captures its `custom-title`/`ai-title` transcript records when present (custom title wins); otherwise the name comes from the first visible user message. Codex names come from its local state SQLite when the read-only schema and rollout path match. Rename any conversation in the console or with `node /ABSOLUTE_PATH_TO_REPO/src/cli.js name <conversation> "Human title"`; a manual name wins over later hook updates. MCP has no rename tool.

Codex hooks use the same summary setting as Claude hooks: default `cli` means an independently logged-in **Claude** CLI subscription (not Codex subscription), `api` means explicit Anthropic API billing, and `off` indexes/searches originals without generating summaries. Configure that environment where Codex launches the hook, and set `SUPERLCM_HOME` identically for both harnesses if overriding the legacy default.

**Privacy boundary:** every process configured to use this local MCP and the same index can read *all* indexed sessions; there is no per-client authorization. Configure only trusted clients. Local stdio does not bridge separate computers: a Windows Claude Code session and a Mac Codex client do not share an index unless you arrange a secure common deployment and source access. No such sync/remote server is provided.

## Claude Code CLI integration (manual setup, no configuration is written for you)

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

## Summary modes for Claude Code CLI and Desktop Code (Local)

The default `SUPERLCM_SUMMARY_MODE=auto` chooses `cli` without a dedicated API key, or `api` when `SUPERLCM_ANTHROPIC_API_KEY` is set. `SUPERLCM_SUMMARY_MODE=cli|codex-cli|api|agent|off|auto` selects a backend explicitly; settings saved in the console take precedence. Explicit `cli` strips any API key from the CLI subprocess. `agent` (对话模型生成) exposes `lcm_summary_task` and `lcm_summary_submit`; they are hidden from `tools/list` unless some tool or the global default uses this mode. Existing summary nodes are always preserved.

### CLI subscription backend (default, no separate API key)

Install and log into the `claude` CLI on **the same machine that runs the hook**, including Windows for Desktop Code Local. The hook starts a background worker that runs `claude --print` with a selectable model:

```text
SUPERLCM_SUMMARY_MODE=cli
SUPERLCM_CLAUDE_CLI_MODEL=sonnet
# Optional, if claude is not on PATH: SUPERLCM_CLAUDE_CLI_BIN=/absolute/path/to/claude
```

`sonnet` is the default model alias; set `SUPERLCM_CLAUDE_CLI_MODEL` to another installed CLI-supported model or alias (for example `opus` or `claude-sonnet-5`). CLI login/subscription usage and model availability are controlled by Claude Code, not MCP. The child disables built-in tools and MCP (`--tools '' --strict-mcp-config`), runs in a private scratch directory under the SuperLcm index home (keep that home outside projects), strips API/cloud-routing environment variables, and marks inherited SuperLcm hooks so they cannot recurse. No `--bare` is used (it can change CLI authentication). User-level Claude instructions and other hooks may still apply; confirm the `claude` CLI's own login and billing selection before relying on subscription billing. Summary failures set `summary_error`; completed raw records remain searchable.

### Codex CLI subscription backend (explicit opt-in)

Set `SUPERLCM_SUMMARY_MODE=codex-cli` or choose Codex subscription for the global default / a configured Codex harness in the local Web console. The worker runs `codex exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only --json -` in a private scratch directory. It strips API routing keys, preserves `CODEX_HOME` for your CLI login, bounds the prompt and JSONL output, does not persist a Codex thread, and accepts `SUPERLCM_CODEX_CLI_MODEL` (or uses the installed Codex CLI’s built-in default (user config is ignored for worker isolation)). It assumes the installed CLI honors these flags and is authenticated; subscription entitlements, availability and billing are controlled by Codex, not SuperLcm. This backend was validated with a fake CLI process, **not** a paid/live model call.

### Current-session agent (explicit opt-in)

Choose 对话模型生成 in the console (or `SUPERLCM_SUMMARY_MODE=agent`). After each answer, a `UserPromptSubmit` nudge asks the AI to call `lcm_summary_task`, which returns either the next merge (several adjacent summaries to combine) or the next unsummarized segment, and then `lcm_summary_submit`, which re-verifies the originals before saving. One task per turn keeps the cost low: the AI mostly re-reads context that is already cached. If the conversation stops, summarizing stops too; the console offers a one-click background catch-up with whichever method this computer has: an installed Claude or Codex CLI, or a saved custom API. Catch-up is manual by default. Under 设置 › 摘要 you can opt in to **自动补齐** with the Claude or Codex CLI: a hook then starts a background pass once the backlog reaches about 3 model calls, or when a conversation ends with work left (Codex has no end event, so only the backlog rule applies there). The local stdio MCP cannot authenticate which conversation is calling, so the stored model label is `mcp-agent`.

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
- A modified/truncated source is not silently reindexed. Expansion verifies the raw SHA-256 and fails closed if changed. The per-source cap is 256 MiB, per-JSONL-line cap 4 MiB, and manual import cap 32 MiB. Session IDs isolate records. The implementation accepts both legacy MCP `initialize` and current `2026-07-28` `server/discover` request formats; actual Claude/Codex client interoperability still needs testing on target installations.

## Documentation consulted

- Claude Code hooks and async transcript caveat: https://code.claude.com/docs/en/hooks
- Claude Code JSONL sessions: https://code.claude.com/docs/en/how-claude-code-works
- Claude Code MCP config: https://code.claude.com/docs/en/mcp
- Claude connector limits: https://claude.com/docs/connectors/overview
- Current MCP discovery, tools: https://modelcontextprotocol.io/specification/2026-07-28/server/discover and https://modelcontextprotocol.io/specification/2026-07-28/server/tools

Native Claude metadata probing can refresh its own cachedGrowthBookFeatures, cachedGrowthBookFeaturesAt and cachedExperimentData fields in .claude.json. It does not send a model prompt. The browser test compares real user settings after excluding only those observed runtime-cache fields; all MCP, hook, model and trust configuration remains included in the comparison.
