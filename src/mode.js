// A dedicated API key selects paid background generation; it is never read from Claude Code's generic ANTHROPIC_API_KEY.
export function summaryMode(env = process.env) {
  const configured=env.SUPERLCM_SUMMARY_MODE || (env.SUPERLCM_SUMMARIZE_ON_HOOK==='1' ? 'api' : 'auto')
  if (!['auto','off','api','agent'].includes(configured)) throw new Error('SUPERLCM_SUMMARY_MODE must be auto, off, api, or agent')
  if (configured==='off') return 'off'
  // Key presence wins over an old agent setting: never prompt and pay for the same batch twice.
  if (env.SUPERLCM_ANTHROPIC_API_KEY && configured==='agent') return 'api'
  if (configured==='auto') return env.SUPERLCM_ANTHROPIC_API_KEY ? 'api' : 'agent'
  return configured
}
