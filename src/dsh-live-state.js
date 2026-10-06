// Shared by discovery and the console's live refresh: archive-only connections
// need their archive runtime, while legacy takeover needs both owned runtimes.
export function dshRuntimeState(profile,runtimes,installed=profile.installed_version) {
  const live=runtimes.filter(r=>r.live&&r.profile===profile.profile)
  const engine=live.find(r=>r.kind==='engine')
  const archive=live.find(r=>r.kind==='archive'&&(profile.archive_only||r.pid===engine?.pid))
  const oldOwner=profile.archive_only&&!!archive&&live.some(r=>r.kind==='engine'&&r.pid===archive.pid)
  const matching=!!installed&&profile.configured&&!!archive&&archive.version===installed
  const running=matching&&!oldOwner&&(profile.archive_only||!!engine&&engine.version===installed)
  const state=!profile.configured?'misconfigured':profile.archive_only?(matching&&oldOwner?'runtime-mismatch':running?'summary-only':'awaiting-runtime'):!profile.enabled?'disabled':!profile.route_ready?'missing-route':!running?'awaiting-runtime':!engine.enabled||!engine.route_ready?'runtime-mismatch':'enabled'
  return {running:!!running,state,runtime_version:(profile.archive_only?archive:engine)?.version||null}
}
export function dshGlobalState(profiles) {
  return profiles.some(p=>p.state==='enabled')?'enabled':profiles.some(p=>p.state==='summary-only')?'summary-only':profiles.some(p=>p.state==='disabled')?'disabled':'awaiting-runtime'
}
