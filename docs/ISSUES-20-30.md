# Claude Code issue patch integration

Integrated on 2026-11-14 against upstream 0.6.1, using the contributor's existing implementation rather than a replacement subsystem. Work is in `/Users/yu/superlcm` (the ChatGPT workspace is a separate scratch repository).

## Sources

All contributed patches below are by [@muxammadreza](https://github.com/muxammadreza). Their MIT-licensed fork was fetched and compared to the current upstream tree.

| Issue | Adopted implementation |
| --- | --- |
| [#20](https://github.com/yu381792/superlcm/issues/20) | [817be49](https://github.com/muxammadreza/superlcm/commit/817be49): compute Claude's actual compaction threshold for packet planning, preparation and pressure checks |
| [#21](https://github.com/yu381792/superlcm/issues/21) | [e96982f](https://github.com/muxammadreza/superlcm/commit/e96982f): size tool results from model-visible text rather than raw tool metadata |
| [#22](https://github.com/yu381792/superlcm/issues/22) | [3fe259b](https://github.com/muxammadreza/superlcm/commit/3fe259b): resolve parent packet coverage for continued sessions, with exact-source verification |
| [#23](https://github.com/yu381792/superlcm/issues/23) | [e96982f](https://github.com/muxammadreza/superlcm/commit/e96982f), [3fe259b](https://github.com/muxammadreza/superlcm/commit/3fe259b): idle cache-expiry compaction using transcript, TTL and cache touches |
| [#24](https://github.com/yu381792/superlcm/issues/24) | [2906951](https://github.com/muxammadreza/superlcm/commit/2906951): turn-end compaction only when a verified packet at least halves context |
| [#25](https://github.com/yu381792/superlcm/issues/25) | [04d6a4e](https://github.com/muxammadreza/superlcm/commit/04d6a4e), [d07e7d1](https://github.com/muxammadreza/superlcm/commit/d07e7d1): cached host prompts, in-session model fork claims and transcript verification before saving |
| [#26](https://github.com/yu381792/superlcm/issues/26) | [b326ce0](https://github.com/muxammadreza/superlcm/commit/b326ce0): explicit ordered custom-API fallbacks, cooldown and actual writer attribution |
| [#27](https://github.com/yu381792/superlcm/issues/27) | [d163683](https://github.com/muxammadreza/superlcm/commit/d163683): keep the stable entry on an installed newer plugin copy |
| [#28](https://github.com/yu381792/superlcm/issues/28) | [357ba1a](https://github.com/muxammadreza/superlcm/commit/357ba1a), [9567d58](https://github.com/muxammadreza/superlcm/commit/9567d58): distinguish harness bookkeeping from dialogue, project queued prompts, recertify eligible old summaries |
| [#29](https://github.com/yu381792/superlcm/issues/29) | [4ab04bc](https://github.com/muxammadreza/superlcm/commit/4ab04bc), [72fabc2](https://github.com/muxammadreza/superlcm/commit/72fabc2): compare visible tool results, canonicalize parallel tool ordering, honor native preserved segments and record mismatch diagnostics |
| [#30](https://github.com/yu381792/superlcm/issues/30) | [8c0c20b](https://github.com/muxammadreza/superlcm/commit/8c0c20b): ordered takeover-copy matching, per-conversation archive preview repair, transcript-only command caveats and coverage-lag classification |

## Adaptation boundaries

- Selected relevant source and test changes; retained upstream's newer Pi/DSH engine, fork budgets and retry handling. Did not import the fork's release version numbers.
- Retained fail-closed behavior for images, unknown blocks and changed tool payloads. Mixed tool-result blocks keep their full structure during verification.
- Claude summary work sends full oversized text records to the writer, rather than silently certifying a shortened head/tail excerpt. Provider capacity/input limits can still reject an oversized record; originals remain preserved.
- Old marked reduced summaries remain navigation-only. Queued prompts are detected from parsed JSON, including formatted JSON, and are not retrospectively certified as having been read.
- Fallback models are opt-in per harness; an empty list keeps the single-model route.
- Archive repair and recertification were exercised only on isolated test archives. Existing user databases and running hosts were not opened for migration during this task.

## Verification

The contributed tests and new regression cases cover repeated `/compact`, coverage gaps, long tool output, queued prompts, parallel tool calls, native preserved segments, image/unknown-content refusal, actual thresholds, cold/turn-end eligibility, explicit API fallback selection and cleanup, host fork claim ownership/source changes, and stable-entry version ordering.

Commands and final counts are recorded below after completion. All inference responses in these tests are fixtures; no live model was called.

Final verification:

- `npm run validate`: syntax check passed for 255 JavaScript files; 865 tests, 864 passed, 1 failed. The sole failure is `test/dsh-bundled-plugin.test.js:40`, where the installed DSH 0.2.2-rc.1 inventory API expects `readBundles` and the existing fixture lacks it. Reproduced unchanged on a clean archive of the starting commit (4 passed, 1 failed in that test file).
- `node --test test/fork-claude-coverage.test.js`: 15 passed, including all added adaptation checks.
- `node --test test/fork-claude-coverage.test.js test/adapter.test.js`: 57 passed before the final 2 standalone plugin/fallback regression cases were added; both extra cases subsequently passed in the complete suite.
- `npm run test:dsh-runtime`: 254 tests, 113 passed, 141 failed. Repeated against the clean starting revision: identical counts and identical 141 failing test names, including missing installed-host `stateOf` lifecycle support. This is an existing host/test compatibility limitation, not a passing runtime check.
- `npm run test:claude-module`: not performed; the script reports that no installed Claude CLI is discoverable. No native Claude SDK or paid-model integration success is claimed.
- `npm pack --dry-run`: passed.
- `git diff --check`: passed.

Operational scope: source integration into the repository; no release, installed-plugin update or production archive migration was performed. Older issues #1–#19 already have corresponding upstream fixes/tests and were not closed merely because their issue status remains open.
