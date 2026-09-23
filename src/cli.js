#!/usr/bin/env node
import { ClaudeStore, claudeTranscript } from './store.js'
import { buildHierarchy, summaryWork } from './summarize.js'
import { summarizeWithClaudeCli } from './claude-cli.js'
import { summaryMode } from './mode.js'
import { startServer } from './mcp.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const [command,...rest]=process.argv.slice(2)
if (command==='mcp') startServer()
else if (command==='hook' || command==='index' || command==='import' || command==='overview' || command==='summarize') {
  const store=new ClaudeStore()
  try {
    let result
    if (command==='hook') {
      // The spawned Claude CLI can run user-level hooks. Its descendants must never index
      // or trigger another summarizer worker, even if this hook is inherited.
      if (process.env.SUPERLCM_CLI_WORKER !== '1') {
        const input=await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{text+=s;if(text.length>200000) reject(new Error('Oversized hook input'))});process.stdin.on('end',()=>resolve(JSON.parse(text)))})
        if (input.transcript_path && input.session_id) {
          const session=input.session_id, file=claudeTranscript(input.transcript_path)
          const mode=summaryMode(), event=input.hook_event_name
          if (['Stop','PostCompact'].includes(event) || (event==='SessionStart' && input.source==='compact')) result=store.ingest(session,file)
          if (store.source(session)) store.setSummaryMode(session,mode)
          if (['Stop','PostCompact'].includes(event) && ['cli','api'].includes(mode) && summaryWork(store,session)) {
            if (mode==='cli' || (process.env.SUPERLCM_CLAUDE_MODEL && process.env.SUPERLCM_ANTHROPIC_API_KEY)) {
              const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'summarize',session],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,SUPERLCM_HOOK_WORKER:'1'}})
              child.unref()
            } else { store.setStatus(session,'summary_unconfigured');process.stderr.write('SuperLcm: api mode needs SUPERLCM_CLAUDE_MODEL and SUPERLCM_ANTHROPIC_API_KEY\n') }
          }
          if (event==='SessionStart' && input.source==='compact' && store.source(session)) {
            const info=store.overview(session)
            process.stdout.write(`SuperLcm: indexed session ${session}; search with MCP lcm_search and verify using lcm_read_event or lcm_expand. Navigation: ${JSON.stringify(info.nodes).slice(0,1300)}\n`)
          }
        }
      }
    } else if (command==='index') {
      const [path,session]=rest
      if (!path||!session) throw new Error('Usage: index <Claude transcript_path> <session_id>')
      result=store.ingest(session,claudeTranscript(path))
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
      const {importFile}=await import('./store.js');result=importFile(store,rest[0],rest[1])
    } else result=store.overview(rest[0])
    if (command!=='hook') process.stdout.write(JSON.stringify(result)+'\n')
  } catch(error) {process.stderr.write(`SuperLcm: ${error.message}\n`);process.exitCode=1} finally {store.close()}
} else { process.stderr.write('Usage: node src/cli.js mcp|hook|index|import|overview|summarize\n'); process.exitCode=2 }
