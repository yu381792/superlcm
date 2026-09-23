# SuperLcm

Cross-harness MCP companion for per-conversation layered summaries and exact-source recall.

**让各个宿主自己管理压缩；SuperLcm 按对话保存摘要导航并找回可验证的原文。**

Independent MCP server for **layered conversation summaries and exact original recall**, accessible from Claude Code, Codex and other MCP clients. Each host retains control of its native context compaction; this repository does **not** replace it. It has no DeepSeek Harness dependency or DSH source files.

**Claude Code CLI, Desktop Code (Local), and Codex CLI**: automatic local JSONL ingestion via their respective trusted hooks; Codex and Claude retain native compaction. **Any MCP harness** on the same local index can list sessions and read the entire paginated summary DAG of a selected conversation, including one created by Claude Code. Every saved conversation carries a source harness, original conversation ID, and a resolvable name; ambiguous names return candidates. Other harnesses can explicitly import portable JSONL or UTF-8 text; automatic capture needs a dedicated adapter. Summaries normally use an independent background worker or explicit CLI summarization: default `cli` runs logged-in `claude --print`; explicit `codex-cli` uses isolated `codex exec`; configured `SUPERLCM_ANTHROPIC_API_KEY` selects the paid `api` backend. `agent` is opt-in and advisory; `off` disables summaries. Neither main Claude nor Codex agent writes nodes unless explicitly switched to agent mode.

- Local Web control console: `node src/cli.js web` prints a one-time loopback URL; choose source/target navigation, a **global or harness-specific** summary backend (never per conversation), and run a local MCP handshake test. CLI model suggestions are read from Codex’s local cache or Claude CLI help without a model call; subscription availability is not guaranteed.
- [Setup, security, tools and limitations](./docs/SETUP.md)
- Runtime: Node.js 22.16+, no third-party runtime dependencies.
- Current source preview: 0.1.0-alpha.8. Live end-to-end installation has not been claimed.
