// Legacy agent mode is intentionally retired: summaries run in a separate CLI or API worker.
export function summaryMode(env = process.env) {
  const configured = env.SUPERLCM_SUMMARY_MODE || (env.SUPERLCM_SUMMARIZE_ON_HOOK === '1' ? 'api' : 'auto')
  if (!['auto', 'off', 'api', 'cli', 'agent'].includes(configured)) throw new Error('SUPERLCM_SUMMARY_MODE must be auto, off, cli, or api')
  if (configured === 'off') return 'off'
  if (configured === 'auto' || configured === 'agent') return env.SUPERLCM_ANTHROPIC_API_KEY ? 'api' : 'cli'
  return configured
}
