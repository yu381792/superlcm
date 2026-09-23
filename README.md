# SuperLcm

Claude Code CLI and Claude Desktop **Code (Local)** MCP companion for layered recall.

**让 Claude 自己压缩上下文，SuperLcm 帮它找回旧对话的细节。**

Independent Claude Code CLI and Claude Desktop adapter for **layered conversation summaries and exact original recall**. Claude's native context compaction is always controlled by Claude; this repository does **not** replace it. It has no DeepSeek Harness dependency or DSH source files.

**Claude Code CLI and Desktop Code (Local)**: share MCP and hooks; index complete local JSONL records and receive a compact resume hint. Ordinary Desktop Chat export/import is a separate, limited optional path. Two optional summary modes: `agent` uses the active Claude turn and MCP tools (no separate API key, not guaranteed automatic); `api` uses an explicit paid Anthropic API model in the background. Both are off by default.

- [Setup, security, tools and limitations](./docs/SETUP.md)
- Runtime: Node.js 22.16+, no third-party runtime dependencies.
- Current source preview: 0.1.0-alpha.2. Live end-to-end installation has not been claimed.
