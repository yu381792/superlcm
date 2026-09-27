# SuperLcm

**Lossless, never-ending conversations across Claude Code, Codex and other MCP tools.**

**原文完整入库，分层摘要导航，随时按编号读回原文；额度用完或想换工具时，一句话在另一个工具里接着聊。**

Claude Code and Codex compact long conversations and lose detail. SuperLcm keeps every original record in a local index, builds a layered summary tree over it, and gives the AI in any connected tool six MCP tools to navigate that tree and read the exact originals. Native compaction stays in charge of the live context; SuperLcm makes sure nothing it drops is gone.

- **Lossless.** Every message is stored with byte offsets and SHA-256 hashes; `lcm_read` returns the exact original text, verified against the source file.
- **Layered summaries.** First-level summaries cover segments of the conversation (about 12,000 characters each, adjustable); every 4 adjacent summaries merge into one higher level, so a very long conversation still fits in a short outline.
- **Switch tools mid-task.** Out of Claude quota, or want a second opinion? Open Codex and say `通过 SuperLcm 接续对话 #6e94e`. `lcm_continue` hands over the outline plus the most recent messages, and the new conversation can read any earlier detail on demand.
- **Local only.** Node.js 22.16+, no runtime dependencies, loopback-only console, no cloud service.

## Quick start

    node src/cli.js web

Open the printed URL, then:

1. **接入 (Connect)** — pick Claude Code or Codex and confirm. SuperLcm registers its MCP server and hooks through the tool's own CLI, backs up the config first, and verifies it loads. Codex additionally asks you to trust the hooks in `/hooks`.
2. **对话 (Conversations)** — browse, search and read every stored conversation and its summary tree. Click **接续到其他工具** to get the one-line handoff for another tool.
3. **设置 (Settings)** — choose who writes summaries: the AI inside the conversation (cheapest, it mostly reads cached context), your Claude or Codex subscription CLI in the background, or a custom API. Tune segment size and merge width.

Terminal equivalents: `node src/cli.js setup codex --apply`, `node src/cli.js setup claude-code --apply`, `node src/cli.js summarize <conversation> --backend cli`.

Hermes and Pi are detected and their past conversations can be imported from the console; automatic capture for them is not implemented yet.

## MCP tools

| Tool | Purpose |
|---|---|
| `lcm_continue` | Hand over another conversation: top-level outline + recent messages + how to dig deeper |
| `lcm_find` | Find conversations by `#code`, name or ID, and search summaries and originals |
| `lcm_outline` | Expand the summary tree one level at a time |
| `lcm_read` | Read exact original records by number |
| `lcm_summary_task` / `lcm_summary_submit` | In-conversation summary mode only: claim a segment, submit its summary (verified against the originals) |

## More

- [Setup, security and limitations](docs/SETUP.md)
- [Console behavior and tests](docs/CONSOLE.md)
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
- License: [Apache-2.0](LICENSE)

Claude, Claude Code, Codex, Hermes and Pi names and logos belong to their respective owners and are used only to identify compatible tools. SuperLcm is an independent project and is not affiliated with or endorsed by them.
