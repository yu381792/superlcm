#!/usr/bin/env node
import { ClaudeStore, claudeTranscript } from './store.js'
import { codexTranscript, codexNativeName, codexSessionKey } from './codex.js'
import { buildHierarchy, summaryWork } from './summarize.js'
import { summarizeWithClaudeCli } from './claude-cli.js'
import { summaryMode } from './mode.js'
import { startServer } from './mcp.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const [command,...rest]=process.argv.slice(2)
const readHook=()=>new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{text+=part;if(text.length>200000)reject(new Error('Oversized hook input'))});process.stdin.on('end',()=>resolve(JSON.parse(text)))})
function scheduleSummary(store,session,mode) {
  if (!['cli','api'].includes(mode) || !summaryWork(store,session)) return
  if (mode==='api' && (!process.env.SUPERLCM_CLAUDE_MODEL || !process.env.SUPERLCM_ANTHROPIC_API_KEY)) {
    store.setStatus(session,'summary_unconfigured')
    process.stderr.write('SuperLcm: api mode needs SUPERLCM_CLAUDE_MODEL and SUPERLCM_ANTHROPIC_API_KEY\n')
    return
  }
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'summarize',session],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,SUPERLCM_HOOK_WORKER:'1'}})
  child.on('error',error=>process.stderr.write('SuperLcm: background worker could not start: '+error.message+'\n'))
  child.unref()
}
const derivedTitle=(store,session)=>store.eventRows(session).find(e=>e.preview.startsWith('user:'))?.preview.replace(/^user:\s*/,'').replace(/\s+/g,' ').trim().slice(0,90)
if (command==='mcp') startServer()
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
        if (input.transcript_path && input.session_id) {
          const mode=summaryMode(), event=input.hook_event_name
          const session=codex ? codexSessionKey(input.session_id) : input.session_id
          const file=codex ? codexTranscript(input.transcript_path,{cwd:input.cwd}) : claudeTranscript(input.transcript_path)
          const shouldIndex=codex ? ['Stop','PostCompact','SessionEnd'].includes(event) || (event==='SessionStart' && input.source==='compact') : ['Stop','PostCompact'].includes(event) || (event==='SessionStart' && input.source==='compact')
          if (shouldIndex) result=store.ingest(session,file)
          if (store.source(session)) {
            const title=codex ? codexNativeName(input.session_id,file) : store.nativeClaudeTitle(session)
            store.setMetadata(session,{harness:codex?'codex':'claude-code',externalId:input.session_id,name:title||derivedTitle(store,session),nameSource:title?'native':'derived'})
            store.setSummaryMode(session,mode)
            if (shouldIndex && ['Stop','PostCompact','SessionEnd'].includes(event)) scheduleSummary(store,session,mode)
          }
          if (event==='SessionStart' && input.source==='compact' && store.source(session)) {
            const info=store.overview(session)
            process.stdout.write(`SuperLcm session ${session}: ${JSON.stringify(info.nodes).slice(0,1300)}; search/read exact sources through MCP.\n`)
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
      try {
        const mode=summaryMode()
        if (process.env.SUPERLCM_HOOK_WORKER==='1' && store.summaryMode(rest[0])!==mode) throw new Error('Summary mode changed before background worker started')
        if (mode==='off') throw new Error('Summary mode is off')
        result=mode==='api'
          ? await buildHierarchy(store,rest[0],{model:process.env.SUPERLCM_CLAUDE_MODEL,apiKey:process.env.SUPERLCM_ANTHROPIC_API_KEY,baseURL:process.env.SUPERLCM_CLAUDE_API_URL})
          : await buildHierarchy(store,rest[0],{model:`claude-cli:${process.env.SUPERLCM_CLAUDE_CLI_MODEL || 'sonnet'}`,summarize:text=>summarizeWithClaudeCli(text,{model:process.env.SUPERLCM_CLAUDE_CLI_MODEL || 'sonnet'})})
        if (!result.busy) store.setStatus(rest[0],'ok')
      }
      catch(error) {store.setStatus(rest[0],'summary_error');throw error}
    } else if (command==='import') {
      const {importFile}=await import('./store.js');result=importFile(store,rest[0],rest[1],rest[2] || 'import',rest[3])
    } else if (command==='name') result=store.nameSession(rest[0],rest.slice(1).join(' '))
    else result=store.overview(rest[0])
    if (command!=='hook' && command!=='codex-hook') process.stdout.write(JSON.stringify(result)+'\n')
  } catch(error) {process.stderr.write(`SuperLcm: ${error.message}\n`);process.exitCode=1} finally {store.close()}
} else { process.stderr.write('Usage: node src/cli.js mcp|hook|codex-hook|index|index-codex|import <path> [session] [harness] [name]|name <session> <title>|overview|summarize\n'); process.exitCode=2 }
