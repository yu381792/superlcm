# SuperLcm — cross-harness conversation recall (preview)

This is an **independent cross-harness MCP package (not a DSH plugin)**. It does not replace any harness's native compaction. It builds an external layered summary DAG and retrieves the original conversation on demand. Summary modes are exclusive: default `auto` uses a separate `claude --print` subprocess (`cli` mode) with selectable model, and a dedicated `SUPERLCM_ANTHROPIC_API_KEY` selects the separate paid `api` backend. Explicit `off` disables summaries. The current-session agent writes summaries **only** when explicitly selecting advisory `agent` mode; it remains off by default. Claude Code and Codex CLI each have an opt-in automatic hook adapter; other harnesses need an explicit export/import or their own adapter. No harness configuration is modified on startup. The explicit reviewed Web installer or setup --apply command can register MCP and merge hooks for supported harnesses.

## Requirements and data ownership

- Node.js 22.16+ (`node:sqlite`), local stdio MCP, no additional runtime dependencies or always-on service.
- Claude Code CLI sessions: original source is Claude Code's local JSONL under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`). Hook `transcript_path` may lag behind the current in-memory turn; indexing waits for complete JSONL lines. The index never modifies the transcript.
- Ordinary Claude Desktop chat: MCP does **not** expose the whole chat transcript. You must explicitly export a conversation to a `.jsonl` or UTF-8 `.txt` file and import it. A `.txt` file is copied byte-for-byte and each line (including newlines) is indexed as an exact source event; no claim is made that a partial export contains every chat message. Claude Code sessions inside the Desktop application follow the Code path only when their hooks and transcript are accessible.
- For compatibility, the shared local index still defaults to `~/.superlcm-claude/lcm.sqlite` and imported originals to `~/.superlcm-claude/imports/`; override with `SUPERLCM_HOME` (the old `SUPERLCM_CLAUDE_HOME` remains supported). Point all local MCP clients at the **same** home. Files are created with private permissions. SQLite contains source byte offsets, SHA-256 hashes, searchable text and summaries. It is **not** the authoritative original conversation. Do not delete the source Claude Code JSONL if you need exact expansion. Imported originals are retained inside the private directory. Stored summary nodes are idempotent: changing the model affects future batches, not already saved nodes.
- Indexed text and summaries can contain secrets. Keep the index local and restrict filesystem backups and permissions. In `cli` mode, bounded excerpts go to a separate Claude CLI subprocess using that machine's own login and subscription allowance (subject to its configured auth/billing and usage limits). `api` mode sends them to the explicitly selected HTTPS endpoint and incurs separate API billing. Neither mode asks the main agent to write summaries.

## Simple installation and local detection

Run `node src/cli.js web`, then open **MCP连接 → 接入 / 修复** for the chosen detected harness. Review and confirm the shown paths/commands. The installer backs up configuration, preserves unrelated entries and does not grant hook trust. Codex still requires its `/hooks` review. Terminal alternatives:

    node src/cli.js doctor-local
    node src/cli.js setup codex
    node src/cli.js setup codex --apply
    node src/cli.js setup claude-code --apply

Hermes (`HERMES_HOME`) and Pi (`PI_CODING_AGENT_DIR`) are also detected and offer explicit native-store snapshot import; automatic MCP/hook setup for those two is not implemented yet. See [capabilities and test contract](CONSOLE.md).

## Local Web control console (opt-in)

Run `node /ABSOLUTE_PATH_TO_REPO/src/cli.js web` (or add an optional local port number). It prints a one-time `http://127.0.0.1:<port>/?token=...` URL; opening that address loads the control panel. The server binds **only** 127.0.0.1, requires the bearer token on API requests, enforces same-origin writes, and SuperLcm does not send a summary/model request merely by opening the page. The model panel uses actual `codex debug models` and Claude initialization-only `initialize.models` metadata; cache fallback is visibly marked and no user prompt is sent; CLI-internal behavior is outside SuperLcm’s control. The layout/palette follows the local port-8790 量化资产中心 reference; its data and server are independent. The CLI does not start the Web service unless you explicitly run `web`. The current target selector is for an **already indexed conversation ID**, not a persistent agent template or an agent on another machine.

Three distinct operations: `lcm_import` imports an **export file into the index**; `lcm_context` directly returns a source conversation’s bounded navigation in the **calling agent’s MCP tool result**; `lcm_enqueue_context` queues cross-conversation delivery only with `SUPERLCM_ALLOW_MCP_DELIVERY=1` (the authenticated Web queue is the default manual route). MCP cannot force a different agent process to accept content.

Select an indexed **source** and **target** conversation to preview a bounded navigation and queue a one-time delivery. The source needs at least one summary node; the target must already be indexed and have an exact harness + conversation ID. Claude/Codex `UserPromptSubmit` or `SessionStart` hooks issue up to three pending packets at their next event. Status **pending** means nothing was injected; **hook issued** only means the command wrote a context packet, **not** proof that the host/model read or used it. The server does not forcibly write another client’s private context.

Each harness row has its own test button: check configuration match, real stdio `initialize`/`tools/list`, and actual hook-to-index behavior in a temporary fixture. This does **not** prove native trust or a live host connection. The activity panel separately shows last actual hook events and MCP client self-reported handshakes. There is no remote multi-device sync or per-client ACL. Each user of a shared index can see its sessions and select deliveries, so connect only trusted local clients.

Model settings have **one global default** and expandable settings for locally configured or previously observed harnesses; there is **no per-conversation selector**. A harness-specific setting overrides the global default, and “inherit global” removes that override. Existing legacy per-conversation setting rows are preserved in SQLite but no longer govern summaries. The five choices are off, current-session agent (advisory), Codex subscription CLI, Claude subscription CLI, and custom API (last). Saving never invokes a model. The page detects configured MCP entries or past hook/handshake activity; configuration and self-reported activity do **not** prove a client is currently connected. Codex choices come from the installed CLI `debug models` response (explicitly labelled cache fallback when unavailable); Claude choices come from the runtime initialization control response `initialize.models`, including resolved model IDs. Help examples are never used as a catalog. The Web shows a **selectable model dropdown** with CLI default, discovered models and a manual model-ID choice. Even a live metadata response does not prove subscription entitlement or successful inference. Custom API expands fields for Anthropic Messages or OpenAI-compatible Chat Completions, full endpoint URL, model ID and a write-only key. The key lives separately from SQLite in `SUPERLCM_HOME/api-credentials.json` (0600 on POSIX); the page reports only whether one is saved, never echoes it. A trusted process running as the same OS user can still read this file. Saving never invokes a model; a later summary job may send bounded conversation excerpts to the configured endpoint.

## Shared conversations across harnesses

The storage and read-only MCP tools are **harness-independent**. Each session ID has its own raw source, origin label, summary nodes, search hits and exact source offsets. `lcm_sessions` lists conversations across harnesses (including `harness`, `conversation_id`, `name`, `name_source`, `summary_count`, `total` and `next_offset`). Call `lcm_resolve_session` with an exact name or original/internal ID and optional harness. Duplicate names return multiple candidates: choose the ID rather than guessing. Existing alpha.5 indexes retain their nodes and IDs; older title fields become durable on the next hook/index event, or can be assigned with the explicit `name <session> "title"` CLI command. Page `lcm_summaries` with its `next_offset` to read **all** of that conversation’s nodes, then verify important claims with `lcm_describe` and `lcm_expand`. The short overview is not a complete summary list.

For Codex on the **same machine and user index**, register the same stdio server once (example command; the package does not run it for you):

```bash
codex mcp add superlcm -- node /ABSOLUTE_PATH_TO_REPO/src/cli.js mcp
```

Then ask Codex: “Resolve the Claude Code conversation named X, call lcm_context to bring its navigation directly into this turn, and verify decision Y against source events.” **MCP registration alone does not auto-ingest Codex history**: to capture Codex conversations automatically, configure the Codex lifecycle hooks below. For unsupported harnesses, import a user-exported UTF-8 `.txt` or portable `.jsonl` of `{"role":"user|assistant","content":"..."}` messages (Codex rollout `response_item` / `event_msg` messages are also recognized):

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

Codex requires a user to review and trust new/changed non-managed hooks with `/hooks`; do **not** bypass trust. `SessionStart` and `UserPromptSubmit` first index complete local JSONL records, so an opted-in current-session agent can call `lcm_summary_work` and `lcm_save_summary` **during that turn** once a deterministic batch is ready; `Stop`/`PostCompact` also index and may spawn a separately selected background summary worker, while `SessionEnd` catches the final tail. A transcript that is absent or still lagging stays pending until a later hook; no data is invented. `SessionStart(compact)` injects only short navigation **after Codex native compaction**; `UserPromptSubmit`/`SessionStart` can offer explicitly queued cross-conversation packets, and `UserPromptSubmit` may nudge optional agent-mode summarization. Transcript path must be under `$CODEX_HOME/sessions/` (default `~/.codex/sessions/`) or the session working directory’s `.codex/` folder. A null transcript path skips **ingestion**, but a previously indexed target can still receive queued context; changed source hashes fail closed. The source key `codex-<session_id>` and the original `session_id` are both recorded.

Claude Code captures its `custom-title`/`ai-title` transcript records when present (custom title takes precedence); otherwise it derives a title from the first visible user message. Titles use Codex’s native name/title from its local state SQLite **when its optional read-only schema and exact rollout path match**; otherwise they derive from the first visible user message. Since that internal SQLite schema is not a stable API, you can override any title without changing the source transcript: `node /ABSOLUTE_PATH_TO_REPO/src/cli.js name <session_key> "Human title"`. A manual title wins over later hook updates. The `lcm_name_session` MCP write is disabled unless you explicitly enable `SUPERLCM_ALLOW_MCP_RENAME=1`; lookup through `lcm_resolve_session` is read-only.

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

`Stop`/`PostCompact` asynchronously index complete JSONL records and, when a batch is ready, start the selected background worker. `SessionStart(compact)` adds only compact navigation for retrieval after Claude's native compaction. `UserPromptSubmit` offers selected target deliveries and nudges summarization **only** when that harness (or its inherited global setting) explicitly selects `agent` mode. It cannot ensure the model calls tools.

## Summary modes for Claude Code CLI and Desktop Code (Local)

The default `SUPERLCM_SUMMARY_MODE=auto` chooses `cli` without a dedicated API key, or `api` when `SUPERLCM_ANTHROPIC_API_KEY` is set. `SUPERLCM_SUMMARY_MODE=cli|codex-cli|api|agent|off|auto` can explicitly select a backend or turn summaries off. Explicit `cli` wins even if a dedicated API key exists; that key is stripped from the CLI subprocess. Explicit `codex-cli` starts a separate logged-in Codex CLI, while explicit `agent` enables the active session to call `lcm_summary_work` and `lcm_save_summary`. Agent mode is advisory and defaults off, including with an API key; it changes the former legacy `agent` alias semantics. Existing summary nodes are preserved.

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

Use `SUPERLCM_SUMMARY_MODE=agent` or select current-session agent for a harness/global default in the Web console; this is **off by default**. A `UserPromptSubmit` hook can include a bounded advisory nudge. If the active model chooses to invoke MCP, `lcm_summary_work` assigns a deterministic batch and `lcm_save_summary` verifies original hashes before saving its summary; no direct write without this mode. The host may ignore the nudge or not call tools. The local stdio MCP cannot authenticate a specific calling conversation, so the stored model label is `mcp-agent`, not proof that the named source session itself authored it; any trusted client sharing the index may call these tools for any indexed session whose harness/global policy opts in. This is not a guaranteed automatic summary or a replacement for native compaction.

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

The second command uses the configured backend: the locally logged-in Claude CLI by default, or the explicit API credentials in API mode. You must explicitly supply/import an ordinary Chat transcript; MCP cannot capture that tab's hidden history. You may also omit summaries and search original lines directly. `lcm_import` is disabled inside MCP unless `SUPERLCM_IMPORT_DIR` names a trusted local folder; it refuses escaping symlinks/paths. `lcm_index` is disabled inside MCP unless `SUPERLCM_ALLOW_MCP_INDEX=1`; hooks and the explicit CLI indexing command work without that setting. Never expose this stdio server remotely or give it broad filesystem access.

## Tool contract and current limitations

- `lcm_sessions` returns paginated source harness, original ID, name and summary counts; `lcm_resolve_session` finds exact name or ID with ambiguity reporting. All other read tools require an explicit `session` (MCP has no implicit access to any host's current conversation ID).
- `lcm_context`: directly return a bounded source-labelled packet to the **calling** MCP agent. `lcm_enqueue_context`: queue one source for an **indexed target** only if `SUPERLCM_ALLOW_MCP_DELIVERY=1` explicitly enables MCP mutations (the authenticated Web queue works without it); let its hook offer it later; `lcm_delivery_status`: pending/issued receipts.
- `lcm_summary_work` and `lcm_save_summary`: optional active-agent work/save, gated by agent mode and verified source hashes.
- `lcm_summaries`: paginated **full per-session summary list** with source provenance; `lcm_overview`: small top-layer navigation; `lcm_search`: original event text and summary search; `lcm_read_event`: exact raw record by event ordinal, including unsummarized tail; `lcm_describe`: node relationships and source range; `lcm_expand`: **exact original record bytes decoded as UTF-8**, paginated by returned `next.ordinal` and `next.charOffset`; `lcm_doctor`: verify source pointers and SQLite integrity, read-only.
- Import/index are side-effecting, explicit, local operations. They do not replace native context compaction. There is no claim that original JSONL contains model-internal hidden state; "exact" means the retained on-disk source record. Search indexes visible user/assistant text (not every tool-result field), while expansion returns the full retained record.
- A modified/truncated source is not silently reindexed. Expansion verifies the raw SHA-256 and fails closed if changed. The per-source cap is 256 MiB, per-JSONL-line cap 4 MiB, and manual import cap 32 MiB. Session IDs isolate records. The implementation accepts both legacy MCP `initialize` and current `2026-07-28` `server/discover` request formats; actual Claude/Codex client interoperability still needs testing on target installations.

## Documentation consulted

- Claude Code hooks and async transcript caveat: https://code.claude.com/docs/en/hooks
- Claude Code JSONL sessions: https://code.claude.com/docs/en/how-claude-code-works
- Claude Code MCP config: https://code.claude.com/docs/en/mcp
- Claude connector limits: https://claude.com/docs/connectors/overview
- Current MCP discovery, tools: https://modelcontextprotocol.io/specification/2026-07-28/server/discover and https://modelcontextprotocol.io/specification/2026-07-28/server/tools

Native Claude metadata probing can refresh its own cachedGrowthBookFeatures, cachedGrowthBookFeaturesAt and cachedExperimentData fields in .claude.json. It does not send a model prompt. The browser test compares real user settings after excluding only those observed runtime-cache fields; all MCP, hook, model and trust configuration remains included in the comparison.
