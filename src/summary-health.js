import { latestSummaryRun, recoverSummaryRuns } from './summary-runs.js'
import { summaryEstimate } from './summarize.js'
export function summaryHealth(store,session,{env=process.env,recover=true}={}) {
  if(recover)recoverSummaryRuns(store,{env})
  const setting=store.effectiveSetting(session,env),run=latestSummaryRun(store,session),estimate=summaryEstimate(store,session)
  let state
  if(run&&['queued','starting','running'].includes(run.state))state=run.state
  else if(run?.state==='lost')state='lost'
  else if(run?.state==='failed'||store.source(session).status==='summary_error')state='failed'
  else if(store.source(session).status==='summary_unconfigured')state='unconfigured'
  else if(setting.mode==='off')state='off'
  else if(setting.mode==='agent')state='agent'
  else state=estimate.calls>0?'behind':'up_to_date'
  const headless=store.metadata(session).headless===true
  const retry=store.db.prepare('SELECT attempts,until_ms FROM summary_retries WHERE session=?').get(session)||null
  return {state,active:['queued','starting','running'].includes(state),needs_attention:!headless&&['failed','lost','unconfigured'].includes(state),headless,run,estimate,retry,retry_hint:['failed','lost','behind'].includes(state)?retry?.attempts>=3||!['cli','api'].includes(setting.mode)?'manual':'next_turn_or_manual':null}
}
