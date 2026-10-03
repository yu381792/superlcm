# Changelog

## 0.5.1

- 对照 Lossless Claw 优化 DSH 的长期会话压缩：旧摘要超过预算时，优先把连续同层摘要合成高一层，保留原摘要及完整原文引用；平时维持前缀稳定。
- 后台任务按会话互斥，两个智能体共用同一会话时不会重复生成摘要。账户认证失败暂停该模型路线，显式备用模型仍可使用；其他失败逐步延后重试。
- 后台摘要超时会请求取消，取消未完成时继续占用原任务位置，避免并发追加调用。无有效缩减和已失效的选区继续拒绝提交。

## 0.5.0

- DSH 接入同一套 SuperLcm：原异步压缩引擎作为可选插件迁入，原文和已提交摘要进入共享档案，可与 Claude Code、Codex 双向接续。
- DSH 只使用原压缩引擎生成摘要，归档不会重复调用模型。旧索引只读迁移，保留原库；补录和事件采集在本机后台完成。

## 0.4.23

- Fixed: the compaction notice in 0.4.22 used Claude Code's own after-compaction count, which leaves out the system prompt, tools and rule files every request carries (a real 136K compaction showed 42K while the context still held about 136K). The notice now shows SuperLcm's estimate of the whole context again.

## 0.4.22

- New: after a compaction the conversation shows one line for the user, worded like Claude Code's own: `Conversation compacted · by SuperLcm · 136K → 42K · 19,243 original records kept as #df671` (or `by Claude Code` when SuperLcm handed it back). The sizes are Claude Code's own counts when it has written them, otherwise SuperLcm's estimate. The line follows Claude Desktop's interface language (English in the terminal; `SUPERLCM_UI_LOCALE` overrides).
- Fixed: after its own takeover SuperLcm sometimes still added the retrieval note meant for Claude Code's compaction, because the hook could run before the packet was written to the transcript. The takeover is now recorded when the packet is handed over.

## 0.4.21

- Fixed: the compaction takeover still handed long tool-heavy conversations back to Claude Code's own 70–100 s summary. Two causes, both seen on a real conversation run through Paseo: (1) a stretch of mostly tool calls filled the window while its dialogue stayed under one summary segment, so no summary covered it; the planner now carries such dialogue (up to 40000 characters) into the packet word for word, tool output left to lcm_read, after checking that the conversation in context matches the record. (2) Keeping the newest 40k tokens extended back to the start of a turn even when that turn was one 190k-token task; the planner now keeps less instead of pulling in more than twice its target. On the real 23:26 compaction the plan is now to take over.

## 0.4.20

- Fixed: Hermes showed as not connected, and Connect refused with “找不到 Hermes 自带的 Python”, on Hermes installs whose `~/.local/bin/hermes` launcher execs the entry script without quotes (written that way since late September). The launcher is now read quoted or bare, so Hermes' own Python and config code are found again; an existing SuperLcm setup is recognized as connected.

## 0.4.19

- Fixed: the compaction takeover gave up on conversations in the desktop app whenever the summaries ended on a title record (the app writes one every turn) and a message repeats (such as a recurring heartbeat prompt). The planner looked for the title in the live conversation, could not find it, then matched the first, hours-old copy of the repeated message, judged the summaries far behind ("about 283812 tokens would remain") and handed the compaction to Claude Code's own 70–90 s summary. Only messages are now used to place the summaries, and a repeated message is placed by the messages after it. On the real 21:12 compaction of a long conversation the plan is now to take over.

## 0.4.18

- Relicensed from AGPL-3.0-only to MIT; the contributor license agreement is no longer needed.

## 0.4.17

Fixes from the second review of 0.4.14–0.4.15.

- Turning the takeover off from the console with sizes an older version allowed (say 60K) no longer restores Claude Code's settings while the takeover stays on; the console sends the stored sizes back, and those are now brought inside the limits too. A failed turn-on of such an old setting rolls back to off instead of failing the rollback.
- The compaction start accounts for a lower `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (Claude Code keeps min(output cap, 20K) for output), and the percentage is raised where floating point would land a token short, so the start is never below the chosen size.
- A packet Claude Code prepared ahead of time is swapped in with the messages written since appended after its kept ones; those copies are no longer indexed and summarized a second time.
- The console's history list accepts transcripts up to 4 GiB as well (it still said 256 MiB).

## 0.4.16

- In-conversation summaries (本工具后台写 with the plugin) now work through the whole waiting backlog in one background run instead of 8 pieces per turn, so a long conversation that was never summarized catches up within the hour rather than over dozens of turns. Turns never wait for it.

## 0.4.15

- A conversation's transcript may now be up to 4 GiB (was 256 MiB). It is read in 64 KiB pieces, so the size costs disk for the private copy, not memory (a 563 MB transcript indexes in about 17 s). Before, a longer Claude Code conversation was skipped without a word: nothing recorded, no summaries, so the compaction takeover always fell back to Claude Code's own summary there. A transcript over the cap is now marked `too-large`.

## 0.4.14

- Fixed: the module no longer starts a compaction itself (added in 0.4.10). On a plugin's own `$.session.compact()` Claude Code 2.1.287 skips that plugin's hooks, so a compaction started there was always Claude Code's own summary, never SuperLcm's (checked on a live session; found in review). Instead, turning the takeover on now also sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` so that Claude Code itself starts compacting right at the console's size (window 100K above it, the start at the size), where the module answers with the summaries. When they lag, Claude Code summarizes at that size the usual way.
- Turning the takeover off after an older version turned it on no longer drops a setting that version never touched (the env window for 0.4.7 and earlier, the percentage for 0.4.8–0.4.13).
- A size an older version allowed (below 100K, or kept under 5K) no longer makes turning the takeover off fail halfway with Claude's settings restored but the takeover still shown as on.

## 0.4.13

- Console › Settings › Compaction: the threshold and the recent originals kept each take a custom size besides the presets (threshold 100K–950K, kept 5K–200K).
- Claude Code's own window (the threshold plus 100K) is capped at 1M, Claude Code's own ceiling, so 300K, 500K and 800K on a 1M model become 400K, 600K and 900K. On a model whose window leaves no room above the threshold, the plugin now starts 50K below that window (never below half of it) instead of never reaching the threshold.

## 0.4.12

- Claude Code's own compaction window is now set 100K above the console's size (300K → 400K) instead of to the same value. Claude Code starts its own compaction a little before its window, so with both at 300K it compacted at about 270K, ahead of the plugin; now the plugin swaps in the summaries at 300K and Claude Code compacts only as a fallback when they lag.

## 0.4.11

- Turning the takeover off now restores your own `CLAUDE_CODE_AUTO_COMPACT_WINDOW` even when the takeover was first turned on by 0.4.7 or earlier (which remembered only `autoCompactWindow`); before, that value was dropped instead of restored.

## 0.4.10

- The plugin module starts the compaction itself: after a turn, once the context reaches the window set in the console (300K by default) and the summaries are ready, it compacts with SuperLcm's packet between turns. The console's size now holds wherever the module runs, whatever the host reads from settings.json; while the summaries lag it starts nothing and Claude Code's own threshold still applies.

## 0.4.9

- Compaction takeover now also answers Claude Code's precompute (2.1.286 prepares the compaction in the background and swaps it in at the threshold without asking again). Before, the module let every precompute through, so Claude Code's own summary was what got swapped in and the takeover never ran on desktop sessions.

## 0.4.8

- The Claude desktop app does not pass `autoCompactWindow` to the Claude Code it runs, so its sessions kept compacting at the model default (about 367K) and the takeover's size had no effect there. Turning the takeover on now also sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` under `env` in Claude's settings.json, which every Claude Code reads first; turning it off restores the earlier value. Takes effect for sessions started or resumed afterwards.

## 0.4.7

Fixes from an independent review (GPT-6.1 sol), each with a regression test:

- Compaction takeover: a run of messages repeated later in the conversation could place the cut at the later copy and drop the uncovered messages between; the cut is now also checked against the first uncovered record after it. An unfinished first turn that no summary covers is no longer dropped (the compaction goes back to Claude Code).
- A `<superlcm-context …>` block pasted into a prompt was taken for a compaction packet and hid that message and the next ones from the index; only the first message after Claude Code's compact boundary is treated as a packet now.
- Summary leases have an owner: a refused save or a handoff from the conversation no longer releases a background worker's lease, and a refused save hands the rest back to that worker instead of retrying silently.
- Hermes: reconnecting after Node moved replaced nothing and added a second capture hook; the older SuperLcm hook is replaced now. Two captures at the same moment could store the same messages twice; the mirror is now appended under a write lock.
- Codex: hook trust was not found when the hooks point at the plugin's fixed entry (`~/.superlcm-claude/superlcm.js`).
- A message longer than 16,000 characters was cut in the index without a mark; the cut now says how much more there is and that `lcm_read` has the full record.
- Turning the takeover on when Claude's settings.json cannot be written leaves it off instead of on in name only, and the settings are read again right before they are written.

## 0.4.6

- README: a full Claude Code section leads the page, with a new compaction-takeover animation (`docs/images/takeover-*.gif`, source in `scripts/demos/`), what the plugin brings, which Claude Code versions run the module, and a measured swap.
- The in-conversation summary note now says plainly that it comes from the plugin the user installed and the mode the user chose, so models do not read it as an injection.
- After a compaction SuperLcm itself answered, the SessionStart retrieval note is left out (the packet already says where the originals are).

## 0.4.5

- Compaction takeover keeps the newest stretch word for word (Settings › Compaction › Keep recent originals: 20K, 40K by default, or 80K tokens, at most half the context), from the start of a turn, even where summaries already cover it; only older parts become summaries.

## 0.4.4

- The plugin module (compaction takeover and in-conversation summaries) is marked as supported from Claude Code 2.1.286, the version the Claude desktop app now bundles; checked with a real run of its bundled binary.

## 0.4.3

- 本工具后台写 for Claude Code runs inside Claude Code itself when the plugin is loaded on 2.1.287+: after each turn the plugin module writes the waiting summary pieces with `$.model.complete` on the session's own login (the turn does not wait), instead of starting a separate `claude -p`. New CLI commands `summary-host`, `summary-claim`, `summary-save` and `summary-handoff` carry it; the Stop hook skips its worker while a session writes its own, and at session end, or after a failed model call, the rest goes back to the `claude -p` worker.

## 0.4.2

- The README and the plugin listing lead with the compaction takeover: summaries assembled in the background, a no-wait swap at the threshold, originals kept, and Haiku able to write the summaries.

## 0.4.1

- The Claude Code card treats the plugin as the connection: it shows the plugin version, installs or updates it through `claude plugin`, says whether the terminal and desktop-app Claude Code can run the compaction module, and cleans up the older MCP entry and settings.json hooks (backed up first, other hooks untouched).
- Settings › Compaction is a switch and a threshold choice that apply at once, with a checklist of what the takeover needs (plugin, Claude Code version, summaries, compaction window).

## 0.4.0

- 接管压缩 (Settings › Compaction, off by default): a Claude Code module (`hooks/compact-mod.js`, Claude Code 2.1.287+) answers the main conversation's compaction the lossless-claw way. The level-0 summaries that chain from the first record are replaced by the fewest layered summaries that cover them, everything newer (and at least the last two prompts) stays word for word, and no model is called. A summary gap, an unplaceable cut, a kept part over 60% of the window, a subagent or Claude Code's own precompute all hand the compaction back to Claude Code. Turning it on sets Claude Code's `autoCompactWindow` (300K by default) and remembers the earlier value; turning it off restores it. The console warns when the Claude plugin is not enabled.
- A SuperLcm compaction packet, and the kept messages Claude Code writes again after it, are archived but not indexed or summarized twice.

## 0.3.0

- Custom API models are added once in Settings (name, protocol, endpoint, model ID, reasoning effort, key) and picked on any tool's card; there is no global summary method any more. Editing a model applies to every tool using it, a model in use cannot be deleted, and the same endpoint reuses a saved key. Existing custom API settings become added models with their keys.
- Saving a model makes one real test call and shows the provider's own error, with 仍然保存 to save anyway. Reasoning effort is sent as OpenAI `reasoning_effort` or an Anthropic thinking budget. Base URLs are completed the way the official SDKs do, `localhost` counts as local, API model IDs may use characters such as `@`, and a reasoning model that refuses `max_tokens` is retried with `max_completion_tokens`.
- Hermes' card lists the models Hermes offers for its provider (default first) instead of only the configured default.
- Tool cards show when a conversation was last saved (the old line only counted the AI calling SuperLcm's tools), put the model choice on its own row, and no longer show CLI versions; the early-records filter is gone. Saving a card choice answers at once (settings no longer re-detect every tool).

## 0.2.0-alpha.1

- Open the console from your own Tailscale devices (`tailscale serve`, tailnet only): `SUPERLCM_WEB_REMOTE_HOSTS` and `SUPERLCM_WEB_TAILSCALE_USERS` (`*` or specific logins); Funnel traffic is always refused.
- Custom API accepts a local gateway on this computer without an API key (no authorization header is sent).
- A tool card shows 没在存 when Codex or Claude Code wrote a conversation after SuperLcm's hooks last ran (for example Codex waiting for re-approval after reconnecting), instead of still saying 已接入.
- MCP tools now declare what they do (read-only lookups; summary tools that write only SuperLcm's own summaries; nothing destructive or networked). Codex no longer asks for approval before each SuperLcm call, which in non-interactive runs made every lookup fail. The Codex hook-trust check counts only SuperLcm's exact hook command.
- Three ways to write summaries: 对话模型生成 (now also the default on a fresh install; before, an unsaved setting fell back to the Claude CLI), 本工具后台写 and 自定义 API. 本工具后台写 replaces Claude 订阅 / Codex 订阅: a conversation is summarized by a background run of its own tool, now including Hermes (`hermes chat --source tool`) and Pi (`pi -p --no-session`), with the account, provider and model configured in that tool (Claude and Codex runs no longer strip provider settings or ignore the Codex config). Each tool card picks the model from that tool's own list. Background runs are never captured as conversations: Hermes and Pi hooks now also skip them. Older settings are converted once when the index opens.
- 接入 can approve SuperLcm's own hooks for you (a checkbox, on by default) through each tool's official mechanism: Codex's app-server `config/batchWrite` of `hooks.state` trusted hashes, and Hermes' documented shell-hook allowlist. No terminal step is needed. Fix Codex trust detection, which never recognized the single-quoted hook commands written on macOS/Linux and so always reported 还差一步.
- Support the new Hermes layout (0.21.5+, no venv: its Python is found through `hermes --print-runtime-command`). Launch SuperLcm with a node that no AI tool bundles, so a tool update cannot break it; cards show 需更新 when an older connection should be refreshed, and connecting again updates SuperLcm's own MCP entry and hooks in place.
- Size summary segments by characters only and send every record whole; previously input was cut at 22,000 characters (so 24,000-character segments lost their end) and each message at 2,400. A record longer than a whole segment gets its own segment with head and tail kept. The 单段最多消息数 setting is gone (a hidden 200-message cap remains), and the CLI summary timeout is 180 s.
- 对话模型生成 is the default for every tool: when a piece is ready, a short note asks the conversation's own AI to write it from memory (`lcm_summary_task` with `recent:true` returns only where the piece starts and ends), so nothing is re-sent. Pieces from before the tool last compacted the conversation come with their text. Hermes (`pre_llm_call` hook) and Pi (`before_agent_start`) now get the same note; compactions are recorded from Claude/Codex `PostCompact`, Hermes continuation sessions and Pi `session_compact`. The lag notice counts pending summary calls instead of records.
- Hermes and Pi connect automatically: 接入 registers SuperLcm's MCP tools and capture hooks (Hermes through its own config code; Pi as one extension file), checks that they load, and for Hermes opens a terminal so its hook approval prompt appears. Hermes messages are kept in SuperLcm's own append-only copy, with compression chains joined into one conversation; Pi session files are indexed byte for byte. The Codex setup dialog reads whether its hooks are trusted and can open Codex for the review.
- Delete a conversation from its list row or detail page, or clean up old conversations by tool and last activity under 设置 › 存储; deleted conversations are not recaptured by hooks. 接续到其他工具 is now 换个工具继续.
- The console lives at a fixed address, `http://127.0.0.1:8791/`, with no login token; Host, Origin and JSON-only writes still block other web pages.
- A single 生成摘要 / 补齐摘要 button opens a confirmation that shows how many records and model calls a background pass takes, and offers only methods this computer can run (installed Claude/Codex CLI, saved custom API), each labelled with whose quota or bill it uses; `summarize --backend api` runs a one-off pass with the saved custom API.
- Keep a private byte-for-byte archive of every indexed record under `originals/`, so originals survive the host moving or deleting its transcript; `node src/cli.js archive` backfills existing conversations and recovers Codex rollouts moved into `archived_sessions/`.
- Chinese and English interface, following the browser language with a switch in Settings; a test checks every Chinese string has an English translation.
- Redesign the console into three views: 对话 (list, search, summary-level strip, summary tree, original-record drawer, continue-in-another-tool, rename), 接入 (evidence-based status, guided setup dialog, local import, per-tool summary writer) and 设置 (appearance, storage, summary writer, granularity, MCP tool reference, in a side list). Real tool logos; phone layout; dark mode.
- Replace 18 MCP tools with 6: `lcm_continue`, `lcm_find`, `lcm_outline`, `lcm_read`, plus `lcm_summary_task` / `lcm_summary_submit`, which only appear when in-conversation summaries are enabled.
- Summaries now merge before new text is summarized, so higher levels actually form; first-level segments default to about 12,000 characters / 32 messages and merge 4 at a time, all adjustable.
- Conversations get a short `#code`, track last activity, and sort newest first. Continuing elsewhere is one line: `通过 SuperLcm 接续对话 #code`.
- Remove the queued cross-conversation delivery flow (the target now pulls context with `lcm_continue`); old delivery tables are left untouched.
- Relicense from MIT to AGPL-3.0-only; commercial closed-source licensing is available from the author.

## 0.1.0-alpha.12

- Correct import to indexed-source → target context; move native collection into lazy index management and eliminate automatic page-load scans.
- Persist queued navigation snapshots and add lcm_receive_context for target pickup, with explicit pending/hook-issued/MCP-received states and no DAG merge.
- Replace invisible setup confirmation with an immediate dialog, error feedback, configuration readback and next steps.
- Verify actual Claude MCP loading using initialization-only mcp_status; distinguish diagnostics from existing user-session connectivity.
- Track connection heartbeats and successful tool calls, excluding diagnostic peers; add offline and real-browser regression coverage.

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
