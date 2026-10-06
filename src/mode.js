// Default: summaries are written in the background. 'cli' = a run of the conversation's
// own tool; 'codex-cli' is the retired name for it and is read as 'cli'.
export function summaryMode(env = process.env) {
  const configured = env.SUPERLCM_SUMMARY_MODE || (env.SUPERLCM_SUMMARIZE_ON_HOOK === '1' ? 'api' : 'auto')
  if (!['auto', 'off', 'api', 'cli', 'codex-cli', 'agent'].includes(configured)) throw new Error('SUPERLCM_SUMMARY_MODE must be auto, off, cli, agent, or api')
  if (configured === 'auto') return env.SUPERLCM_ANTHROPIC_API_KEY ? 'api' : 'cli'
  return configured === 'codex-cli' ? 'cli' : configured
}
