#!/usr/bin/env node
import { ClaudeStore, claudeTranscript } from './store.js'
import { codexTranscript, codexNativeName, codexSessionKey } from './codex.js'
import { buildHierarchy, summaryWork } from './summarize.js'
import { summarizeWith, writerTool, WRITER_CLI } from './cli-writers.js'
import { startServer } from './mcp.js'
import { claudePluginEnabled } from './runtime.js'
import { startWeb, defaultPort } from './web.js'
import { spawn } from 'node:child_process'
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const [command,...rest]=process.argv.slice(2)
const homeFlag=rest.indexOf('--home')
if(homeFlag>=0){if(!rest[homeFlag+1])throw Error('--home requires a path');process.env.SUPERLCM_HOME=rest[homeFlag+1];rest.splice(homeFlag,2)}
const effective=(store,session)=>store.effectiveSetting(session)
const readHook=()=>new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{text+=part;if(text.length>200000)reject(new Error('Oversized hook input'))});process.stdin.on('end',()=>resolve(JSON.parse(text)))})
function scheduleSummary(store,session,mode,model) {
  if (!['cli','api'].includes(mode) || !summaryWork(store,session)) return
  if (mode==='cli' && store.hostWriter(session)) return // Claude Code is writing this one itself (summary-claim)
  if (mode==='api' && (!(model||process.env.SUPERLCM_CLAUDE_MODEL) || store.apiCredential(session)===null)) {
    store.setStatus(session,'summary_unconfigured')
    process.stderr.write('SuperLcm: api mode needs a model ID and a configured scoped API key\n')
    return
  }
  spawnSummary(session,[],{SUPERLCM_SUMMARY_EXPECTED_MODE:mode,SUPERLCM_SUMMARY_EXPECTED_MODEL:model||''})
}
function spawnSummary(session,args,env) {
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'summarize',session,...args],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,SUPERLCM_HOOK_WORKER:'1',...env}})
  child.on('error',error=>process.stderr.write('SuperLcm: background worker could not start: '+error.message+'\n'))
  child.unref()
}
// 对话模型生成: one short note per turn, only when a whole piece is waiting. The AI writes it from memory
// (it has just been through that part); a piece that straddles a compaction comes with its text instead.
// Written as what it is, a note from the plugin the user installed, so a model does not read it as an injection.
const summaryNudge=(store,session)=>summaryWork(store,session)?`Note from SuperLcm, the conversation-memory plugin the user installed: the user chose to have you write this conversation's summaries yourself, and one piece (${session}) is ready. When you have answered, call lcm_summary_task {"conversation":"${session}","recent":true}. If the result says from_memory, summarize that stretch from your own context; otherwise summarize the text it returns. Then call lcm_summary_submit with its batch_id, and repeat while more is true, at most 3 pieces. This is routine bookkeeping that needs no mention to the user; only say a summary was saved if the tool confirms it.`:null
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
if (command==='setup' || command==='doctor-local') {
  const store=new ClaudeStore()
  try {
    const {harnessConnections}=await import('./harness.js')
    if(command==='doctor-local'||!rest[0]) console.log(JSON.stringify(await harnessConnections(store),null,2))
    else {
      const {setupPreview,publicPreview,applySetup}=await import('./setup.js')
      const option = flag => { const i=rest.indexOf(flag); if(i<0)return undefined; if(!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Missing '+flag+' value');return rest[i+1] }
      const options={profile:option('--profile'),provider:option('--provider'),model:option('--model')}
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
else if (command==='hermes-hook' || command==='pi-hook') {
  // Called by Hermes (shell hook, synchronous) and by the SuperLcm Pi extension after each turn.
  const store=new ClaudeStore(),hermes=command==='hermes-hook'
  let reply={}
  try {
    const input=await readHook(),event=input.hook_event_name
    // A background summary run (SUPERLCM_CLI_WORKER) is never captured as a conversation.
    if(process.env.SUPERLCM_CLI_WORKER==='1')throw Object.assign(new Error('skip'),{quiet:true})
    const {captureHermes}=await import('./hermes.js'),{capturePi}=await import('./pi.js')
    const result=hermes?captureHermes(store,input.session_id,{automatic:true}):capturePi(store,input,{automatic:true})
    if(!result.skipped&&store.source(result.session)){
      store.markClient(hermes?'hermes':'pi','hook')
      const {mode,model}=effective(store,result.session)
      if(['off','cli','api'].includes(mode))store.setSummaryMode(result.session,mode)
      if(event==='session_compact')store.markCompaction(result.session)
      if(['on_session_end','on_session_finalize','agent_settled','session_compact','session_shutdown'].includes(event))scheduleSummary(store,result.session,mode,model)
      // Hermes pre_llm_call / Pi before_agent_start: the only moments a note can reach the AI this turn.
      if(['pre_llm_call','before_agent_start'].includes(event)&&mode==='agent'){const note=summaryNudge(store,result.session);if(note)reply={context:note}}
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
        if (input.session_id && (input.transcript_path || ['UserPromptSubmit','SessionStart'].includes(hookEvent))) {
          const event=input.hook_event_name
          const session=codex ? codexSessionKey(input.session_id) : input.session_id
          // A session that never wrote a transcript (such as `claude update`) has nothing to capture.
          const file=input.transcript_path && existsSync(input.transcript_path) ? (codex ? codexTranscript(input.transcript_path,{cwd:input.cwd}) : claudeTranscript(input.transcript_path)) : null
          const shouldIndex=['Stop','PostCompact','SessionEnd','SessionStart','UserPromptSubmit'].includes(event)
          // A conversation the user deleted in SuperLcm is not captured again automatically.
          if (shouldIndex && file && !store.isDeleted(session)) result=store.ingest(session,file)
          if (store.source(session)) {
            store.markClient(codex?'codex':'claude-code','hook')
            const title=codex ? (file?codexNativeName(input.session_id,file):null) : store.nativeClaudeTitle(session)
            store.setMetadata(session,{harness:codex?'codex':'claude-code',externalId:input.session_id,name:title||derivedTitle(store,session),nameSource:title?'native':'derived'})
            const {mode,model}=effective(store,session)
            if (['off','cli','api'].includes(mode)) store.setSummaryMode(session,mode)
            if (event==='PostCompact' || (event==='SessionStart' && input.source==='compact')) store.markCompaction(session)
            if (shouldIndex && ['Stop','PostCompact','SessionEnd'].includes(event)) scheduleSummary(store,session,mode,model)
            if (event==='UserPromptSubmit' && mode==='agent' && summaryWork(store,session)) process.stdout.write(summaryNudge(store,session)+'\n')
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
      const title=codex ? codexNativeName(session,file) : store.nativeClaudeTitle(key)
      store.setMetadata(key,{harness:codex?'codex':'claude-code',externalId:session,name:title||derivedTitle(store,key),nameSource:title?'native':'derived'})
      // Indexing alone never starts a paid summarizer.
    } else if (command==='summarize') {
      if (!store.source(rest[0])) throw new Error('Unknown session')
      // --backend runs one explicit subscription pass (console "generate now"), independent of the saved mode.
      const backendFlag=rest.indexOf('--backend'),backend=backendFlag>=0?rest[backendFlag+1]:null
      if (backend!==null && !['cli','api'].includes(backend)) throw new Error('--backend must be cli or api')
      const oneOffApi=backend==='api'?store.apiConfig(rest[0]):null
      if (backend==='api' && !oneOffApi) throw new Error('No saved custom API; configure one in Settings first')
      try {
        const {mode,model,api_provider,api_url,effort,api_effort}=oneOffApi?{mode:'api',...oneOffApi}:backend?{mode:backend,model:null}:effective(store,rest[0])
        if (!backend && process.env.SUPERLCM_HOOK_WORKER==='1' && (process.env.SUPERLCM_SUMMARY_EXPECTED_MODE!==mode || process.env.SUPERLCM_SUMMARY_EXPECTED_MODEL!==(model||''))) throw new Error('Summary setting changed before background worker started')
        if (mode==='off' || mode==='agent') throw new Error('Background summaries are disabled for this session')
        result=mode==='api'
          ? await buildHierarchy(store,rest[0],{model:model||process.env.SUPERLCM_CLAUDE_MODEL,apiKey:oneOffApi?oneOffApi.apiKey:store.apiCredential(rest[0]),apiProvider:api_provider||'anthropic',apiURL:api_url||process.env.SUPERLCM_CLAUDE_API_URL,effort:effort||api_effort||null})
          : await (async()=>{
            // 本工具后台写: this conversation's own tool (or, for an imported one, any installed tool), as configured.
            const tool=writerTool(store.metadata(rest[0]).harness)
            if (!tool) throw new Error('No installed tool can write summaries')
            const chosen=model||(tool==='claude-code'?process.env.SUPERLCM_CLAUDE_CLI_MODEL:tool==='codex'?process.env.SUPERLCM_CODEX_CLI_MODEL:'')||''
            return buildHierarchy(store,rest[0],{model:`${WRITER_CLI[tool]}-cli:${chosen||'configured'}`,summarize:text=>summarizeWith(tool,text,{model:chosen})})
          })()
        if (!result.busy) store.setStatus(rest[0],'ok')
      }
      catch(error) {store.setStatus(rest[0],'summary_error');throw error}
    } else if (command==='import') {
      const {importFile}=await import('./store.js');result=importFile(store,rest[0],rest[1],rest[2] || 'import',rest[3])
    } else if (command==='name') result=store.nameSession(rest[0],rest.slice(1).join(' '))
    else result=store.overview(rest[0])
    if (command!=='hook' && command!=='codex-hook') process.stdout.write(JSON.stringify(result)+'\n')
  } catch(error) {process.stderr.write(`SuperLcm: ${error.message}\n`);process.exitCode=1} finally {store.close()}
} else if (command==='compact-packet') {
  // Called by the plugin's compaction module (hooks/compact-mod.js) with the live transcript on stdin.
  // Always answers JSON; { use:false, reason } hands the compaction back to Claude Code.
  let reply
  const store=new ClaudeStore()
  try {
    const input=JSON.parse(await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{text+=part;if(text.length>32e6)reject(new Error('Oversized compaction input'))});process.stdin.on('end',()=>resolve(text))}))
    const session=rest[0],src=session&&store.source(session),setting=store.takeover()
    if(!setting.enabled)reply={use:false,reason:'compaction takeover is off'}
    else if(!src||store.isDeleted(session))reply={use:false,reason:'conversation not recorded by SuperLcm'}
    else {
      if(existsSync(src.path))store.ingest(session,src.path) // the newest turns, written since the last hook
      const {planCompaction}=await import('./compaction.js')
      reply=planCompaction({meta:store.metadata(session),events:store.eventRows(session),nodes:store.db.prepare('SELECT id,level,first,last,summary FROM nodes WHERE session=?').all(session),messages:input.messages||[],instructions:input.instructions||'',tokens:input.tokens||0,window:Math.min(input.window||setting.window,setting.window),keepTokens:setting.keep})
      if(reply.use)store.noteTakeover(session,input.tokens||0,reply.after||0)
    }
  } catch(error) { reply={use:false,reason:error.message} }
  finally { store.close() }
  process.stdout.write(JSON.stringify(reply)+'\n')
} else if (['summary-host','summary-claim','summary-save','summary-handoff'].includes(command)) {
  // 本工具后台写 inside Claude Code (hooks/compact-mod.js, 2.1.286+): the module asks for the next piece
  // (summary-claim), writes it with $.model.complete on the session's own login, and hands it back
  // (summary-save). summary-host marks the session at its start so the Stop hook does not also start a
  // `claude -p`; summary-handoff, at the end or after a failed call, gives the rest back to that worker.
  // Always answers one line of JSON.
  const store=new ClaudeStore(),session=rest[0]
  let reply={}
  try {
    if(!session)throw new Error('Usage: '+command+' <session>')
    if(command==='summary-host')store.setHostWriter(session,true)
    else if(command==='summary-handoff'){
      if(store.hostWriter(session)){store.setHostWriter(session,false);store.release(session,'host')}
      if(store.source(session)&&!store.isDeleted(session)){const {mode,model}=effective(store,session);scheduleSummary(store,session,mode,model)}
    } else {
      const src=store.source(session)
      if(!src||store.isDeleted(session))throw Object.assign(new Error('conversation not recorded by SuperLcm'),{none:true})
      const {mode,model}=effective(store,session)
      if(mode!=='cli'||writerTool(store.metadata(session).harness)!=='claude-code')throw Object.assign(new Error('summaries are not written by Claude Code for this conversation'),{none:true})
      if(command==='summary-claim'){
        store.setHostWriter(session,true)
        if(existsSync(src.path))store.ingest(session,src.path)
        const work=summaryWork(store,session)
        if(!work)reply={none:'nothing to summarize yet'}
        else if(!store.lease(session,300000,'host'))reply={none:'busy'}
        else {const {SUMMARY_SYSTEM}=await import('./claude-cli.js');reply={work:{batch_id:work.batch_id,system:SUMMARY_SYSTEM,prompt:`<conversation_excerpt>\n${work.content}\n</conversation_excerpt>`,model:model||process.env.SUPERLCM_CLAUDE_CLI_MODEL||''}}}
      } else {
        const input=await readHook(),summary=typeof input.summary==='string'?input.summary.trim().slice(0,6000):''
        try {
          const work=summaryWork(store,session)
          if(!store.summarizing(session)||store.db.prepare('SELECT owner FROM leases WHERE session=?').get(session)?.owner!=='host')throw new Error('no summary claimed in this conversation')
          if(!work||work.batch_id!==input.batch_id)throw new Error('stale summary batch')
          if(summary.length<20)throw new Error('summary too short')
          if(work.level===0)for(let i=work.first;i<=work.last;i++)store.exact(session,i)
          store.addNode({session,id:work.batch_id,level:work.level,first:work.first,last:work.last,children:work.children,summary,digest:work.digest,model:`claude-code-host:${String(input.model||'configured').slice(0,80)}`})
          store.setStatus(session,'ok')
          reply={saved:true,more:Boolean(summaryWork(store,session))}
        } finally { store.release(session,'host') }
      }
    }
  } catch(error) { reply=error.none?{none:error.message}:{error:error.message} }
  finally { store.close() }
  process.stdout.write(JSON.stringify(reply)+'\n')
} else if (command==='archive') {
  // Copy every conversation's indexed originals into the private archive (safe to repeat).
  const store=new ClaudeStore()
  try { const results=store.archiveAll(); for(const r of results)if(!r.archived||r.copied||r.found_at)process.stdout.write(JSON.stringify(r)+'\n'); process.stdout.write(`archived ${results.filter(r=>r.archived).length}/${results.length} conversations\n`); if(results.some(r=>!r.archived))process.exitCode=1 }
  finally { store.close() }
} else { process.stderr.write('Usage: node src/cli.js mcp|web [port]|archive|compact-packet <session>|doctor-local|setup <codex|claude-code|hermes|pi|dsh> [--profile name] [--apply]|hook|codex-hook|hermes-hook|pi-hook|index|index-codex|import <path> [session] [harness] [name]|name <session> <title>|overview|summarize\n'); process.exitCode=2 }
