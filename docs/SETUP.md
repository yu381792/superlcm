# SuperLcm for Claude Code CLI and Desktop Code (preview)

This adapter is **an independent Claude recall package (not a DSH plugin)**. It does not replace Claude native compaction. It builds an external layered summary DAG and retrieves the original conversation on demand. Summary modes: `off` (default), `agent` (active Claude writes nodes via MCP, no extra API key), and `api` (explicit paid background model). Agent mode depends on Claude calling tools and is not guaranteed automatic. Its source files are in `src/`; no Claude configuration is modified by the package.

## Requirements and data ownership

- Node.js 22.16+ (`node:sqlite`), local stdio MCP, no additional runtime dependencies or always-on service.
- Claude Code CLI sessions: original source is Claude Code's local JSONL under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`). Hook `transcript_path` may lag behind the current in-memory turn; indexing waits for complete JSONL lines. The index never modifies the transcript.
- Ordinary Claude Desktop chat: MCP does **not** expose the whole chat transcript. You must explicitly export a conversation to a `.jsonl` or UTF-8 `.txt` file and import it. A `.txt` file is copied byte-for-byte and each line (including newlines) is indexed as an exact source event; no claim is made that a partial export contains every chat message. Claude Code sessions inside the Desktop application follow the Code path only when their hooks and transcript are accessible.
- The local index defaults to `~/.superlcm-claude/lcm.sqlite` and imported originals to `~/.superlcm-claude/imports/`; override with `SUPERLCM_CLAUDE_HOME`. Files are created with private permissions. SQLite contains source byte offsets, SHA-256 hashes, searchable text and summaries. It is **not** the authoritative original conversation. Do not delete the source Claude Code JSONL if you need exact expansion. Imported originals are retained inside the private directory. Summaries can be regenerated with an explicit model; regenerating them does not promise byte-identical text.
- Indexed text and summaries can contain secrets. Keep the index local and restrict filesystem backups and permissions. Summarizer API calls send excerpts to the explicitly selected HTTPS endpoint; nothing is sent by default.

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
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook", "async": true }] }],
    "PostCompact": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook", "async": true }] }],
    "SessionStart": [{ "matcher": "compact", "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook" }] }]
  }
}
```

`Stop`/`PostCompact` asynchronously index complete JSONL records. In `agent` mode, `UserPromptSubmit` indexes the prior completed tail and injects a short nudge when a batch is ready; it does not inject the transcript. `SessionStart(compact)` adds compact navigation and any pending batch ID. Claude may ignore these hints: do not claim guaranteed pre-compaction summaries. You can explicitly request: 'Use lcm_summary_work and lcm_save_summary until no batch remains; verify important source events.'

## Summary modes for Claude Code CLI and Desktop Code (Local)

Set `SUPERLCM_SUMMARY_MODE=off|agent|api` in the environment that starts Claude Code. For project-local settings you may use the `env` field in `.claude/settings.local.json` (merge, do not overwrite existing settings):

```json
{ "env": { "SUPERLCM_SUMMARY_MODE": "agent" } }
```

- `off` (default): local indexing and original search only.
- `agent`: active Claude calls `lcm_summary_work`, writes a factual summary of the returned bounded batch, and calls `lcm_save_summary`. No extra API credential; uses current session context and subscription allowance. Completed batches of 8 records become level-0 nodes, and groups of 4 nodes become parent summaries. Server chooses node IDs, verifies source hashes and rejects stale batches. The hook reminder is advisory, not a guarantee.
- `api`: on `Stop`/`PostCompact`, an asynchronous worker uses an explicit Anthropic API model and separate credential. This incurs separate API billing and never replaces Claude native compaction.

The legacy `SUPERLCM_SUMMARIZE_ON_HOOK=1` still selects `api` if `SUPERLCM_SUMMARY_MODE` is unset. Explicit `off` or `agent` overrides the legacy switch, so hooks do not start both modes. To enable paid API mode, provide all three variables in the environment launching Claude Code:

```text
SUPERLCM_SUMMARY_MODE=api
SUPERLCM_CLAUDE_MODEL=<explicit Anthropic model ID>
SUPERLCM_ANTHROPIC_API_KEY=<separate API credential; never commit it>
```

Use the namespaced credential, not the `ANTHROPIC_API_KEY` variable used by Claude Code: the latter can switch Claude Code authentication and billing. Missing API credentials set `summary_unconfigured` status without interrupting native compaction. API calls go to `https://api.anthropic.com/v1/messages` by default; `SUPERLCM_CLAUDE_API_URL` can name a clean HTTPS origin. There is no implicit active-model fallback. `node src/cli.js summarize <session_id>` is a separate one-off paid action after model and key are set. A failed worker sets `summary_error`; inspect `lcm_doctor`. A short fresh tail stays directly searchable before a complete batch exists.

### Desktop surfaces are different

The Desktop **Code tab in a Local session** uses the same Claude Code engine, MCP settings, and hooks as the CLI. Both modes apply if its transcript is local and the hooks run in that local environment. A Cloud or SSH session runs elsewhere; a local stdio server cannot read the remote transcript. The ordinary Desktop **Chat tab** can use MCP tools but does not expose its entire live chat transcript or Claude Code hooks to this adapter.

This package exposes **local stdio MCP only**. A Windows Desktop connected to another remote MCP via `mcp-remote` does not automatically expose this Mac-only process: install this repo and Node 22.16+ on Windows for a local server, or separately provide a secure remote bridge. Never expose the local transcript index on a public network.

## Optional: ordinary Desktop Chat (not the Code tab)

Configure the same local stdio server under `mcpServers` in Claude Desktop's MCP configuration using the server stanza above. This grants **retrieval**, not access to the current chat's hidden history. To add an export yourself:

```
node /ABSOLUTE_PATH_TO_REPO/src/cli.js import /absolute/path/to/export.txt desktop-my-chat
node /ABSOLUTE_PATH_TO_REPO/src/cli.js summarize desktop-my-chat
```

The second command is for paid API mode only and requires the separate model and API key. For no-key agent mode, import first and ask Claude in the Chat tab to call `lcm_summary_work` and `lcm_save_summary` for that session until no batches remain. Claude uses its active subscription model, but you still must explicitly supply/import transcript content. You may also omit summaries and search the original lines directly. `lcm_import` is disabled inside the MCP server unless you explicitly set `SUPERLCM_IMPORT_DIR` to a trusted local folder; it refuses paths outside that folder, including symlinks that escape it. `lcm_index` is disabled inside MCP unless `SUPERLCM_ALLOW_MCP_INDEX=1`; Claude Code hooks and the explicit CLI indexing command work without that setting. Do not expose this stdio server remotely or give it broad filesystem access.

## Tool contract and current limitations

- `lcm_sessions` lists available sessions; all other read tools require an explicit `session` (MCP has no implicit access to Claude's current session ID).
- `lcm_summary_work` / `lcm_save_summary`: Claude-in-session hierarchical summary with server-chosen node IDs and raw hash checks; `lcm_overview`: small top-layer navigation; `lcm_search`: original event text and summary search; `lcm_read_event`: exact raw record by event ordinal, including unsummarized tail; `lcm_describe`: node relationships and source range; `lcm_expand`: **exact original record bytes decoded as UTF-8**, paginated by returned `next.ordinal` and `next.charOffset`; `lcm_doctor`: verify source pointers and SQLite integrity, read-only.
- Import/index are side-effecting, explicit, local operations. They do not replace native context compaction. There is no claim that original JSONL contains model-internal hidden state; "exact" means the retained on-disk source record. Search indexes visible user/assistant text (not every tool-result field), while expansion returns the full retained record.
- A modified/truncated source is not silently reindexed. Expansion verifies the raw SHA-256 and fails closed if changed. The per-source cap is 256 MiB, per-JSONL-line cap 4 MiB, and manual import cap 32 MiB. Session IDs isolate records. The implementation accepts both legacy MCP `initialize` and current `2026-07-28` `server/discover` request formats; actual Claude Desktop/Code interoperability still needs testing on the target installations.

## Documentation consulted

- Claude Code hooks and async transcript caveat: https://code.claude.com/docs/en/hooks
- Claude Code JSONL sessions: https://code.claude.com/docs/en/how-claude-code-works
- Claude Code MCP config: https://code.claude.com/docs/en/mcp
- Claude connector limits: https://claude.com/docs/connectors/overview
- Current MCP discovery, tools: https://modelcontextprotocol.io/specification/2026-07-28/server/discover and https://modelcontextprotocol.io/specification/2026-07-28/server/tools
