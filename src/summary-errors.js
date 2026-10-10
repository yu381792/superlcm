const KINDS = new Set(['rate_limit','auth','quota','timeout','cancelled','transport','stream_empty','stream_cutoff','upstream','response_invalid','length','quality','spawn','host','worker_lost','unknown'])
const MESSAGES = {
  spawn:'Summary worker could not start; check the configured executable',
  host:'Summary host writer failed; original content retained',
  worker_lost:'Summary worker disappeared before completion; original content retained',
  timeout:'Summary request timed out; original content retained',
  cancelled:'Summary task was cancelled; original content retained',
  length:'Summary exceeded its output limit; original content retained',
  quality:'Summary failed its language or heading check; original content retained',
  unknown:'Summary generation failed; see the explicit summarize command for details',
}
export function classifySummaryError(error) {
  if(KINDS.has(error?.summaryKind))return error.summaryKind
  const message=String(error?.message||'')
  if(['ENOENT','EACCES','ENOEXEC'].includes(error?.code))return 'spawn'
  if(error?.name==='TimeoutError'||/timed out|timeout/i.test(message))return 'timeout'
  if(error?.name==='AbortError'||/cancelled|canceled|setting.*changed/i.test(message))return 'cancelled'
  if(error?.summaryQuality||/language mismatch|section heading/i.test(message))return 'quality'
  if(/worker.*(?:lost|disappear)|lost.*lease/i.test(message))return 'worker_lost'
  if(/host summary|host writer/i.test(message))return 'host'
  if(/exceeds|output limit|repair input limit/i.test(message))return 'length'
  return 'unknown'
}
export function summaryErrorDetail(error) {
  const kind=classifySummaryError(error)
  // Arbitrary CLI/provider exceptions may contain source text or credentials.
  // Only our locally constructed protocol diagnostics can be shown verbatim.
  const message=error?.summaryDiagnostic===true ? String(error.message).slice(0,500) : MESSAGES[kind]||MESSAGES.unknown
  return {kind,message}
}
export function summaryWorkerFailure(kind) {
  const safe=KINDS.has(kind)?kind:'unknown'
  return Object.assign(Error(MESSAGES[safe]||MESSAGES.unknown),{summaryDiagnostic:true,summaryKind:safe})
}
// Do not echo upstream free text. Classify recognizable causes into fixed
// local wording, so source fragments, API keys and URLs never enter diagnostics.
export function upstreamSummaryCause(value) {
  const error=value?.error??value
  const code=String(error?.code??error?.type??'').toLowerCase()
  const text=String(error?.message??error??'').toLowerCase()
  if(/insufficient_quota|quota_exceeded|billing|insufficient.*(?:quota|credit|balance)|credit.*exhaust/i.test(code+' '+text))return {kind:'quota',message:'upstream quota or billing limit'}
  if(/invalid_api_key|authentication_error|unauthorized|invalid.*(?:api.?key|credential)|authentication failed/i.test(code+' '+text))return {kind:'auth',message:'upstream authentication failed'}
  if(/rate_limit|rate.?limit|too many requests|concurrency limit/i.test(code+' '+text))return {kind:'rate_limit',message:'upstream rate or concurrency limit'}
  if(/overloaded_error|overloaded|temporarily unavailable|service unavailable/i.test(code+' '+text))return {kind:'upstream',message:'upstream service unavailable'}
  if(/context_length_exceeded|context.*(?:length|window).*(?:exceed|limit)|input too long/i.test(code+' '+text))return {kind:'length',message:'upstream context limit exceeded'}
  return {kind:'upstream',message:'upstream error; unrecognized response details withheld'}
}
