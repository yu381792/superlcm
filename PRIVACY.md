# Privacy

SuperLcm runs entirely on your computer. Its author operates no server, collects no telemetry and receives none of your data.

## What SuperLcm stores

After each turn, SuperLcm copies the conversation from the connected tool's own transcript (Claude Code, Codex, Hermes or Pi) into a folder on your computer, `~/.superlcm-claude` by default (or `SUPERLCM_HOME`). That includes everything you and the agent wrote and the agent's tool calls and their output, plus the summaries SuperLcm keeps. An API key you enter for the custom API option is stored in the same folder in a file readable only by your user account.

You can delete a conversation from the console, and removing the folder removes everything SuperLcm has stored.

## What leaves your computer

Only summary writing can send conversation text anywhere, and only to a model you have chosen, in the mode you pick per tool:

- **The agent itself** (default): the agent you are already talking to writes the summary inside that conversation, through the same tool and provider you are using.
- **The tool's own CLI**: a short background run of Claude Code, Codex, Hermes or Pi sends excerpts to that tool's model provider under the account you already signed in with.
- **Custom API**: excerpts are sent to the endpoint you enter, with the key you enter. A local endpoint such as `http://127.0.0.1` stays on your computer.
- **Off**: nothing is sent; conversations are still saved and searchable.

The console listens on `127.0.0.1` only. Access from your other devices over Tailscale is off unless you turn it on (see [docs/CONSOLE.md](docs/CONSOLE.md)).

## Contact

Questions and reports: https://github.com/yu381792/superlcm/issues
