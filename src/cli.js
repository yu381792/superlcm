#!/usr/bin/env node
import { ClaudeStore, claudeTranscript } from './store.js'
import { codexTranscript, codexNativeName, codexSessionKey } from './codex.js'
import { buildHierarchy, summaryWork } from './summarize.js'
import { summarizeWithClaudeCli } from './claude-cli.js'
import { summarizeWithCodexCli } from './codex-cli.js'
import { startServer } from './mcp.js'
import { startWeb, defaultPort } from './web.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const [command,...rest]=process.argv.slice(2)
const homeFlag=rest.indexOf('--home')
if(homeFlag>=0){if(!rest[homeFlag+1])throw Error('--home requires a path');process.env.SUPERLCM_HOME=rest[homeFlag+1];rest.splice(homeFlag,2)}
const effective=(store,session)=>store.effectiveSetting(session)
const readHook=()=>new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{text+=part;if(text.length>200000)reject(new Error('Oversized hook input'))});process.stdin.on('end',()=>resolve(JSON.parse(text)))})
function scheduleSummary(store,session,mode,model) {
  if (!['cli','codex-cli','api'].includes(mode) || !summaryWork(store,session)) return
  if (mode==='api' && (!(model||process.env.SUPERLCM_CLAUDE_MODEL) || !store.apiCredential(session))) {
    store.setStatus(session,'summary_unconfigured')
    process.stderr.write('SuperLcm: api mode needs a model ID and a configured scoped API key\n')
    return
  }
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'summarize',session],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,SUPERLCM_HOOK_WORKER:'1',SUPERLCM_SUMMARY_EXPECTED_MODE:mode,SUPERLCM_SUMMARY_EXPECTED_MODEL:model||''}})
  child.on('error',error=>process.stderr.write('SuperLcm: background worker could not start: '+error.message+'\n'))
  child.unref()
}
const derivedTitle=(store,session)=>store.eventRows(session).find(e=>e.preview.startsWith('user:'))?.preview.replace(/^user:\s*/,'').replace(/\s+/g,' ').trim().slice(0,90)
if(command==='setup' || command==='doctor-local'){const store=new ClaudeStore();try{const {harnessConnections}=await import('./harness.js');if(command==='doctor-local'||!rest[0])console.log(JSON.stringify(await harnessConnections(store),null,2));else{const {setupPreview,publicPreview,applySetup}=await import('./setup.js');const preview=await setupPreview(store,rest[0]);console.log(JSON.stringify(rest.includes('--apply')?await applySetup(store,rest[0],preview.revision):publicPreview(preview),null,2))}}catch(error){console.error(error.message);process.exitCode=1}finally{store.close()}}
else if (command==='mcp') startServer()
else if (command==='web') {
  const port=rest[0]?Number(rest[0]):defaultPort
  try { const web=await startWeb({port});process.stdout.write(`SuperLcm local console: ${web.url}\n`) }
  catch(error) { if(error.code!=='EADDRINUSE')throw error; process.stderr.write(`Port ${port} is already in use. If the console is already running, open http://127.0.0.1:${port}/ ; otherwise pass another port: node src/cli.js web <port>\n`); process.exitCode=1 }
}
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
          const file=input.transcript_path ? (codex ? codexTranscript(input.transcript_path,{cwd:input.cwd}) : claudeTranscript(input.transcript_path)) : null
          const shouldIndex=['Stop','PostCompact','SessionEnd','SessionStart','UserPromptSubmit'].includes(event)
          if (shouldIndex && file) result=store.ingest(session,file)
          if (store.source(session)) {
            store.markClient(codex?'codex':'claude-code','hook')
            const title=codex ? (file?codexNativeName(input.session_id,file):null) : store.nativeClaudeTitle(session)
            store.setMetadata(session,{harness:codex?'codex':'claude-code',externalId:input.session_id,name:title||derivedTitle(store,session),nameSource:title?'native':'derived'})
            const {mode,model}=effective(store,session)
            if (['off','cli','api'].includes(mode)) store.setSummaryMode(session,mode)
            if (shouldIndex && ['Stop','PostCompact','SessionEnd'].includes(event)) scheduleSummary(store,session,mode,model)
            if (event==='UserPromptSubmit' && mode==='agent' && summaryWork(store,session)) process.stdout.write(`SuperLcm in-conversation summary for this conversation (${session}): after answering, call lcm_summary_task {"conversation":"${session}"}, summarize the returned content, then lcm_summary_submit with its batch_id. One task per turn is enough; never claim a summary was saved without tool confirmation.\n`)
          }
          if (event==='SessionStart' && input.source==='compact' && store.source(session)) {
            const {code}=store.metadata(session),{records}=store.stats(session)
            process.stdout.write(`SuperLcm: this conversation was compacted, but all ${records} original records are preserved as #${code}. When an earlier detail matters, call lcm_outline {"conversation":"#${code}"} to locate it and lcm_read to quote the exact original instead of relying on the compacted summary.\n`)
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
      if (backend!==null && !['cli','codex-cli','api'].includes(backend)) throw new Error('--backend must be cli, codex-cli or api')
      const oneOffApi=backend==='api'?store.apiConfig(rest[0]):null
      if (backend==='api' && !oneOffApi) throw new Error('No saved custom API; configure one in Settings first')
      try {
        const {mode,model,api_provider,api_url}=oneOffApi?{mode:'api',...oneOffApi}:backend?{mode:backend,model:null}:effective(store,rest[0])
        if (!backend && process.env.SUPERLCM_HOOK_WORKER==='1' && (process.env.SUPERLCM_SUMMARY_EXPECTED_MODE!==mode || process.env.SUPERLCM_SUMMARY_EXPECTED_MODEL!==(model||''))) throw new Error('Summary setting changed before background worker started')
        if (mode==='off' || mode==='agent') throw new Error('Background summaries are disabled for this session')
        result=mode==='api'
          ? await buildHierarchy(store,rest[0],{model:model||process.env.SUPERLCM_CLAUDE_MODEL,apiKey:oneOffApi?.apiKey||store.apiCredential(rest[0]),apiProvider:api_provider||'anthropic',apiURL:api_url||process.env.SUPERLCM_CLAUDE_API_URL})
          : mode==='codex-cli'
            ? await buildHierarchy(store,rest[0],{model:`codex-cli:${model||process.env.SUPERLCM_CODEX_CLI_MODEL||'configured'}`,summarize:text=>summarizeWithCodexCli(text,{model:model||process.env.SUPERLCM_CODEX_CLI_MODEL||''})})
            : await buildHierarchy(store,rest[0],{model:`claude-cli:${model||process.env.SUPERLCM_CLAUDE_CLI_MODEL||'sonnet'}`,summarize:text=>summarizeWithClaudeCli(text,{model:model||process.env.SUPERLCM_CLAUDE_CLI_MODEL||'sonnet'})})
        if (!result.busy) store.setStatus(rest[0],'ok')
      }
      catch(error) {store.setStatus(rest[0],'summary_error');throw error}
    } else if (command==='import') {
      const {importFile}=await import('./store.js');result=importFile(store,rest[0],rest[1],rest[2] || 'import',rest[3])
    } else if (command==='name') result=store.nameSession(rest[0],rest.slice(1).join(' '))
    else result=store.overview(rest[0])
    if (command!=='hook' && command!=='codex-hook') process.stdout.write(JSON.stringify(result)+'\n')
  } catch(error) {process.stderr.write(`SuperLcm: ${error.message}\n`);process.exitCode=1} finally {store.close()}
} else if (command==='archive') {
  // Copy every conversation's indexed originals into the private archive (safe to repeat).
  const store=new ClaudeStore()
  try { const results=store.archiveAll(); for(const r of results)if(!r.archived||r.copied||r.found_at)process.stdout.write(JSON.stringify(r)+'\n'); process.stdout.write(`archived ${results.filter(r=>r.archived).length}/${results.length} conversations\n`); if(results.some(r=>!r.archived))process.exitCode=1 }
  finally { store.close() }
} else { process.stderr.write('Usage: node src/cli.js mcp|web [port]|archive|doctor-local|setup <codex|claude-code> [--apply]|hook|codex-hook|index|index-codex|import <path> [session] [harness] [name]|name <session> <title>|overview|summarize\n'); process.exitCode=2 }
