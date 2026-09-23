# SuperLcm

Cross-harness MCP companion for per-conversation layered summaries and exact-source recall.

**让各个宿主自己管理压缩；SuperLcm 按对话保存摘要导航并找回可验证的原文。**

Independent MCP server for **layered conversation summaries and exact original recall**, accessible from Claude Code, Codex and other MCP clients. Each host retains control of its native context compaction; this repository does **not** replace it. It has no DeepSeek Harness dependency or DSH source files.

**Claude Code CLI and Desktop Code (Local)**: one automatic JSONL ingestion adapter and compact resume hint. **Any MCP harness** on the same local index can list sessions and read the entire paginated summary DAG of a selected conversation, including one created by Claude Code. Other harnesses can explicitly import portable JSONL or UTF-8 text; automatic capture needs a dedicated adapter. Summaries are written only by a background worker: default `cli` runs a separate logged-in `claude --print` subprocess with a selectable model, while a configured `SUPERLCM_ANTHROPIC_API_KEY` selects the explicit paid `api` backend. `off` disables summaries. The main Claude agent never writes summary nodes.

- [Setup, security, tools and limitations](./docs/SETUP.md)
- Runtime: Node.js 22.16+, no third-party runtime dependencies.
- Current source preview: 0.1.0-alpha.5. Live end-to-end installation has not been claimed.
