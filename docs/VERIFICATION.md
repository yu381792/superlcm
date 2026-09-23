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
- Hermes/Pi automatic MCP/hook setup is not implemented.
- Real Linux/Windows installation was not tested here; cross-platform CI remains a release prerequisite.
- GitHub repository visibility and npm publication were not changed.

Repeatable commands and scope: [console contract](CONSOLE.md).
