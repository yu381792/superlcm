# Changelog

## 0.1.0-alpha.3

- Select agent mode by default and switch exclusively to API mode when the dedicated summarizer key is configured; suppress prompts and gate agent MCP writes to prevent duplicate summaries.
- Persist the hook-selected mode per session so separately launched MCP processes enforce the same policy.

## 0.1.0-alpha.2

- Add optional active-Claude summary work and validated hierarchical persistence; keep API-backed background summaries as a separate mode.
- Support local Claude Code sessions in the Desktop Code tab using the same hooks and MCP configuration.

## 0.1.0-alpha.1

- Extract Claude Code CLI and Desktop recall adapter as an independent package with no DSH compaction integration.
