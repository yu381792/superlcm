#!/usr/bin/env node
import { visibleOutputRoom, isReducedSummary, reducedNotice, adaptiveSummaryTask, profileKey, readSummaryProfile, updateSummaryProfile } from './summary-generation.js'
import { compactionDiagnostic } from './compaction-diagnostic.js'
import { ClaudeStore, claudeTranscript, shortCode } from './store.js'
import { codexTranscript, codexSessionKey } from './codex.js'
import { nativeConversationName } from './conversation-names.js'
import { buildHierarchy, summaryWork, summarySettingsRevision } from './summarize.js'
import { SUMMARY_SYSTEM, buildSummaryPrompt, summaryPromptParts, checkedSummary } from './summary-policy.js'
import { summarizeWith, writerTool, hostWriterTool, WRITER_CLI } from './cli-writers.js'
import { startServer } from './mcp.js'
import { claudePluginEnabled } from './runtime.js'
import { startWeb, defaultPort } from './web.js'
import { spawn } from 'node:child_process'
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { privateDirectory, privateFile } from './private-path.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scheduleSummary, drainSummaryQueue } from './summary-scheduler.js'
import { enqueueSummaryRun, reserveSummaryRun, bindSummaryRun, progressSummaryRun, finishSummaryRun, activeSummaryRun, summaryConcurrency } from './summary-runs.js'
import { summaryTick, catchUp, catchupDeadlineMs, pendingLeaves, coldCompactionDue, endCompactionDue, cacheExpiry, firstTranscript } from './summary-background.js'
import { claimHostFork, settleHostFork } from './main-fork.js'
import { randomUUID } from 'node:crypto'
import {claudeCompactionNodes} from './claude-checkpoints.js'
import {claudeCompactAt} from './takeover.js'
import {hostDraft,retainHostDraft,hostSavedReceipt} from './claude-host-drafts.js'

// Fork diagnostic: keep the planner's own reason (compaction_history only keeps a mapped code) and, for a declined
// compaction, the last input the module sent, in the private store, so it can be replayed. Never fails the reply.
function noteCompactionDetail(store,session,result,input){
  try{
    store.db.exec('CREATE TABLE IF NOT EXISTS compaction_details(session TEXT NOT NULL,at_ms INTEGER NOT NULL,use INTEGER NOT NULL,trigger TEXT,reason TEXT,detail TEXT)')
    store.db.prepare('INSERT INTO compaction_details VALUES(?,?,?,?,?,?)').run(session,Date.now(),result.use?1:0,String(input.trigger||''),String(result.reason||'').slice(0,500),result.verify?JSON.stringify(result.verify).slice(0,8000):null)
    store.db.prepare('DELETE FROM compaction_details WHERE rowid IN (SELECT rowid FROM compaction_details WHERE session=? ORDER BY at_ms DESC LIMIT -1 OFFSET 20)').run(session)
    if(!result.use){
      const dir=join(store.dir,'diagnostics');privateDirectory(dir)
      const file=join(dir,'compact-input-'+session.replace(/[^\w.-]/g,'_')+'.json');privateFile(file)
      writeFileSync(file,JSON.stringify(input))
    }
  }catch{}
}
const [command,...rest]=process.argv.slice(2)
const homeFlag=rest.indexOf('--home')
if(homeFlag>=0){if(!rest[homeFlag+1])throw Error('--home requires a path');process.env.SUPERLCM_HOME=rest[homeFlag+1];rest.splice(homeFlag,2)}
const effective=(store,session)=>store.effectiveSetting(session)
// Only migrated claims with an empty ID accept the legacy protocol. A newly
// issued claim always requires its exact UUID, even when the batch is unchanged.
const hostClaimMatches=(claim,input,revision)=>!!claim&&(claim.claim_id?input.claim_id===claim.claim_id:!input.claim_id&&claim.revision===revision)
const readHook=(limit=200000)=>new Promise((resolve,reject)=>{let text='',oversized=false;process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{if(oversized)return;text+=part;if(text.length>limit){oversized=true;text='';reject(new Error('Oversized hook input'))}});process.stdin.on('end',()=>{if(oversized)return;try{const input=JSON.parse(text);if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid hook input');resolve(input)}catch(error){reject(error)}});process.stdin.on('error',reject)})
// 对话模型生成: one short note per turn, only when a whole piece is waiting. The AI writes it from memory
// (it has just been through that part); a piece that straddles a compaction comes with its text instead.
// Written as what it is, a note from the plugin the user installed, so a model does not read it as an injection.
// Whether the newest compaction in a Claude Code transcript was answered by SuperLcm's packet.
// The newest compaction in the transcript and whether it carries SuperLcm's packet.
function lastCompaction(path) {
  try {
    const size=statSync(path).size,fd=openSync(path,'r'),len=Math.min(size,4e6),buf=Buffer.alloc(len)
    readSync(fd,buf,0,len,size-len);closeSync(fd)
    const tail=buf.toString('utf8'),at=tail.lastIndexOf('"compact_boundary"')
    if(at<0)return {own:false}
    return {own:tail.slice(at,at+20000).includes('<superlcm-context ')}
  } catch { return {own:false} }
}
// The notice is worded in Claude Code's own interface language, like the line it sits next to: Claude Desktop's
// language setting when there is one (SUPERLCM_UI_LOCALE overrides), otherwise English, the terminal's only one.
function userLanguage() {
  if(process.env.SUPERLCM_UI_LOCALE)return process.env.SUPERLCM_UI_LOCALE
  const file=process.platform==='darwin'?join(homedir(),'Library/Application Support/Claude/config.json'):process.env.APPDATA?join(process.env.APPDATA,'Claude/config.json'):null
  try{return file&&JSON.parse(readFileSync(file,'utf8')).locale||'en'}catch{return 'en'}
}
const kTok=n=>`${Math.round(n/1000)}K`
function compactNotice({own,run,records,code}) {
  const zh=/^zh/i.test(userLanguage())
  // Worded like Claude Code's own "Conversation compacted" line, plus who did it and where the originals are.
  const n=records.toLocaleString('en-US'),size=run&&run.before>0?` · ${kTok(run.before)} → ${kTok(run.after)}`:''
  if(own)return zh?`对话已压缩 · SuperLcm 接管${size} · ${n} 条原文保存在 #${code}`:`Conversation compacted · by SuperLcm${size} · ${n} original records kept as #${code}`
  return zh?`对话已压缩 · Claude Code 自带压缩 · ${n} 条原文仍保存在 #${code}`:`Conversation compacted · by Claude Code · ${n} original records still kept as #${code}`
}
const derivedTitle=(store,session)=>store.eventRows(session).find(e=>e.preview.startsWith('user:'))?.preview.replace(/^user:\s*/,'').replace(/\s+/g,' ').trim().slice(0,90)
if(command==='fork-deny'){process.stdin.resume();const {deniedForkTool}=await import('./native-fork.js');process.stdout.write(JSON.stringify(deniedForkTool())+'\n')}
else if (command==='setup' || command==='doctor-local') {
  const store=new ClaudeStore()
  try {
    const {harnessConnections}=await import('./harness.js')
    if(command==='doctor-local'||!rest[0]) console.log(JSON.stringify({...await harnessConnections(store),compaction_diagnostics:store.db.prepare("SELECT session FROM sources WHERE session IN (SELECT session FROM session_origins WHERE harness='claude-code')").all().map(({session})=>({session,...store.lastCompactionDiagnostic(session),compaction_stats:store.compactionStats(session)})).filter(x=>x.status)},null,2))
    else {
      const {setupPreview,publicPreview,applySetup}=await import('./setup.js')
      const option = flag => { const i=rest.indexOf(flag); if(i<0)return undefined; if(!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Missing '+flag+' value');return rest[i+1] }
      const options={provider_ref:option('--provider-ref'),provider:option('--provider'),model:option('--model')}
      const preview=await setupPreview(store,rest[0],options)
      console.log(JSON.stringify(rest.includes('--apply')?await applySetup(store,rest[0],preview.revision,options):publicPreview(preview),null,2))
    }
  } catch(error) { console.error(error.message);process.exitCode=1 } finally {store.close()}
}
else if (command==='mcp') startServer()
else if (command==='web') {
  const port=rest[0]?Number(rest[0]):defaultPort
  try { const web=await startWeb({port});process.stdout.write(`SuperLcm local console: ${web.url}\n`) }
  catch(error) { if(error.code!=='EADDRINUSE')throw error; process.stderr.write(`Port ${port} is already in use. If the console is already running, open http://127.0.0.1:${port}/ ; otherwise pass another port: node src/cli.js web <port>\n`); process.exitCode=1 }
}
else if (['pi-prepare','pi-stage','pi-ready','pi-compact'].includes(command)) {
  const store=new ClaudeStore()
  try {
    const {preparePi,readPreparedPi,stagePi}=await import('./pi-compaction.js')
    const input=await readHook(70*1024*1024)
    // Generation is allowed only in the explicit background-preparation command.
    if(command==='pi-compact')throw Error('Pi 接管已改为后台准备，请重新加载旧版 Pi 扩展')
    process.stdout.write(JSON.stringify({prepared:command==='pi-stage'?stagePi(store,input):command==='pi-prepare'?await preparePi(store,input):readPreparedPi(store,input)})+'\n')
  } catch(error) {
    process.stdout.write(JSON.stringify({error:error.message})+'\n');process.exitCode=1
  } finally {store.close()}
}
else if (command==='pi-policy') {
  const store=new ClaudeStore()
  try {
    const {readPiPolicy,savePiPolicy}=await import('./pi-compaction-policy.js')
    const value=flag=>{const i=rest.indexOf(flag);if(i<0)return undefined;if(!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Missing '+flag+' value');return rest[i+1]}
    if(rest.includes('--enable')&&rest.includes('--disable'))throw Error('Choose --enable or --disable')
    if(rest.length&&!rest.includes('--enable')&&!rest.includes('--disable'))throw Error('Use --enable or --disable to change Pi compaction')
    if(rest.includes('--enable')) {
      const summaryMode=value('--summary-mode')||(value('--api-ref')?'api':readPiPolicy(store.dir,store.db).summaryMode)
      if(!['api','main-fork'].includes(summaryMode))throw Error('Unknown Pi summary mode')
      const ref=value('--api-ref')
      if(summaryMode!=='main-fork'&&(!ref||!store.apiModel(ref)))throw Error('Select an existing summary model with --api-ref')
      const ratio=Number(value('--ratio')??0.8)
      if(!Number.isFinite(ratio)||ratio<0.5||ratio>0.95)throw Error('Pi ratio must be 0.5–0.95')
      if(ref)store.setHarnessSetting('pi','api',null,null,null,ref)
      savePiPolicy(store,{enabled:true,ratio,summaryMode})
    } else if(rest.includes('--disable'))savePiPolicy(store,{enabled:false,ratio:readPiPolicy(store.dir).ratio})
    process.stdout.write(JSON.stringify({policy:readPiPolicy(store.dir),summary:store.harnessSetting('pi')})+'\n')
  }catch(error){process.stderr.write(error.message+'\n');process.exitCode=1}finally{store.close()}
}
// Retired hooks stay inert so an older host configuration cannot resume capture.
else if (command==='hermes-hook') { process.stdin.resume();process.stdout.write('{}\n') }
else if (command==='pi-hook') {
  // Called by the SuperLcm Pi extension after each turn.
  const store=new ClaudeStore()
  let reply={}
  try {
    const input=await readHook(),event=input.hook_event_name
    // A background summary run (SUPERLCM_CLI_WORKER) is never captured as a conversation.
    if(process.env.SUPERLCM_CLI_WORKER==='1'||!store.integrationEnabled('pi'))throw Object.assign(new Error('skip'),{quiet:true})
    const {capturePi}=await import('./pi.js')
    const result=capturePi(store,input,{automatic:true})
    if(!result.skipped&&store.source(result.session)){
      store.markClient('pi','hook')
      const {mode,model}=effective(store,result.session)
      if(['off','cli','api','main-fork'].includes(mode))store.setSummaryMode(result.session,mode)
      if(event==='session_compact')store.markCompaction(result.session)
      if(['agent_settled','session_compact','session_shutdown'].includes(event))scheduleSummary(store,result.session,mode,model)
      // Pi before_agent_start: the only moments a note can reach the AI this turn.
    }
  } catch(error) { if(!error.quiet)process.stderr.write('SuperLcm: '+error.message+'\n') }
  finally { store.close() }
  process.stdout.write(JSON.stringify(reply)+'\n')
}
// The Claude plugin brings its own hooks; an older hook in Claude's settings then stays quiet, so each turn is handled once.
else if (command==='hook' && process.env.SUPERLCM_VIA_PLUGIN!=='1' && claudePluginEnabled()) {}
else if (command==='hook' || command==='codex-hook' || command==='index' || command==='index-codex' || command==='import' || command==='name' || command==='overview' || command==='summarize') {
  const store=new ClaudeStore()
  try {
    let result
    if (command==='hook' || command==='codex-hook') {
      const codex=command==='codex-hook'
      let hookEvent
      if (process.env.SUPERLCM_CLI_WORKER !== '1') {
        const input=await readHook()
        hookEvent=input.hook_event_name
        if (store.integrationEnabled(codex?'codex':'claude-code') && input.session_id && (input.transcript_path || ['UserPromptSubmit','SessionStart'].includes(hookEvent))) {
          const event=input.hook_event_name
          const session=codex ? codexSessionKey(input.session_id) : input.session_id
          // A session that never wrote a transcript (such as `claude update`) has nothing to capture.
          const file=input.transcript_path && existsSync(input.transcript_path) ? (codex ? codexTranscript(input.transcript_path,{cwd:input.cwd}) : claudeTranscript(input.transcript_path)) : null
          const shouldIndex=['Stop','PostCompact','SessionEnd','SessionStart','UserPromptSubmit'].includes(event)
          // A conversation the user deleted in SuperLcm is not captured again automatically.
          if (shouldIndex && file && !store.isDeleted(session)) result=store.ingest(session,file,'jsonl',{automatic:true})
          if (store.source(session)) {
            store.markClient(codex?'codex':'claude-code','hook')
            const title=nativeConversationName(store,{harness:codex?'codex':'claude-code',id:input.session_id,file:file||store.source(session).path})
            store.setMetadata(session,{harness:codex?'codex':'claude-code',externalId:input.session_id,name:title||derivedTitle(store,session),nameSource:title?'native':'derived'})
            const {mode,model}=effective(store,session)
            if (['off','cli','api','main-fork'].includes(mode)) store.setSummaryMode(session,mode)
            if (event==='PostCompact' || (event==='SessionStart' && input.source==='compact')) store.markCompaction(session)
            if (shouldIndex && ['Stop','PostCompact','SessionEnd'].includes(event)) scheduleSummary(store,session,mode,model)
          }
          // After a compaction: a line for the user (systemMessage) either way, and for Claude only after Claude
          // Code's own compaction; SuperLcm's packet already says where the originals are.
          if (event==='SessionStart' && input.source==='compact' && store.source(session)) {
            const {code}=store.metadata(session),{records}=store.stats(session),run=store.takeTakeover(session)
            const last=file?lastCompaction(input.transcript_path):{own:false}
            const own=Boolean(run)||last.own
            // The sizes are SuperLcm's own estimate of the whole context. Claude Code's postTokens leaves out the
            // system prompt, tools and rule files that every request carries, so it reads far too low.
            const out={systemMessage:compactNotice({own,run,records,code})}
            if(!own)out.hookSpecificOutput={hookEventName:'SessionStart',additionalContext:`SuperLcm: this conversation was compacted, but all ${records} original records are preserved as #${code}. When an earlier detail matters, call lcm_outline {"conversation":"#${code}"} to locate it and lcm_read to quote the exact original instead of relying on the compacted summary.`}
            process.stdout.write(JSON.stringify(out)+'\n')
          }
        }
      }
      // Codex Stop requires JSON; never block the host turn or claim compaction control.
      if (codex && (hookEvent==='Stop' || process.env.SUPERLCM_CLI_WORKER==='1')) process.stdout.write('{}\n')
    } else if (command==='index' || command==='index-codex') {
      const [path,session]=rest
      if (!path||!session) throw new Error('Usage: index[-codex] <transcript_path> <source_session_id>')
      const codex=command==='index-codex', key=codex?codexSessionKey(session):session
      const file=codex?codexTranscript(path,{cwd:process.cwd()}):claudeTranscript(path)
      result=store.ingest(key,file)
      const title=nativeConversationName(store,{harness:codex?'codex':'claude-code',id:session,file})
      store.setMetadata(key,{harness:codex?'codex':'claude-code',externalId:session,name:title||derivedTitle(store,key),nameSource:title?'native':'derived'})
      // Indexing alone never starts a paid summarizer.
    } else if (command==='summarize') {
      if (!store.source(rest[0])) throw new Error('Unknown session')
      // --backend runs one explicit subscription pass (console "generate now"), independent of the saved mode.
      const backendFlag=rest.indexOf('--backend'),backend=backendFlag>=0?rest[backendFlag+1]:null
      if (backend!==null && !['cli','api','main-fork'].includes(backend)) throw new Error('--backend must be main-fork, cli or api')
      const runFlag=rest.indexOf('--run'),runId=runFlag>=0?rest[runFlag+1]:process.env.SUPERLCM_SUMMARY_RUN_ID||null
      const {runSummaryWorker}=await import('./summary-worker.js')
      try {result=await runSummaryWorker(store,rest[0],{runId,backend})}
      finally {drainSummaryQueue(store)}
    } else if (command==='import') {
      const {importFile}=await import('./store.js');result=importFile(store,rest[0],rest[1],rest[2] || 'import',rest[3])
    } else if (command==='name') result=store.nameSession(rest[0],rest.slice(1).join(' '))
    else result=store.overview(rest[0])
    if (command!=='hook' && command!=='codex-hook') process.stdout.write(JSON.stringify(result)+'\n')
  } catch(error) {process.stderr.write(`SuperLcm: ${error.message}\n`);process.exitCode=1} finally {store.close()}
} else if (command==='compact-diagnostic'||command==='summary-host-error') {
  const store=new ClaudeStore(),session=rest[0]
  try {
    if(session&&store.source(session)){
      if(command==='compact-diagnostic')store.noteCompaction(session,compactionDiagnostic({error:true},{records:store.stats(session).records}))
      else {
        const input=await readHook().catch(()=>({}))
        const claim=store.db.prepare('SELECT * FROM host_summary_claims WHERE session=?').get(session)
        // Cancellation or another writer taking ownership is not a failure of
        // the current settings. Do not overwrite that writer's healthy status.
        const revision=summarySettingsRevision(store,session)
        if(store.ownsLease(session,'host')&&claim?.revision===revision&&hostClaimMatches(claim,input,revision)&&(!claim.deadline_ms||Date.now()<claim.deadline_ms)){
          if(claim.run_id)finishSummaryRun(store,claim.run_id,{owner:'host:'+claim.claim_id,state:'failed',error:Object.assign(Error('Host summary failed'),{summaryKind:'host'})})
          else {store.recordSummaryError(session,Error('Host summary failed'));store.setStatus(session,'summary_error')}
          store.failSummaryBatch(session,claim.batch_id,claim.revision)
        }
      }
    }
    process.stdout.write('{}\n')
  }finally{store.close()}
} else if (command?.startsWith('compact-rescue-')) {
  let store
  const session=rest[0]
  let reply={use:false}
  try {
    const input=JSON.parse(await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{text+=part;if(text.length>32e6)reject(Error('Oversized compaction input'))});process.stdin.on('end',()=>resolve(text));process.stdin.on('error',reject)}))
    // The cancellation fence must be written before constructor/schema waits on SQLite.
    if(command==='compact-rescue-stop'){const {revokeClaudeRescue}=await import('./claude-rescue-cancellation.js');revokeClaudeRescue(session,input)}
    store=new ClaudeStore()
    const {prepareClaudeRescue,checkClaudeRescue,saveClaudeRescue,stopClaudeRescue}=await import('./claude-rescue-store.js')
    const action={'compact-rescue-prepare':prepareClaudeRescue,'compact-rescue-check':checkClaudeRescue,'compact-rescue-save':saveClaudeRescue,'compact-rescue-stop':stopClaudeRescue}[command]
    if(action&&session)reply=action(store,session,input)
  }catch{reply={use:false,error:true}}
  finally{store?.close()}
  process.stdout.write(JSON.stringify(reply)+'\n')
} else if (command==='compact-packet') {
  // Called by the plugin's compaction module (hooks/compact-mod.js) with the live transcript on stdin.
  // Always answers JSON; { use:false, reason } hands the compaction back to Claude Code.
  let reply,dryRun=false
  const store=new ClaudeStore()
  try {
    const input=JSON.parse(await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{text+=part;if(text.length>32e6)reject(new Error('Oversized compaction input'))});process.stdin.on('end',()=>resolve(text))}))
    dryRun=input.dry===true
    const session=rest[0],setting=store.takeover()
    // A conversation the Claude app continued under a new ID can compact before any hook recorded it (its
    // transcript may appear only after SessionStart): record it here, the way the hooks would.
    if(session&&setting.enabled&&process.env.SUPERLCM_CLI_WORKER!=='1'&&!store.source(session)&&!store.isDeleted(session)&&store.integrationEnabled('claude-code'))try{
      const found=firstTranscript(session),file=found&&claudeTranscript(found)
      if(file){
        store.ingest(session,file)
        const title=nativeConversationName(store,{harness:'claude-code',id:session,file})
        store.setMetadata(session,{harness:'claude-code',externalId:session,name:title||derivedTitle(store,session),nameSource:title?'native':'derived'})
      }
    }catch{}
    const src=session&&store.source(session)
    if(!setting.enabled)reply={use:false,reason:'compaction takeover is off'}
    else if(!src||store.isDeleted(session))reply={use:false,reason:'conversation not recorded by SuperLcm'}
    else {
      if(existsSync(src.path)&&store.ingest(session,src.path,'jsonl',{automatic:true}).skipped)throw Error('conversation deleted during capture') // newest turns
      const {planCompaction}=await import('./compaction.js')
      const {verifiedCompactionInput}=await import('./claude-compaction-input.js')
      const {verifiedActiveMessages,verifiedCompactionCut,explainActiveMismatch}=await import('./claude-rescue-source.js')
      const plan=(target=session)=>{
        const current=store.takeover()
        if(!current.enabled)return {use:false,reason:'compaction takeover is off'}
        if(current.ratio!=null&&!(input.window>0))return {use:false,reason:'current model capacity unavailable'}
        store.repairTakeoverCopies(target)
        store.recertifyClaudeNodes(target)
        const context=verifiedCompactionInput(store,target,input.messages||[])
        // Sizes are planned against where Claude Code compacts. An automatic compaction starts there, so the context
        // now bounds it whatever the settings say: a packet planned for a larger window would compact again at once.
        const at=claudeCompactAt(current,input.window||0),window=input.trigger==='auto'&&input.tokens>0?Math.min(at,input.tokens):at
        const result=planCompaction({meta:store.metadata(target),events:context.events,nodes:claudeCompactionNodes(store,target),messages:context.messages,instructions:input.instructions||'',tokens:input.tokens||0,window,keepTokens:current.keep,trigger:input.trigger})
        const active=result.use?verifiedActiveMessages(store,target,input.messages||[],{requireLatest:false}):null
        if(!result.use||verifiedCompactionCut(active,result))return result
        let detail;try{detail=active?{matched:active.length,start:result.start,through:result.through,lastActive:active.at(-1).ordinal,nonTextBeforeCut:active.slice(0,result.start).filter(m=>m.nonText).map(m=>m.ordinal).slice(0,10),beyondThrough:active.slice(0,result.start).filter(m=>m.ordinal>result.through).length}:explainActiveMismatch(store,target,input.messages||[])}catch(error){detail={error:String(error?.message||error).slice(0,200)}}
        return {use:false,reason:'the live conversation is not fully verified in the archive; use native compaction',after:result.after,verify:detail}
      }
      // A compaction after the cache expired that does not happen leaves no record: nothing compacted natively.
      // Coverage is that of the conversation whose summaries the packet uses (the parent's for stage 'parent').
      let covered=session
      // One after the cache expired or at the end of a turn is SuperLcm's own: it compacts or is skipped, and is never
      // handed to Claude Code. A dry run (the module checking a turn-end compaction first) changes nothing.
      const cold=input.trigger==='cold',quiet=cold||input.trigger==='turn-end',dry=dryRun
      const note=(result,stage,catchupMs=null)=>dry?null:quiet&&!result.use?noteCompactionDetail(store,session,result,input):(noteCompactionDetail(store,session,result,input),store.noteCompaction(session,{...compactionDiagnostic(result,{nodes:store.nodeRows(covered,0),records:store.stats(covered).records,before:input.tokens||0,trigger:input.trigger}),stage:stage||(result.stage==='inline'||result.inline?'inline':'first'),pending:pendingLeaves(store,covered),after:result.after??null,catchupMs}))
      const notePlan=(result,stage,ms=null)=>{
        if(result.initial){note(result.initial,stage||'first',ms);note(result,'inline',ms)}
        else note(result,stage,ms)
      }
      // A conversation continued under a new ID opens with its parent's packet and carries the parent's records
      // after it, uuids included, so the parent's summaries cover them until this one has its own.
      const parent=()=>{
        const code=/^\s*<superlcm-context conversation="#([0-9a-f]{5})"/.exec(input.messages?.[0]?.text||'')?.[1]
        if(!code||code===shortCode(session))return null
        const found=store.db.prepare('SELECT session FROM sources').all().map(r=>r.session).filter(s=>shortCode(s)===code&&!store.isDeleted(s))
        return found.length===1&&store.metadata(found[0]).harness==='claude-code'?found[0]:null
      }
      // A request can read the cache between the module's cold-check and this compaction: then it is warm again.
      const cache=cold?cacheExpiry(store,session):null,expired=!!cache&&Date.now()>=cache.expiresAt
      reply=cold&&!expired?{use:false,reason:'the session was used again after its cache expired'}:plan()
      let stage=input.afterCatchup?'catchup':null
      if(!reply.use&&!reply.ambiguous&&(!cold||expired)){const from=parent(),inherited=from&&plan(from);if(inherited?.use){reply=inherited;stage='parent';covered=from}}
      // After the cache expired, compacting pays only when the packet is at most half of what would be re-cached; at the
      // end of a turn, only one that leaves the next turn real room is worth doing ahead of the threshold.
      if(quiet&&reply.use&&reply.after>(input.tokens||0)*.5)reply={use:false,reason:cold?'a compaction after the cache expired would not halve the context':'a compaction at the end of a turn would not halve the context'}
      // One SuperLcm declines is not tried again until the next main-thread response.
      if(cold&&expired&&!reply.use&&!dry)store.noteColdTried(session,cache.at)
      notePlan(reply,stage,input.afterCatchup&&Number.isFinite(input.catchupMs)?input.catchupMs:null)
      const eligible=['coverage_lag','uncovered_oldest','no_summaries','context_too_large'].includes(compactionDiagnostic(reply).code)
      const chosen=effective(store,session),harness=store.metadata(session).harness
      // SuperLcm's own compaction schedules nothing: it is skipped, not handed to Claude Code.
      const mayWrite=!quiet&&store.integrationEnabled(harness)&&harness==='claude-code'&&['cli','api'].includes(chosen.mode)
      if(!reply.use&&!reply.ambiguous&&eligible&&mayWrite){
        store.setSummaryFlush(session,store.db.prepare('SELECT MAX(ordinal) AS o FROM events WHERE session=?').get(session)?.o??-1)
      }
      if(input.trigger!=='precompute'&&!quiet&&!input.afterCatchup&&!reply.use&&!reply.ambiguous&&reply.stage!=='inline'&&!reply.inline&&eligible){
        const pending=pendingLeaves(store,session),deadlineMs=catchupDeadlineMs(),chosen=effective(store,session),harness=store.metadata(session).harness
        if(deadlineMs>0&&pending>=1&&pending<=4&&store.integrationEnabled(harness)&&['cli','api'].includes(chosen.mode)){
          if(chosen.mode==='cli'&&hostWriterTool(harness)==='claude-code')reply={...reply,catchup:{host:true,deadlineMs,maxPieces:4}}
          else {
            const started=Date.now()
            try{await catchUp(store,session,{deadlineMs,maxPieces:4})}catch{}
            reply=plan();reply.catchup=true
            notePlan(reply,'catchup',Date.now()-started)
          }
        }
      }
      // Schedule only after bounded caller catch-up has had its chance. A
      // competing worker must not steal its lease or publish its late result.
      if(!reply.use&&!reply.ambiguous&&mayWrite&&['coverage_lag','uncovered_oldest','no_summaries','context_too_large'].includes(compactionDiagnostic(reply).code)){
        const work=summaryWork(store,session),revision=summarySettingsRevision(store,session)
        if(work&&!store.summaryRetry(session,work.batch_id,revision)){
          reply.retry=chosen.mode==='cli'&&hostWriterTool(harness)==='claude-code'?'host':true
          if(reply.retry!=='host'&&!reply.catchup)try{
            const scheduled=scheduleSummary(store,session,chosen.mode,chosen.model)
            if(!scheduled&&!store.summarizing(session)&&!activeSummaryRun(store,session))delete reply.retry
          }catch{delete reply.retry}
        }
      }
      if(reply.use&&!dry)store.noteTakeover(session,input.tokens||0,reply.after||0)
      else if(!quiet&&chosen.mode!=='main-fork'&&!reply.ambiguous&&store.integrationEnabled('claude-code')&&store.metadata(session).harness==='claude-code'&&['coverage_lag','uncovered_oldest','no_summaries','context_too_large','unplaced_boundary'].includes(compactionDiagnostic(reply).code))reply.rescue=true
    }
    if(src&&!dryRun&&(!setting.enabled||store.isDeleted(session)))store.noteCompaction(session,compactionDiagnostic(reply,{nodes:store.nodeRows(session,0),records:store.stats(session).records,before:input.tokens||0,trigger:input.trigger}))
  } catch(error) { reply={use:false,reason:'compaction planner failed; originals retained',error:true};if(!dryRun&&rest[0]&&store.source(rest[0]))store.noteCompaction(rest[0],compactionDiagnostic(reply,{records:store.stats(rest[0]).records})) }
  finally { store.close() }
  process.stdout.write(JSON.stringify(reply)+'\n')
} else if (command==='summary-tick') {
  const store=new ClaudeStore()
  let reply
  const flag=name=>{const at=rest.indexOf(name),n=at<0?0:Number(rest[at+1]);return Number.isSafeInteger(n)&&n>0?n:0}
  try{reply=summaryTick(store,rest[0],{tokens:flag('--tokens'),window:flag('--window'),fork:rest.includes('--fork')})}catch{reply={error:'Summary tick failed; originals retained'}}
  finally{store.close()}
  process.stdout.write(JSON.stringify(reply)+'\n')
} else if (command==='cold-check') {
  // 缓存过期压缩 (hooks/compact-mod.js): whether this idle session should compact now that its cache expired.
  const store=new ClaudeStore()
  let reply
  const flag=name=>{const at=rest.indexOf(name),n=at<0?0:Number(rest[at+1]);return Number.isSafeInteger(n)&&n>0?n:0}
  // --touched: the module saw a request billed to the session that may have read the main cache.
  try{reply=rest[0]&&store.source(rest[0])?coldCompactionDue(store,rest[0],{tokens:flag('--tokens'),window:flag('--window'),touched:flag('--touched')}):{none:'not recorded'}}catch{reply={none:'check failed'}}
  finally{store.close()}
  process.stdout.write(JSON.stringify(reply)+'\n')
} else if (command==='end-check') {
  // 回合末压缩 (hooks/compact-mod.js): whether to compact at the end of this turn, ahead of the threshold.
  const store=new ClaudeStore()
  let reply
  const flag=name=>{const at=rest.indexOf(name),n=at<0?0:Number(rest[at+1]);return Number.isSafeInteger(n)&&n>0?n:0}
  // --grew: how much the turn that just ended added to the context.
  try{reply=rest[0]&&store.source(rest[0])?endCompactionDue(store,rest[0],{tokens:flag('--tokens'),window:flag('--window'),grew:flag('--grew')}):{none:'not recorded'}}catch{reply={none:'check failed'}}
  finally{store.close()}
  process.stdout.write(JSON.stringify(reply)+'\n')
} else if (command==='fork-claim'||command==='fork-settle') {
  // 主模型分支 inside Claude Code (hooks/compact-mod.js): the module answers fork-claim's directive with
  // $.model.fork and hands the reply to fork-settle. A fork this process cannot run yet goes to `claude --resume`.
  const store=new ClaudeStore(),session=rest[0]
  let reply={}
  try {
    if(!session||!store.source(session)||store.isDeleted(session))throw Object.assign(Error('conversation not recorded by SuperLcm'),{none:true})
    if(!store.integrationEnabled('claude-code')||store.metadata(session).harness!=='claude-code')throw Object.assign(Error('Integration is disconnected'),{none:true})
    if(command==='fork-claim'){
      if(store.effectiveSetting(session).mode!=='main-fork')throw Object.assign(Error('summaries are not written by a main-thread fork'),{none:true})
      reply=claimHostFork(store,session)
    }else{
      reply=settleHostFork(store,session,await readHook(1000000))
      if(reply.handoff)scheduleSummary(store,session,'main-fork',null,{handoff:true})
    }
  } catch(error) { reply=error.none?{none:error.message}:{error:error.message} }
  finally { store.close() }
  process.stdout.write(JSON.stringify(reply)+'\n')
} else if (['summary-host','summary-claim','summary-save','summary-handoff','summary-check','summary-release'].includes(command)) {
  // 本工具后台写 inside Claude Code (hooks/compact-mod.js, 2.1.286+): the module asks for the next piece
  // (summary-claim), writes it with $.model.complete on the session's own login, and hands it back
  // (summary-save). summary-host marks the session at its start so the Stop hook does not also start a
  // `claude -p`; summary-handoff, at the end or after a failed call, gives the rest back to that worker.
  // Always answers one line of JSON.
  const store=new ClaudeStore(),session=rest[0]
  let reply={}
  try {
    if(!session)throw new Error('Usage: '+command+' <session>')
    if(!store.integrationEnabled(store.metadata(session).harness))throw Object.assign(Error('Integration is disconnected'),{none:true})
    if(command==='summary-host'){store.setHostWriter(session,true);store.setHostForker(session,rest.includes('--fork'))}
    else if(command==='summary-release'){
      const input=await readHook(),claim=store.db.prepare('SELECT * FROM host_summary_claims WHERE session=?').get(session)
      if(hostClaimMatches(claim,input,summarySettingsRevision(store,session))&&input.batch_id===claim.batch_id){if(claim.run_id)finishSummaryRun(store,claim.run_id,{owner:'host:'+claim.claim_id,state:'stopped',reason:'host-released'});store.releaseHostClaim(session,claim.claim_id)}
    }
    else if(command==='summary-handoff'){
      store.setHostForker(session,false)
      const input=await readHook().catch(()=>({})),claim=store.db.prepare('SELECT * FROM host_summary_claims WHERE session=?').get(session)
      const active=store.ownsLease(session,'host'),revision=summarySettingsRevision(store,session)
      if(hostClaimMatches(claim,input,revision)||!input.claim_id&&!active){
        const run=activeSummaryRun(store,session)
        if(run?.route==='host'&&(!active||claim?.run_id===run.id))finishSummaryRun(store,run.id,{state:'stopped',reason:'host-handoff'})
        if(store.hostWriter(session)){store.setHostWriter(session,false);if(claim)store.releaseHostClaim(session,claim.claim_id);else store.release(session,'host')}
        if(store.source(session)&&!store.isDeleted(session)){const {mode,model}=effective(store,session);scheduleSummary(store,session,mode,model)}
      }
    } else {
      const src=store.source(session)
      if(!src||store.isDeleted(session))throw Object.assign(new Error('conversation not recorded by SuperLcm'),{none:true})
      const {mode,model}=effective(store,session)
      if(mode!=='cli'||hostWriterTool(store.metadata(session).harness)!=='claude-code')throw Object.assign(new Error('summaries are not written by Claude Code for this conversation'),{none:true})
      if(command==='summary-check'){
        const input=await readHook(),claim=store.db.prepare('SELECT * FROM host_summary_claims WHERE session=?').get(session)
        const revision=summarySettingsRevision(store,session)
        const valid=!!claim&&claim.batch_id===input.batch_id&&hostClaimMatches(claim,input,revision)&&(!claim.deadline_ms||Date.now()<claim.deadline_ms)&&claim.revision===revision&&store.db.prepare('SELECT owner FROM leases WHERE session=?').get(session)?.owner==='host'&&store.summarizing(session)
        if(valid)store.renewLease(session,300000,'host')
        if(valid&&claim.run_id)progressSummaryRun(store,claim.run_id,'host:'+claim.claim_id)
        reply={valid,...(claim?.claim_id&&!input.claim_id?{reason:'Summary claim ID required; reload the SuperLcm plugin in this session'}:{})}
      }else if(command==='summary-claim'){
        store.recoverSummaryRuns()
        store.setHostWriter(session,true)
        if(existsSync(src.path)&&store.ingest(session,src.path,'jsonl',{automatic:true}).skipped)throw Error('conversation deleted during capture')
        const leafOnly=rest.includes('--leaf'),deadlineAt=rest.indexOf('--deadline'),deadline=deadlineAt<0?0:Number(rest[deadlineAt+1])
        if(!Number.isSafeInteger(deadline)||deadline<0||(deadline&&deadline<=Date.now()))throw Object.assign(Error('Catch-up deadline reached'),{none:true})
        const work=summaryWork(store,session,{leafOnly}),revision=summarySettingsRevision(store,session)
        if(!work)reply={none:'nothing to summarize yet'}
        else if(store.summaryRetry(session,work.batch_id,revision))reply={none:'summary retry cooldown'}
        else {
          let currentRun=activeSummaryRun(store,session)
          if(currentRun?.route==='host'&&currentRun.state==='queued'&&currentRun.revision!==revision){finishSummaryRun(store,currentRun.id,{state:'stopped',reason:'settings-changed'});currentRun=null}
          const queued=currentRun?{run:currentRun,added:false}:enqueueSummaryRun(store,session,{route:'host',origin:leafOnly?'catchup':'host',model,revision,planned:1})
          if(queued.run.route!=='host'||queued.run.state!=='queued')throw Object.assign(Error('busy'),{none:true})
          if(!reserveSummaryRun(store,{id:queued.run.id,limit:summaryConcurrency()}))throw Object.assign(Error('Summary queue is busy'),{none:true})
          if(!store.lease(session,300000,'host')){finishSummaryRun(store,queued.run.id,{state:'stopped',reason:'busy'});throw Object.assign(Error('busy'),{none:true})}
          const claimId=randomUUID()
          store.db.prepare('INSERT INTO host_summary_claims(session,batch_id,revision,claim_id,leaf_only,deadline_ms,run_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET batch_id=excluded.batch_id,revision=excluded.revision,claim_id=excluded.claim_id,leaf_only=excluded.leaf_only,deadline_ms=excluded.deadline_ms,run_id=excluded.run_id').run(session,work.batch_id,revision,claimId,leafOnly?1:0,deadline,queued.run.id)
          bindSummaryRun(store,queued.run.id,{owner:'host:'+claimId})
          progressSummaryRun(store,queued.run.id,'host:'+claimId,{first:work.first,last:work.last})
          const task=adaptiveSummaryTask(work,readSummaryProfile(profileKey('claude-host',model||'configured',null),store))
          reply={work:{task:{level:work.level,first:work.first,last:work.last,maxChars:task.maxChars,requestChars:task.requestChars,language:task.language,requireHeading:true},maxTokens:visibleOutputRoom(work.content),batch_id:work.batch_id,claim_id:claimId,revision,system:SUMMARY_SYSTEM,prompt:buildSummaryPrompt(work.content,task),parts:summaryPromptParts(work.content,task),model:model||process.env.SUPERLCM_CLAUDE_CLI_MODEL||'',ready:hostDraft(store,session,work,revision)}}
        }
      } else {
        const input=await readHook()
        const claim=store.db.prepare('SELECT * FROM host_summary_claims WHERE session=?').get(session)
        const current=()=>{
          const active=store.db.prepare('SELECT * FROM host_summary_claims WHERE session=?').get(session)
          const revision=summarySettingsRevision(store,session)
          return !!claim&&active?.claim_id===claim.claim_id&&active.batch_id===input.batch_id&&hostClaimMatches(claim,input,revision)&&claim.revision===revision&&(!claim.deadline_ms||Date.now()<claim.deadline_ms)&&(!input.deadline_ms||Date.now()<input.deadline_ms)
        }
        let persistence=false
        try {
          if(hostSavedReceipt(store,session,input,summarySettingsRevision(store,session))){
            reply={saved:true,more:Boolean(summaryWork(store,session)),reused:true}
          }else {
          if (input.isAnswered === false) throw new Error('Summary generation was incomplete')
          let summary=checkedSummary(input.summary,{finishReason:input.finishReason})
          const work=summaryWork(store,session,{leafOnly:!!claim?.leaf_only})
          if(!store.summarizing(session)||store.db.prepare('SELECT owner FROM leases WHERE session=?').get(session)?.owner!=='host')throw new Error('no summary claimed in this conversation')
          if(!work||work.batch_id!==input.batch_id)throw new Error('stale summary batch')
          if(claim?.claim_id&&!input.claim_id)throw Error('Summary claim ID required; reload the SuperLcm plugin in this session')
          if(!claim||claim.batch_id!==input.batch_id||!current())throw Error('Summary setting changed, claim replaced or deadline reached; result not saved')
          summary=checkedSummary(summary,work)
          if(work.reducedSources&&!isReducedSummary(summary))summary=checkedSummary(summary.slice(0,5500)+'\n\n'+reducedNotice(work))
          if(Number.isFinite(input.overshoot))updateSummaryProfile(profileKey('claude-host',model||'configured',null),{overshoot:input.overshoot},store)
          if(summary.length<20)throw new Error('summary too short')
          if(work.level===0)for(let i=work.first;i<=work.last;i++)store.exact(session,i)
          persistence=true
          retainHostDraft(store,session,work,claim,input,summary)
          store.addNode({session,id:work.batch_id,level:work.level,first:work.first,last:work.last,children:work.children,summary,sourceComplete:!work.reducedSources,digest:work.digest,model:`claude-code-host:${String(input.model||'configured').slice(0,80)}`},{leaseOwner:'host',validate:current})
          store.completeSummaryBatch(session,work.batch_id,claim.revision)
          if(claim.run_id){progressSummaryRun(store,claim.run_id,'host:'+claim.claim_id,{created:1});finishSummaryRun(store,claim.run_id,{owner:'host:'+claim.claim_id,state:'done'})}else store.setStatus(session,'ok')
          reply={saved:true,more:Boolean(summaryWork(store,session))}
          }
        } catch(error){if(persistence&&current())error.retrySave=true;if(claim?.run_id&&hostClaimMatches(claim,input,summarySettingsRevision(store,session)))finishSummaryRun(store,claim.run_id,{owner:'host:'+claim.claim_id,state:'failed',error});throw error}
        finally { if(hostClaimMatches(claim,input,summarySettingsRevision(store,session)))store.releaseHostClaim(session,claim.claim_id) }
      }
    }
  } catch(error) { reply=error.none?{none:error.message}:{error:error.message,...(error.retrySave?{retrySave:true}:{})} }
  finally { store.close() }
  process.stdout.write(JSON.stringify(reply)+'\n')
} else if (command==='archive') {
  // Copy every conversation's indexed originals into the private archive (safe to repeat).
  const store=new ClaudeStore()
  try { const results=store.archiveAll(); for(const r of results)if(!r.archived||r.copied||r.found_at)process.stdout.write(JSON.stringify(r)+'\n'); process.stdout.write(`archived ${results.filter(r=>r.archived).length}/${results.length} conversations\n`); if(results.some(r=>!r.archived))process.exitCode=1 }
  finally { store.close() }
} else { process.stderr.write('Usage: node src/cli.js mcp|web [port]|archive|compact-packet <session>|doctor-local|setup <codex|claude-code|pi|dsh> [--provider name] [--model name] [--apply]|hook|codex-hook|pi-hook|index|index-codex|import <path> [session] [harness] [name]|name <session> <title>|overview|summarize\n'); process.exitCode=2 }
