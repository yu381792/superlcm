# SuperLcm Claude MCP

**让 Claude 自己压缩上下文，SuperLcm 帮它找回旧对话的细节。**

Independent Claude Code CLI and Claude Desktop adapter for **layered conversation summaries and exact original recall**. Claude's native context compaction is always controlled by Claude; this repository does **not** replace it. It has no DeepSeek Harness dependency or DSH source files.

**Claude Code**: indexes complete on-disk JSONL records via opt-in hooks; a compact resume hint points to MCP search and exact expansion. **Claude Desktop ordinary chat**: supports only explicit export/import, not silent full-chat capture. Summarization uses an explicit, separately enabled Anthropic API model and is off by default.

- [Setup, security, tools and limitations](./docs/SETUP.md)
- Runtime: Node.js 22.16+, no third-party runtime dependencies.
- Current source preview: 0.1.0-alpha.1. Live end-to-end installation has not been claimed.
