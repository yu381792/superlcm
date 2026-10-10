import { cliDeadline } from './cli-deadline.js'
import { validModel, MAX_SUMMARY_INPUT, workerEnv } from './runtime.js'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './store.js'
import { SUMMARY_SYSTEM, buildSummaryPrompt, checkedSummary } from './summary-policy.js'

export function summarizeWithCodexCli(text,{model=process.env.SUPERLCM_CODEX_CLI_MODEL||'',bin=process.env.SUPERLCM_CODEX_CLI_BIN||'codex',env=process.env,timeoutMs=180000,cwd=join(home(),'codex-cli-cwd'),spawnProcess=spawn,summaryTask}={}) {
  if(typeof text!=='string' || !text.trim() || text.length>MAX_SUMMARY_INPUT) throw new Error(`Codex CLI summary input must be 1–${MAX_SUMMARY_INPUT} characters`)
  if(typeof model!=='string' || (model && !validModel(model))) throw new Error('Invalid SUPERLCM_CODEX_CLI_MODEL')
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>300000) throw new Error('Invalid Codex CLI timeout')
  mkdirSync(cwd,{recursive:true,mode:0o700})
  // The user's own config (provider, model, login) applies; its MCP servers are not started for a summary.
  const args=['exec','--ephemeral','--ignore-rules','-c','mcp_servers={}','--skip-git-repo-check','-s','read-only',...(model?['-m',model]:[]),'--json','-']
  const prompt=SUMMARY_SYSTEM+'\n\n'+buildSummaryPrompt(text,summaryTask)
  return new Promise((resolve,reject)=>{
    let child,settled=false,timedOut=false,out='',overflow=false
    const finish=(error,value)=>{if(settled)return;settled=true;deadline.clear();if(error)reject(error);else resolve(value)}
    try {child=spawnProcess(bin,args,{cwd,env:workerEnv(env),stdio:['pipe','pipe','pipe'],windowsHide:true})}
    catch(error){return reject(new Error(`Codex CLI could not start: ${error.message}`))}
    const deadline=cliDeadline(child,timeoutMs,error=>finish(error),'Codex CLI')
    child.on('error',error=>finish(new Error(`Codex CLI could not start: ${error.message}`)))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data',chunk=>{if(overflow)return;out+=chunk;if(Buffer.byteLength(out)>1024*1024){overflow=true;deadline.stop('Codex CLI output exceeded 1 MiB')}})
    child.stderr.resume()
    child.on('close',code=>{
      if(timedOut)return finish(new Error('Codex CLI summarization timed out'))
      if(overflow)return finish(new Error('Codex CLI output exceeded 1 MiB'))
      if(code!==0)return finish(new Error(`Codex CLI summarization failed (exit ${code}); check login and model`))
      try {
        const events=out.trim().split('\n').map(line=>JSON.parse(line))
        if(events.some(event=>event.type==='turn.failed'||event.type==='error'))throw new Error('summary turn failed')
        const finalTurn=events.findLastIndex(event=>event.type==='turn.completed')
        const finalMessage=events.findLastIndex(event=>event.type==='item.completed' && event.item?.type==='agent_message')
        if(finalTurn<=finalMessage || finalTurn<0)throw new Error('summary turn incomplete; no completed turn after the answer')
        const result=events.filter(event=>event.type==='item.completed' && event.item?.type==='agent_message' && typeof event.item.text==='string').at(-1)?.item.text
        if(!result?.trim()) throw new Error('no completed agent message')
        finish(null,checkedSummary(result,{...summaryTask,maxChars:summaryTask?.allowOversize?null:6000}))
      } catch(error){finish(new Error(`Codex CLI did not produce a valid JSONL summary: ${error.message}`))}
    })
    child.stdin.on('error',()=>{})
    child.stdin.end(prompt)
  })
}
