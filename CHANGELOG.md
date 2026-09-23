# Changelog

## 0.1.0-alpha.11

- Redesign the four console views around shared real local harness detection, grouped conversation selection, actual saved-node inspection, per-row diagnostics and reviewed setup.
- Replace Claude help examples and implicit Codex cache lists with real runtime model catalogs; retain provider/model and context suffix IDs with visible fallback status.
- Detect Hermes and Pi; import selected immutable native snapshots (Pi latest-leaf ancestry only), without falsely claiming automatic MCP/hook integration.
- Add official-CLI MCP registration, private config backups, stale-preview/conflict refusal and hook merging; native trust remains with the host.
- Add portable contribution/security/capability documents and repeatable offline plus opt-in actual Chrome/CLI tests.

## 0.1.0-alpha.10

- Index Codex transcript records at SessionStart and UserPromptSubmit (when a valid transcript_path exists), before the active agent needs to call the gated summary work/save tools; keep Stop/PostCompact tail ingestion.
- No change to the separate allowlisted lcm_import gate; agent summary writes still require selected agent mode, a real indexed session, and verified source hashes.

## 0.1.0-alpha.9

- Replace invisible subscription datalist with a selectable CLI model list plus manual ID entry; implement Web custom API provider, endpoint, model ID and write-only scoped key fields.
- Support Anthropic Messages and OpenAI-compatible Chat Completions in the actual background worker, store credentials in a separate private file, and test a non-billed loopback worker invocation.

## 0.1.0-alpha.8

- Replace conversation-scoped model settings with a global default and per-configured/observed-harness overrides. Legacy per-session rows remain but no longer route summary workers or agent tools.
- Auto-read local Codex CLI model cache and Claude CLI documented aliases into model suggestions without a model request. Label configuration and past activity separately from live connectivity; custom API remains Anthropic Messages-compatible.

## 0.1.0-alpha.7

- Add local authenticated Web console inspired by the 8790 asset center: named source/target selection, bounded summary preview, queued hook injection, receipt states, per-session summary backends and an actual local MCP handshake test button.
- MCP `lcm_context` returns a bounded navigation packet directly to the calling agent; `lcm_enqueue_context` queues cross-conversation delivery. Claude/Codex hooks can offer queued packets on next prompt/start. No claim of forced model use.
- Add isolated `codex exec --json --ephemeral` summarization backend and optional main-agent summary work/save tools, gated per session with source hash verification. Main-agent mode is off by default.

## 0.1.0-alpha.6

- Add Codex CLI Stop/PostCompact/SessionEnd hook adapter with bounded local transcript paths, independent session IDs and background summaries; Codex compaction stays native.
- Persist original harness and conversation ID with native Claude/Codex title records when available and derived/manual title precedence. Resolve by exact name or ID without guessing ambiguous titles; expose provenance on summaries and source reads.
- Skip model calls for metadata-only transcript batches and migrate prior alpha.5 session metadata in place.

## 0.1.0-alpha.5

- Make the local MCP store cross-harness: preserve session origin, support portable and Codex-shaped JSONL imports, and expose paginated independent summary nodes per conversation to any MCP client.
- Add Codex MCP registration guidance and retain the existing SQLite home/config path for existing Claude indexes. Automatic capture remains Claude-specific until another harness supplies a transcript adapter.

## 0.1.0-alpha.4

- Replace main-agent summary writing with an isolated background Claude CLI subprocess using the local subscription login and configurable `SUPERLCM_CLAUDE_CLI_MODEL`; retain explicitly selected API mode.
- Remove agent summary MCP tools and prompt-injection hook; guard recursive hooks and API/environment leakage. Legacy `agent` mode settings map to the background worker without deleting old nodes.

## 0.1.0-alpha.3

- Select agent mode by default and switch exclusively to API mode when the dedicated summarizer key is configured; suppress prompts and gate agent MCP writes to prevent duplicate summaries.
- Persist the hook-selected mode per session so separately launched MCP processes enforce the same policy.

## 0.1.0-alpha.2

- Add optional active-Claude summary work and validated hierarchical persistence; keep API-backed background summaries as a separate mode.
- Support local Claude Code sessions in the Desktop Code tab using the same hooks and MCP configuration.

## 0.1.0-alpha.1

- Extract Claude Code CLI and Desktop recall adapter as an independent package with no DSH compaction integration.
