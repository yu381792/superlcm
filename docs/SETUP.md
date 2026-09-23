# SuperLcm — cross-harness conversation recall (preview)

This is an **independent cross-harness MCP package (not a DSH plugin)**. It does not replace any harness's native compaction. It builds an external layered summary DAG and retrieves the original conversation on demand. Summary modes are exclusive: default `auto` uses a separate `claude --print` subprocess (`cli` mode) with selectable model, and a dedicated `SUPERLCM_ANTHROPIC_API_KEY` selects the separate paid `api` backend. Explicit `off` disables summaries. The active Claude agent never writes summaries. Claude Code and Codex CLI each have an opt-in automatic hook adapter; other harnesses need an explicit export/import or their own adapter. No harness configuration is modified by the package.

## Requirements and data ownership

- Node.js 22.16+ (`node:sqlite`), local stdio MCP, no additional runtime dependencies or always-on service.
- Claude Code CLI sessions: original source is Claude Code's local JSONL under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`). Hook `transcript_path` may lag behind the current in-memory turn; indexing waits for complete JSONL lines. The index never modifies the transcript.
- Ordinary Claude Desktop chat: MCP does **not** expose the whole chat transcript. You must explicitly export a conversation to a `.jsonl` or UTF-8 `.txt` file and import it. A `.txt` file is copied byte-for-byte and each line (including newlines) is indexed as an exact source event; no claim is made that a partial export contains every chat message. Claude Code sessions inside the Desktop application follow the Code path only when their hooks and transcript are accessible.
- For compatibility, the shared local index still defaults to `~/.superlcm-claude/lcm.sqlite` and imported originals to `~/.superlcm-claude/imports/`; override with `SUPERLCM_HOME` (the old `SUPERLCM_CLAUDE_HOME` remains supported). Point all local MCP clients at the **same** home. Files are created with private permissions. SQLite contains source byte offsets, SHA-256 hashes, searchable text and summaries. It is **not** the authoritative original conversation. Do not delete the source Claude Code JSONL if you need exact expansion. Imported originals are retained inside the private directory. Stored summary nodes are idempotent: changing the model affects future batches, not already saved nodes.
- Indexed text and summaries can contain secrets. Keep the index local and restrict filesystem backups and permissions. In `cli` mode, bounded excerpts go to a separate Claude CLI subprocess using that machine's own login and subscription allowance (subject to its configured auth/billing and usage limits). `api` mode sends them to the explicitly selected HTTPS endpoint and incurs separate API billing. Neither mode asks the main agent to write summaries.

## Shared conversations across harnesses

The storage and read-only MCP tools are **harness-independent**. Each session ID has its own raw source, origin label, summary nodes, search hits and exact source offsets. `lcm_sessions` lists conversations across harnesses (including `harness`, `conversation_id`, `name`, `name_source`, `summary_count`, `total` and `next_offset`). Call `lcm_resolve_session` with an exact name or original/internal ID and optional harness. Duplicate names return multiple candidates: choose the ID rather than guessing. Existing alpha.5 indexes retain their nodes and IDs; older title fields become durable on the next hook/index event, or can be assigned with the explicit `name <session> "title"` CLI command. Page `lcm_summaries` with its `next_offset` to read **all** of that conversation’s nodes, then verify important claims with `lcm_describe` and `lcm_expand`. The short overview is not a complete summary list.

For Codex on the **same machine and user index**, register the same stdio server once (example command; the package does not run it for you):

```bash
codex mcp add superlcm -- node /ABSOLUTE_PATH_TO_REPO/src/cli.js mcp
```

Then ask Codex: “Resolve the Claude Code conversation named X, page its summaries, and verify decision Y against source events.” **MCP registration alone does not auto-ingest Codex history**: to capture Codex conversations automatically, configure the Codex lifecycle hooks below. For unsupported harnesses, import a user-exported UTF-8 `.txt` or portable `.jsonl` of `{"role":"user|assistant","content":"..."}` messages (Codex rollout `response_item` / `event_msg` messages are also recognized):

```bash
node /ABSOLUTE_PATH_TO_REPO/src/cli.js import /path/to/export.jsonl codex-my-session codex
node /ABSOLUTE_PATH_TO_REPO/src/cli.js summarize codex-my-session   # optional; invokes the configured model
```

If JSONL contains no visible user/assistant text, import rejects it; use a readable `.txt` export instead. Imports copy the original into the private index, preserving exact expansion if the exported file moves. For manual imports, harness and session ID are user-supplied provenance labels, not independently verified native IDs. The source harness, reading harness, and summarizer backend (`cli` or `api`) are independent.

## Codex CLI automatic conversation capture (opt-in)

Codex CLI 0.155.1 exposes command hooks with `session_id` and `transcript_path` ([official hook contract](https://learn.chatgpt.com/docs/hooks.md)); the local rollout format is **not a stable hook API**, so upgrades can require parser changes. Merge the following into your **own** `~/.codex/hooks.json` on the machine running Codex; this package never writes that file:

```json
{
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js codex-hook", "timeout": 15}]}],
    "PostCompact": [{"hooks": [{"type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js codex-hook", "timeout": 15}]}],
    "SessionStart": [{"matcher": "compact", "hooks": [{"type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js codex-hook", "timeout": 15}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js codex-hook", "timeout": 3}]}]
  }
}
```

Codex requires a user to review and trust new/changed non-managed hooks with `/hooks`; do **not** bypass trust. `Stop`/`PostCompact` index only complete local JSONL records and spawn a separate summary worker if a meaningful batch is ready; `SessionEnd` catches the final tail. `SessionStart(compact)` injects only short navigation **after Codex native compaction**. Transcript path must be under `$CODEX_HOME/sessions/` (default `~/.codex/sessions/`) or the session working directory’s `.codex/` folder. A null transcript path is skipped, and changed source hashes fail closed. The source key `codex-<session_id>` and the original `session_id` are both recorded.

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
    "SessionStart": [{ "matcher": "compact", "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook" }] }]
  }
}
```

`Stop`/`PostCompact` asynchronously index complete JSONL records and, when a batch is ready, start the selected background worker. `SessionStart(compact)` adds only compact navigation for retrieval after Claude's native compaction. There is no `UserPromptSubmit` summary nudge; existing installations may leave that old hook in place, but it no longer injects a writing prompt. Remove it from your own configuration when convenient.

## Summary modes for Claude Code CLI and Desktop Code (Local)

The default `SUPERLCM_SUMMARY_MODE=auto` chooses `cli` without a dedicated API key, or `api` when `SUPERLCM_ANTHROPIC_API_KEY` is set. `SUPERLCM_SUMMARY_MODE=cli|api|off|auto` can explicitly select a backend or turn summaries off. Explicit `cli` wins even if a dedicated API key exists; that key is stripped from the CLI subprocess. The old `agent` value is accepted as a compatibility alias, but **maps to `cli`** (or `api` when a dedicated key is set); agent-authored MCP summary tools have been removed. Existing summary nodes are preserved.

### CLI subscription backend (default, no separate API key)

Install and log into the `claude` CLI on **the same machine that runs the hook**, including Windows for Desktop Code Local. The hook starts a background worker that runs `claude --print` with a selectable model:

```text
SUPERLCM_SUMMARY_MODE=cli
SUPERLCM_CLAUDE_CLI_MODEL=sonnet
# Optional, if claude is not on PATH: SUPERLCM_CLAUDE_CLI_BIN=/absolute/path/to/claude
```

`sonnet` is the default model alias; set `SUPERLCM_CLAUDE_CLI_MODEL` to another installed CLI-supported model or alias (for example `opus` or `claude-sonnet-5`). CLI login/subscription usage and model availability are controlled by Claude Code, not MCP. The child disables built-in tools and MCP (`--tools '' --strict-mcp-config`), runs in a private scratch directory under the SuperLcm index home (keep that home outside projects), strips API/cloud-routing environment variables, and marks inherited SuperLcm hooks so they cannot recurse. No `--bare` is used (it can change CLI authentication). User-level Claude instructions and other hooks may still apply; confirm the `claude` CLI's own login and billing selection before relying on subscription billing. Summary failures set `summary_error`; completed raw records remain searchable.

### Explicit API backend

Provide both credentials in the environment launching Claude Code, not only in MCP server configuration:

```text
SUPERLCM_SUMMARY_MODE=api  # optional when a dedicated key is already set
SUPERLCM_CLAUDE_MODEL=<explicit Anthropic model ID>
SUPERLCM_ANTHROPIC_API_KEY=<separate API credential; never commit it>
```

The namespaced key avoids changing Claude Code authentication via the generic `ANTHROPIC_API_KEY`. API requests go to `https://api.anthropic.com/v1/messages` by default; `SUPERLCM_CLAUDE_API_URL` may select a clean HTTPS origin. A missing key or model sets `summary_unconfigured` without falling back to another backend. The legacy `SUPERLCM_SUMMARIZE_ON_HOOK=1` chooses API if the main mode is unset. All summaries use bounded eight-record batches, four-child parent nodes and source pointers. A fresh tail stays directly searchable before a batch is ready.

`node src/cli.js summarize <session_id>` performs an explicit one-off summary of **any imported conversation** using the selected backend. `index` never invokes a summarizer. Background jobs persist status (`ok`, `summary_unconfigured`, `summary_error`) and `lcm_sessions` shows the selected mode. No model calls are made merely by listing or searching.

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
- `lcm_summaries`: paginated **full per-session summary list** with source provenance; `lcm_overview`: small top-layer navigation; `lcm_search`: original event text and summary search; `lcm_read_event`: exact raw record by event ordinal, including unsummarized tail; `lcm_describe`: node relationships and source range; `lcm_expand`: **exact original record bytes decoded as UTF-8**, paginated by returned `next.ordinal` and `next.charOffset`; `lcm_doctor`: verify source pointers and SQLite integrity, read-only.
- Import/index are side-effecting, explicit, local operations. They do not replace native context compaction. There is no claim that original JSONL contains model-internal hidden state; "exact" means the retained on-disk source record. Search indexes visible user/assistant text (not every tool-result field), while expansion returns the full retained record.
- A modified/truncated source is not silently reindexed. Expansion verifies the raw SHA-256 and fails closed if changed. The per-source cap is 256 MiB, per-JSONL-line cap 4 MiB, and manual import cap 32 MiB. Session IDs isolate records. The implementation accepts both legacy MCP `initialize` and current `2026-07-28` `server/discover` request formats; actual Claude/Codex client interoperability still needs testing on target installations.

## Documentation consulted

- Claude Code hooks and async transcript caveat: https://code.claude.com/docs/en/hooks
- Claude Code JSONL sessions: https://code.claude.com/docs/en/how-claude-code-works
- Claude Code MCP config: https://code.claude.com/docs/en/mcp
- Claude connector limits: https://claude.com/docs/connectors/overview
- Current MCP discovery, tools: https://modelcontextprotocol.io/specification/2026-07-28/server/discover and https://modelcontextprotocol.io/specification/2026-07-28/server/tools
