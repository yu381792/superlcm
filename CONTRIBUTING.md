# Contributing

Use Node.js >=22.16. No runtime dependencies are required. Run npm run validate and npm pack --dry-run before proposing a change. Tests must use temporary roots and fake provider responses, never personal accounts or live inference.

## Add a harness

1. Add an explicit registry record and environment-aware paths in src/harness.js / src/runtime.js. Do not execute arbitrary binaries or scrape credentials.
2. Advertise detection, local read/import, MCP registration, hooks and models as independent capabilities. Unsupported is not a successful empty result.
3. Verify native schemas and preserve identity. Mutable databases/branching logs need explicit snapshot semantics; never silently merge divergent branches.
4. Use official configuration surfaces, reviewed previews, stale-state checks and private backups. Preserve unrelated settings and native trust.
5. Add offline fixtures for absent/malformed stores, custom roots, identity changes, duplicates and setup idempotence. Record real-host evidence separately.

See [console contract](docs/CONSOLE.md) for the optional browser test and [security boundaries](SECURITY.md). Do not commit private configuration, transcripts, tokens or screenshots containing personal data.
