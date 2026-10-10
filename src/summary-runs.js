import { randomUUID } from 'node:crypto'
import { summaryErrorDetail } from './summary-errors.js'
import { summarySettingsRevision } from './summarize.js'

export const ACTIVE_RUN_STATES = ['queued','starting','running']
const terminal = new Set(['done','failed','stopped','lost'])
export const summaryConcurrency = (env=process.env) => {
  const n=Number(env.SUPERLCM_SUMMARY_CONCURRENCY??3)
  return Number.isSafeInteger(n)&&n>=1&&n<=16?n:3
}
export function initializeSummaryRuns(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS summary_runs(
    id TEXT PRIMARY KEY,session TEXT NOT NULL,state TEXT NOT NULL,origin TEXT NOT NULL,route TEXT NOT NULL,
    backend TEXT,model TEXT,revision TEXT NOT NULL,priority INTEGER NOT NULL,queued_ms INTEGER NOT NULL,
    started_ms INTEGER,ended_ms INTEGER,heartbeat_ms INTEGER NOT NULL,pid INTEGER,owner TEXT,
    planned_parts INTEGER NOT NULL DEFAULT 0,created_parts INTEGER NOT NULL DEFAULT 0,
    current_first INTEGER,current_last INTEGER,stop_reason TEXT,error_kind TEXT,error_message TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS summary_runs_one_active ON summary_runs(session) WHERE state IN ('queued','starting','running');
    CREATE INDEX IF NOT EXISTS summary_runs_queue ON summary_runs(state,priority,queued_ms);
    CREATE INDEX IF NOT EXISTS summary_runs_session ON summary_runs(session,queued_ms);`)
}
export const latestSummaryRun=(store,session)=>store.db.prepare('SELECT * FROM summary_runs WHERE session=? ORDER BY queued_ms DESC,rowid DESC LIMIT 1').get(session)||null
export const activeSummaryRun=(store,session)=>store.db.prepare("SELECT * FROM summary_runs WHERE session=? AND state IN ('queued','starting','running')").get(session)||null
export const summaryRunHistory=(store,session)=>store.db.prepare('SELECT * FROM summary_runs WHERE session=? ORDER BY queued_ms DESC,rowid DESC LIMIT 10').all(session)
export function enqueueSummaryRun(store,session,{origin='hook',route='worker',backend=null,model=null,revision='',planned=0}={}) {
  const ownTransaction=!store.db.isTransaction
  if(ownTransaction)store.db.exec('BEGIN IMMEDIATE')
  try {
    const existing=activeSummaryRun(store,session)
    if(existing){if(ownTransaction)store.db.exec('COMMIT');return {run:existing,added:false}}
    const id=randomUUID(),now=Date.now(),priority=store.metadata(session).headless?1:0
    store.db.prepare("INSERT INTO summary_runs(id,session,state,origin,route,backend,model,revision,priority,queued_ms,heartbeat_ms,planned_parts) VALUES(?,?,'queued',?,?,?,?,?,?,?,?,?)").run(id,session,origin,route,backend,model,revision,priority,now,now,planned)
    if(ownTransaction)store.db.exec('COMMIT');return {run:store.db.prepare('SELECT * FROM summary_runs WHERE id=?').get(id),added:true}
  }catch(error){if(ownTransaction)store.db.exec('ROLLBACK');throw error}
}
const unmanagedCount = store => store.db.prepare("SELECT count(*) AS n FROM leases l WHERE l.until_ms>? AND NOT EXISTS(SELECT 1 FROM summary_runs r WHERE r.session=l.session AND r.state IN ('starting','running'))").get(Date.now()).n
export function reserveSummaryRun(store,{id=null,route='worker',limit=3}={}) {
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const live=store.db.prepare("SELECT count(*) AS n FROM summary_runs WHERE state IN ('starting','running')").get().n+unmanagedCount(store)
    let run=null
    if(live<limit){
      run=id?store.db.prepare("SELECT * FROM summary_runs WHERE id=? AND state='queued'").get(id):store.db.prepare("SELECT * FROM summary_runs WHERE state='queued' AND route=? ORDER BY priority,queued_ms,rowid LIMIT 1").get(route)
      if(id&&run&&run.priority>0&&store.db.prepare("SELECT 1 FROM summary_runs WHERE state='queued' AND route='worker' AND priority< ? LIMIT 1").get(run.priority))run=null
      if(run)store.db.prepare("UPDATE summary_runs SET state='starting',heartbeat_ms=? WHERE id=? AND state='queued'").run(Date.now(),run.id)
    }
    store.db.exec('COMMIT');return run
  }catch(error){store.db.exec('ROLLBACK');throw error}
}
export function bindSummaryRun(store,id,{owner,pid=null}={}) {
  const now=Date.now()
  store.db.prepare("UPDATE summary_runs SET state='running',owner=?,pid=?,started_ms=COALESCE(started_ms,?),heartbeat_ms=? WHERE id=? AND state='starting'").run(owner,pid,now,now,id)
  return store.db.prepare('SELECT changes() AS n').get().n===1
}
export function summaryRunOwns(store,id,owner) {
  return !!store.db.prepare("SELECT 1 FROM summary_runs r WHERE id=? AND owner=? AND state='running' AND NOT EXISTS(SELECT 1 FROM summary_runs newer WHERE newer.session=r.session AND newer.rowid>r.rowid)").get(id,owner)
}
export function progressSummaryRun(store,id,owner,{first=null,last=null,created=null}={}) {
  if(!summaryRunOwns(store,id,owner))return false
  store.db.prepare("UPDATE summary_runs SET heartbeat_ms=?,current_first=COALESCE(?,current_first),current_last=COALESCE(?,current_last),created_parts=COALESCE(?,created_parts) WHERE id=? AND owner=? AND state='running'").run(Date.now(),first,last,created,id,owner)
  return true
}
export function finishSummaryRun(store,id,{owner,state='done',reason=null,error=null,detail=null}={}) {
  if(!terminal.has(state))throw Error('Invalid summary run final state')
  const ownTransaction=!store.db.isTransaction
  if(ownTransaction)store.db.exec('BEGIN IMMEDIATE')
  try {
  const run=store.db.prepare('SELECT * FROM summary_runs WHERE id=?').get(id)
  if(!run||terminal.has(run.state)||(owner!==undefined&&run.owner!==owner))return false
  const safe=detail||(error?summaryErrorDetail(error):{})
  store.db.prepare("UPDATE summary_runs SET state=?,ended_ms=?,heartbeat_ms=?,stop_reason=?,error_kind=?,error_message=? WHERE id=? AND state IN ('queued','starting','running')").run(state,Date.now(),Date.now(),reason,safe.kind||null,safe.message||null,id)
  const lease=store.db.prepare('SELECT owner FROM leases WHERE session=?').get(run.session)
  const claim=run.route==='host'?store.db.prepare('SELECT claim_id FROM host_summary_claims WHERE session=?').get(run.session):null
  const ownsStatus=!run.owner||(run.route==='host'?lease?.owner==='host'&&claim?.claim_id===run.owner.slice(5):!lease||lease.owner===run.owner)
  if(latestSummaryRun(store,run.session)?.id===id&&ownsStatus){
    if(state==='failed'||state==='lost'){
      const diagnostic=Object.assign(Error(safe.message||'Summary run failed; originals retained'),{summaryDiagnostic:true})
      store.recordSummaryError(run.session,diagnostic);store.setStatus(run.session,'summary_error')
    }else if(state==='done')store.setStatus(run.session,'ok')
  }
  return true
  } catch(error) {if(ownTransaction)store.db.exec('ROLLBACK');throw error}
  finally {if(ownTransaction&&store.db.isTransaction)store.db.exec('COMMIT')}
}
export const processAlive=pid=>{
  if(!Number.isSafeInteger(pid)||pid<=0)return false
  try{process.kill(pid,0);return true}catch(error){return error.code==='EPERM'}
}
export function recoverSummaryRuns(store,{isAlive=processAlive,now=Date.now(),startupMs=30000,env=process.env}={}) {
  for(const queued of store.db.prepare("SELECT id,session,revision FROM summary_runs WHERE state='queued' AND route='host'").all()){
    store.db.exec('BEGIN IMMEDIATE')
    try {
      const current=store.db.prepare("SELECT * FROM summary_runs WHERE id=? AND state='queued'").get(queued.id)
      if(current){
        const source=store.source(current.session),setting=source?store.effectiveSetting(current.session,env):null
        if(!source||store.isDeleted(current.session)||setting.mode!=='cli'||setting.harness!=='claude-code'||current.revision!==summarySettingsRevision(store,current.session,env))finishSummaryRun(store,current.id,{state:'stopped',reason:'settings-changed'})
      }
      store.db.exec('COMMIT')
    }catch(error){store.db.exec('ROLLBACK');throw error}
  }
  const rows=store.db.prepare("SELECT * FROM summary_runs WHERE state IN ('starting','running')").all()
  let lost=0
  for(const run of rows){
    const lease=store.db.prepare('SELECT * FROM leases WHERE session=?').get(run.session)
    const staleLease=!lease||lease.owner!==run.owner||lease.until_ms<=now
    const dead=run.state==='starting'?now-run.heartbeat_ms>startupMs||(run.pid&&!isAlive(run.pid)):run.route==='host'?(!lease||lease.owner!=='host'||lease.until_ms<=now):run.pid&&!isAlive(run.pid)||staleLease&&now-run.heartbeat_ms>startupMs
    if(!dead)continue
    if(finishSummaryRun(store,run.id,{state:'lost',reason:'worker_lost',detail:{kind:'worker_lost',message:'Summary worker ended unexpectedly. Retry manually or after the next turn; originals retained.'}}))lost++
    if(run.owner&&lease?.owner===run.owner)store.release(run.session,run.owner)
    if(run.route==='host'&&lease?.owner==='host')store.releaseHostClaim(run.session,run.owner?.replace(/^host:/,''))
  }
  // Old installations may have leases without a run record. Only worker PID
  // evidence can invalidate those leases; host leases retain their expiry rule.
  for(const lease of store.db.prepare('SELECT session,owner FROM leases WHERE until_ms>?').all(now)){
    const match=/^worker:(\d+):/.exec(lease.owner)
    if(match&&!isAlive(Number(match[1])))store.release(lease.session,lease.owner)
  }
  return lost
}
