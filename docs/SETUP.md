# SuperLcm for Claude Code and Claude Desktop (preview)

This adapter is **an independent Claude recall package (not a DSH plugin)**. It does not replace Claude native compaction. It builds an external layered summary DAG and retrieves the original conversation on demand. Its source files are in `src/`; no Claude configuration is modified by the package.

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
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook", "async": true }] }],
    "PostCompact": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook", "async": true }] }],
    "SessionStart": [{ "matcher": "compact", "hooks": [{ "type": "command", "command": "node /ABSOLUTE_PATH_TO_REPO/src/cli.js hook" }] }]
  }
}
```

`Stop`/`PostCompact` asynchronously ingest the stable JSONL portion after the reply/compaction. `SessionStart(compact)` adds at most a short index navigation message; it does not replace the host's summary. Before a completed summary exists, it points to exact searchable originals. The hook makes no model calls by default. Claude decides whether to call MCP search; it is not guaranteed to call it automatically. Explicitly ask it to "search the SuperLcm index and expand the original" when details matter.

To explicitly allow *paid external* background summarization after `Stop`/`PostCompact`, configure all three variables **in the environment launching Claude Code**:

```
SUPERLCM_SUMMARIZE_ON_HOOK=1
SUPERLCM_CLAUDE_MODEL=<explicit Anthropic model ID>
SUPERLCM_ANTHROPIC_API_KEY=<separate API credential, never commit it>
```

Use the namespaced `SUPERLCM_ANTHROPIC_API_KEY` rather than Claude Code's `ANTHROPIC_API_KEY`: setting the latter globally can change how Claude Code authenticates and bills. Only setting a model or key is not sufficient: the opt-in switch is mandatory. It calls `https://api.anthropic.com/v1/messages` unless you explicitly supply a clean HTTPS origin as `SUPERLCM_CLAUDE_API_URL`. The summarizer has **no implicit fallback to Claude's active model**. For controlled one-off generation, run `node src/cli.js summarize <session_id>` after explicitly setting model and key. Summaries cover completed batches (default 8 messages, then fanout 4); a short or still-growing tail remains searchable as exact originals without a premature invented summary. A crashed summarizer sets `summary_error` in session status; consult `lcm_doctor` and retry explicitly. Hooks do not interrupt a native compaction on summarization failure.

## Claude Desktop ordinary chat

Configure the same local stdio server under `mcpServers` in Claude Desktop's MCP configuration using the server stanza above. This grants **retrieval**, not access to the current chat's hidden history. To add an export yourself:

```
node /ABSOLUTE_PATH_TO_REPO/src/cli.js import /absolute/path/to/export.txt desktop-my-chat
node /ABSOLUTE_PATH_TO_REPO/src/cli.js summarize desktop-my-chat
```

The second command requires your explicit model and API key and incurs provider usage. You can also omit it and search imported original lines directly. `lcm_import` is disabled inside the MCP server unless you explicitly set `SUPERLCM_IMPORT_DIR` to a trusted local folder; it refuses paths outside that folder, including symlinks that escape it. `lcm_index` is disabled inside MCP unless `SUPERLCM_ALLOW_MCP_INDEX=1`; Claude Code hooks and the explicit CLI indexing command work without that setting. Do not expose this stdio server remotely or give it broad filesystem access.

## Tool contract and current limitations

- `lcm_sessions` lists available sessions; all other read tools require an explicit `session` (MCP has no implicit access to Claude's current session ID).
- `lcm_overview`: small top-layer navigation; `lcm_search`: original event text and summary search; `lcm_read_event`: exact raw record by event ordinal, including unsummarized tail; `lcm_describe`: node relationships and source range; `lcm_expand`: **exact original record bytes decoded as UTF-8**, paginated by returned `next.ordinal` and `next.charOffset`; `lcm_doctor`: verify source pointers and SQLite integrity, read-only.
- Import/index are side-effecting, explicit, local operations. They do not replace native context compaction. There is no claim that original JSONL contains model-internal hidden state; "exact" means the retained on-disk source record. Search indexes visible user/assistant text (not every tool-result field), while expansion returns the full retained record.
- A modified/truncated source is not silently reindexed. Expansion verifies the raw SHA-256 and fails closed if changed. The per-source cap is 256 MiB, per-JSONL-line cap 4 MiB, and manual import cap 32 MiB. Session IDs isolate records. The implementation accepts both legacy MCP `initialize` and current `2026-07-28` `server/discover` request formats; actual Claude Desktop/Code interoperability still needs testing on the target installations.

## Documentation consulted

- Claude Code hooks and async transcript caveat: https://code.claude.com/docs/en/hooks
- Claude Code JSONL sessions: https://code.claude.com/docs/en/how-claude-code-works
- Claude Code MCP config: https://code.claude.com/docs/en/mcp
- Claude connector limits: https://claude.com/docs/connectors/overview
- Current MCP discovery, tools: https://modelcontextprotocol.io/specification/2026-07-28/server/discover and https://modelcontextprotocol.io/specification/2026-07-28/server/tools
