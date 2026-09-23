#!/usr/bin/env node
import { ClaudeStore, claudeTranscript } from './store.js'
import { buildHierarchy } from './summarize.js'
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
      const input=await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{text+=s;if(text.length>200000) reject(new Error('Oversized hook input'))});process.stdin.on('end',()=>resolve(JSON.parse(text)))})
      if (input.transcript_path && input.session_id) {
        const session=input.session_id, file=claudeTranscript(input.transcript_path)
        if (['Stop','PostCompact'].includes(input.hook_event_name)) result=store.ingest(session,file)
        if (process.env.SUPERLCM_SUMMARIZE_ON_HOOK==='1' && process.env.SUPERLCM_CLAUDE_MODEL && process.env.ANTHROPIC_API_KEY && ['Stop','PostCompact'].includes(input.hook_event_name)) {
          const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'summarize',session],{detached:true,stdio:'ignore',env:process.env});child.unref()
        }
        if (input.hook_event_name==='SessionStart' && input.source==='compact' && store.source(session)) {
          const info=store.overview(session)
          process.stdout.write(`SuperLcm: indexed transcript session ${session}. Use MCP lcm_search then lcm_expand to verify details; recent history may not yet be indexed. Navigation: ${JSON.stringify(info.nodes).slice(0,1300)}\n`)
        }
      }
    } else if (command==='index') {
      const [path,session]=rest
      if (!path||!session) throw new Error('Usage: index <Claude transcript_path> <session_id>')
      result=store.ingest(session,claudeTranscript(path))
      // Indexing alone never starts a paid summarizer.
    } else if (command==='summarize') {
      if (!store.source(rest[0])) throw new Error('Unknown session')
      try {result=await buildHierarchy(store,rest[0],{model:process.env.SUPERLCM_CLAUDE_MODEL,apiKey:process.env.ANTHROPIC_API_KEY,baseURL:process.env.SUPERLCM_CLAUDE_API_URL});store.setStatus(rest[0],'ok')}
      catch(error) {store.setStatus(rest[0],'summary_error');throw error}
    } else if (command==='import') {
      const {importFile}=await import('./store.js');result=importFile(store,rest[0],rest[1])
    } else result=store.overview(rest[0])
    if (command!=='hook') process.stdout.write(JSON.stringify(result)+'\n')
  } catch(error) {process.stderr.write(`SuperLcm: ${error.message}\n`);process.exitCode=1} finally {store.close()}
} else { process.stderr.write('Usage: node claude/cli.js mcp|hook|index|import|overview\n'); process.exitCode=2 }
