// Agent-authored summaries are opt-in and advisory; background CLI remains default.
export function summaryMode(env = process.env) {
  const configured = env.SUPERLCM_SUMMARY_MODE || (env.SUPERLCM_SUMMARIZE_ON_HOOK === '1' ? 'api' : 'auto')
  if (!['auto', 'off', 'api', 'cli', 'codex-cli', 'agent'].includes(configured)) throw new Error('SUPERLCM_SUMMARY_MODE must be auto, off, cli, codex-cli, agent, or api')
  if (configured === 'off') return 'off'
  if (configured === 'auto') return env.SUPERLCM_ANTHROPIC_API_KEY ? 'api' : 'cli'
  return configured
}
