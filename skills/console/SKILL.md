---
name: console
description: Open the SuperLcm console, the local web page for browsing saved conversations, choosing how summaries are written, and connecting Codex, Hermes or Pi. Use when the user asks to open, start or see SuperLcm (its console, dashboard, settings or saved conversations).
---

# Open the SuperLcm console

The console is a local web page at http://127.0.0.1:8791/ served from this computer only.

1. Check whether it is already running: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8791/`. A `200` means it is; skip to step 3.
2. Otherwise start it in the background from this plugin, and leave it running:
   `nohup node "${CLAUDE_PLUGIN_ROOT}/src/launch.js" web > /dev/null 2>&1 &`
   then wait a second and check again. If port 8791 is taken by something else, start it on another port by adding the port number after `web`, and use that port below.
3. Give the user the link http://127.0.0.1:8791/ (or the port you used) and, on macOS, open it with `open <link>`.

The console is where the user connects Codex, Hermes and Pi; Claude Code itself is already connected by this plugin.
