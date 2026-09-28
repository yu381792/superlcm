# alpha.12 verification — 2026-09-23

- `npm run validate`: **53 passed, 0 failed**, exit 0.
- `python3 scripts/test-ui.py`: real Chrome desktop/mobile, four views, zero unexpected browser errors, exit 0.
- Indexed source → selected target → actual stdio MCP pickup → Web receipt updated. No source nodes merged into the target DAG.
- Actual Claude initialization reported **18 MCP tools / connected**, with no model prompt; registration used temporary homes. Existing user-session reload is not implied.
- Connect dialog immediately visible; injected configuration failure remained visible and actionable rather than appearing to do nothing.
- Opening import generated **0 native scan or ingestion requests**; index-source shortcut selected the correct saved conversation.
- Actual target hook emitted the full saved navigation beyond the former 2200-character clipping limit.
- Offline tests exclude diagnostic peers, failed calls, closed clients and expired heartbeats from active connection evidence.
- Pack dry-run includes new connection/frontend modules and no user index/config/credential artifacts.

Real user MCP/hook/model/trust settings were not changed. Native Claude may refresh the same three feature-cache fields documented below. No paid inference, real-user auto-install, repository visibility change or native trust bypass occurred.

---

# alpha.11 verification — 2026-09-23

## Completed on macOS, Node 22

| Check | Evidence | Exit |
|---|---|---|
| npm run validate | 45 tests passed, 0 failures | 0 |
| npm pack --dry-run | UI JS/CSS present; only source/docs/package artifacts | 0 |
| git diff --check | No whitespace errors | 0 |
| python3 scripts/test-ui.py | Actual installed Chrome, four views at 1440px and 390px, zero browser errors | 0 |
| Codex official MCP setup in temporary CLI home | Registered via codex mcp add; matching launch/index; 17 tools in real stdio handshake | 0 |
| Claude official MCP setup in temporary CLI home | Registered via claude mcp add-json; matching launch/index; 17 tools in real stdio handshake | 0 |
| Actual hook subprocesses | Both adapters wrote 8 fixture records, 0 summary nodes, valid pointers | 0 |
| Generated hook command | Spaces/apostrophe path accepted; explicit index home overrides surrounding environment | 0 |

Browser workflows cover: source node reading, selected local conversation indexing, source/target harness selection, queued delivery, real Codex and Claude catalog selection/save, reviewed setup and per-row diagnostics. Installation/setting writes use temporary roots. Native user MCP/hook/model/trust settings were unchanged; comparison excludes only three observed Claude feature-cache fields refreshed by metadata initialization.

Real local read-only discovery found Codex 0.155.1, Claude Code 2.1.280, Hermes 0.21.3 and Pi 0.86.1. Native readers accessed their configured roots without bulk import. Unit fixtures verify Hermes immutable snapshots, Pi branch ancestry, deduplication and original identity retention.

## Not claimed

- No paid API call, subscription inference or token-consuming summary generation was tested.
- No native hook trust was forged. Test fixture setup is not proof of a live user session trusting or loading those hooks.
- No proof that a live model consumed queued context; queued/hook-issued states remain distinct.
- Real Linux/Windows installation was not tested here; cross-platform CI remains a release prerequisite.
- The GitHub repository is public (2026-09-28); npm publication was not changed.

Repeatable commands and scope: [console contract](CONSOLE.md).

## Cross-tool handoff (2026-09-28, real tools on macOS)

Each tool was asked to `lcm_continue` a conversation captured by another tool, then `lcm_read` one record; every quoted record matched the archive byte for byte.

- Claude Code continued Codex conversation #1bc05 and read record 3.
- Codex continued Claude Code conversation #64b3a and read record 2.
- Hermes continued Claude Code conversation #64b3a and read record 2.
- Codex continued a summarized Claude Code conversation (2 levels, 18 summaries), answered a detail from the outline and quoted the source record by number.
- Pi continued the same summarized conversation, received the level-2 outline and found the same detail in the quoted record.
