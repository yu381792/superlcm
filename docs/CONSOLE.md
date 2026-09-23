# Console contract and acceptance

## One inventory, four views

All pages share local harness detection: executable, version, configuration, transcript source and capabilities. Installed, configured, historical activity and protocol success are separate facts. No claim of exhaustive detection of every possible agent product.

| Harness | Detect | Select local conversations | Guided MCP + hooks |
|---|---|---|---|
| Codex | CLI/config/root | Native JSONL pointers | Yes; native /hooks review required |
| Claude Code / Desktop Code Local | CLI/config/root | Native JSONL pointers | Yes; host permissions retained |
| Hermes | CLI/config/SQLite | Immutable selected visible-message snapshot | Not implemented; clearly labelled |
| Pi | CLI/config/session root | Latest-leaf ancestry snapshot, no branch mixing | Not implemented; clearly labelled |
| OpenCode / Gemini | Known executable | Not implemented | Not implemented |

Remote/cloud/SSH history is not on this machine. Any configured MCP client can read the shared index, but this does not provide universal auto-capture.

## 对话索引

Group by source harness, retain original names/IDs, page stored nodes and verify original pointers. Statistics count actual nodes across the index. Having raw records does not mean having a summary. Hermes/Pi content versions are distinct snapshots; ambiguous IDs/versions require selection.

## 对话导入

This means **an already-indexed conversation → another conversation context**, never discovery/import of arbitrary current CLI history. Selectors use saved index identities; the source and destination DAGs remain independent.

1. Select a source harness and saved source conversation, preview its source-labelled summary navigation, then choose an indexed destination.
2. Choose hook receipt (Claude/Codex) or explicit target MCP receipt. Confirmation stores an immutable bounded navigation packet and returns pending, not imported/consumed success.
3. Hooks offer the packet on the next prompt/start. Alternatively the target agent calls `lcm_receive_context` with its exact target ID. Receipts distinguish pending, hook-issued and MCP-received; no receipt proves comprehension.
4. A current/new conversation absent from the target list can call `lcm_context` with the source ID using the generated instruction. Complete summaries and originals remain accessible via paginated tools; the initial packet is bounded navigation, not a full transcript dump.

Native collection is now under **对话索引 → 采集管理**. It runs only after an explicit scan action. Opening 对话导入 sends no native scan or ingestion request. The arbitrary-file `lcm_import` allowlist is separate.

## 模型设置

Harness override → global default → environment fallback; no per-conversation policy.

- Codex: actual debug models response. Cache fallback is marked cached, not live; hidden entries stay hidden.
- Claude: initialize.models control response only, without user prompts, inference, tools, hooks, MCP servers or persisted model sessions. Help examples are not a model directory.
- Preserve actual IDs including provider/model and opus[1m]; show Claude resolvedModel aliases.
- Catalog response is not entitlement or inference success. Isolated workers may not inherit user custom-provider routes; do not promise all listed models work through a subscription.
- API fields include protocol, endpoint, model ID and a write-only scoped key. Saving never invokes a model.

## MCP连接 and installation

Clicking **连接** opens a visible modal immediately: loading, errors, paths, confirmation, verification and next steps. No below-fold hidden confirmation. The official CLI writes configuration only after confirmation, with private backups; setup reads it back before readiness. Stale/conflicting previews still fail closed and preserve unrelated settings and native trust.

Claude verification launches a real ephemeral Claude CLI and sends only control `initialize` and `mcp_status`; Claude must report SuperLcm connected. No user prompt, inference, hooks or persistent conversation. This proves a fresh runtime can load the configuration, not that previously opened sessions reloaded it. Codex protocol/hook fixture checks remain labelled self-tests.

Independently observe MCP initialization, live server heartbeats, successful tools/call and connection closure. Diagnostic peers are excluded. Names are self-reported, not authenticated host identity. Existing clients may require /mcp or a new local Code session; native Codex /hooks review remains mandatory. Old SuperLcm processes lack new heartbeat evidence until reloaded.

## Tests

    npm run validate
    npm pack --dry-run
    python3 scripts/test-ui.py

The default suite is offline: temporary roots and fake providers, plus actual local Node hook subprocesses. The optional browser test needs Python Playwright, Chrome and installed Codex/Claude CLIs. It reads real catalogs without inference and tests official MCP setup in temporary CLI homes; it checks user config hashes unchanged. SUPERLCM_TEST_CHROME overrides Chrome's path.

Mocks/fixtures are not evidence of a live host calling summary tools or consuming context. Cross-platform CI is a release gate; one Mac run is not Windows/Linux validation. Windows .cmd CLI wrappers may require a platform-specific runner/native executable override.

## Open-source scope

No private paths, credentials, transcripts, account routes or trust state are distributed. Default index remains ~/.superlcm-claude for compatibility; SUPERLCM_HOME overrides it. Node >=22.16, no runtime dependencies. Source remains private until a separate release decision; no npm publication or GitHub visibility change is implied.

Native Claude metadata probing can refresh its own cachedGrowthBookFeatures, cachedGrowthBookFeaturesAt and cachedExperimentData fields in .claude.json. It does not send a model prompt. The browser test compares real user settings after excluding only those observed runtime-cache fields; all MCP, hook, model and trust configuration remains included in the comparison.

MCP pickup target IDs are supplied by the caller; this shared index is not a per-client access-control boundary. An MCP receipt proves a packet was claimed for that target ID, not authenticated insertion into a particular host conversation.
