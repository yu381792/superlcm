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

1. **Local conversation → index.** Read-only discovery; only the selected row is indexed. No mass import or model invocation. Codex/Claude use exact native JSONL pointers. Hermes/Pi keep private immutable visible-message snapshots because their native stores mutate or branch. Exact expansion validates the retained snapshot, not a live database or all Pi branches.
2. **Indexed summary → another conversation.** Select a source harness/conversation and a target harness/conversation. Sources with zero saved nodes cannot be delivered. Queue receipt is not consumption. Unsupported target hooks require direct MCP lcm_context retrieval instead.

MCP lcm_import's arbitrary-file allowlist is independent of known-native-store Web selection and agent-mode lcm_save_summary.

## 模型设置

Harness override → global default → environment fallback; no per-conversation policy.

- Codex: actual debug models response. Cache fallback is marked cached, not live; hidden entries stay hidden.
- Claude: initialize.models control response only, without user prompts, inference, tools, hooks, MCP servers or persisted model sessions. Help examples are not a model directory.
- Preserve actual IDs including provider/model and opus[1m]; show Claude resolvedModel aliases.
- Catalog response is not entitlement or inference success. Isolated workers may not inherit user custom-provider routes; do not promise all listed models work through a subscription.
- API fields include protocol, endpoint, model ID and a write-only scoped key. Saving never invokes a model.

## MCP连接 and installation

Each row shows CLI/version, MCP match, hooks, last hook activity and self-reported handshake. Supported-adapter tests match the known launch command/index, perform real stdio initialize/tools-list, and execute an actual hook against an isolated temporary fixture. Other adapters test only their implemented detection/read capabilities.

接入 / 修复 previews affected paths and commands. Confirmation backs up files privately, uses official CLI registration and merges missing SuperLcm hooks. It preserves unrelated entries, rejects stale previews and same-name conflicts, and never modifies internal trust. Existing clients may require reload; Codex /hooks review remains a human-native action.

## Tests

    npm run validate
    npm pack --dry-run
    python3 scripts/test-ui.py

The default suite is offline: temporary roots and fake providers, plus actual local Node hook subprocesses. The optional browser test needs Python Playwright, Chrome and installed Codex/Claude CLIs. It reads real catalogs without inference and tests official MCP setup in temporary CLI homes; it checks user config hashes unchanged. SUPERLCM_TEST_CHROME overrides Chrome's path.

Mocks/fixtures are not evidence of a live host calling summary tools or consuming context. Cross-platform CI is a release gate; one Mac run is not Windows/Linux validation. Windows .cmd CLI wrappers may require a platform-specific runner/native executable override.

## Open-source scope

No private paths, credentials, transcripts, account routes or trust state are distributed. Default index remains ~/.superlcm-claude for compatibility; SUPERLCM_HOME overrides it. Node >=22.16, no runtime dependencies. Source remains private until a separate release decision; no npm publication or GitHub visibility change is implied.

Native Claude metadata probing can refresh its own cachedGrowthBookFeatures, cachedGrowthBookFeaturesAt and cachedExperimentData fields in .claude.json. It does not send a model prompt. The browser test compares real user settings after excluding only those observed runtime-cache fields; all MCP, hook, model and trust configuration remains included in the comparison.
