# Security boundaries

SuperLcm is local-user software, not multi-tenant hosting. Every trusted MCP client on one index can read it; clientInfo is self-reported, not authenticated. Never expose stdio or this loopback console publicly as a remote service.

Web binds 127.0.0.1 without a login; it checks Host (against DNS rebinding) and Origin, accepts writes only as JSON, and uses CSP. Other local programs running as the same user can open it, as they can read the index itself. Native-store import requires explicit selection under known roots. Arbitrary MCP file import is separately allowlisted. Scoped API keys live in a separate private file and are never returned by the API; permissions are not encryption against other code running as the same OS user.

Setup uses previews, private backups and official CLI commands. It never bypasses host trust. Catalog probes send no user prompts. Choosing a summarizer remains an explicit content-disclosure and potentially billable decision.

Report issues without keys, access tokens, full private configs or transcripts. Use the maintainer's private reporting channel when available; otherwise ask for a private contact without posting sensitive exploit details. Do not assume GitHub private reporting is enabled.
