import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore } from '../src/store.js'
import { summaryWork, buildHierarchy, summarizeWithModel, summaryEstimate } from '../src/summarize.js'
import { summarySource } from '../src/summary-source.js'
import { buildSummaryPrompt, checkedSummary } from '../src/summary-policy.js'
const fixture=fn=>async t=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-semantic-')),store=new ClaudeStore(join(dir,'archive'))
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  await fn({store,dir})
}
const line=record=>JSON.stringify(record)+'\n'
test('leaf source includes a failed tool outcome, chronology and literal commands that the preview omits',fixture(async ({store,dir})=>{
  const command="printf 'first\\nsecond'\nexit 1", file=join(dir,'source.jsonl')
  const rows=[{type:'user',timestamp:'2026-10-04T09:00:00Z',message:{content:[{type:'text',text:'部署还没批准，请先验证。'}]}},
    {type:'assistant',message:{content:[{type:'tool_use',id:'run-1',name:'shell',input:{command}}]}},
    {type:'user',timestamp:'2026-10-04T09:01:00Z',message:{content:[{type:'tool_result',tool_use_id:'run-1',is_error:true,content:'FAILED: deployment was NOT updated.'}]}},
    {type:'assistant',message:{content:[{type:'text',text:'I ran the deployment.'}]}}]
  writeFileSync(file,rows.map(line).join(''));store.ingest('s',file)
  assert.equal(store.eventRows('s')[2].preview,'','reproduces the old UI-preview omission')
  const work=summaryWork(store,'s',{batchSize:4})
  assert.match(work.content,/ERROR \/ failed.*\nFAILED: deployment was NOT updated/)
  assert.match(work.content,/source time: 2026-10-04T09:01:00Z/)
  assert.match(work.content,/run-1/);assert.ok(work.content.includes(JSON.stringify({command})))
  assert.equal(work.last,3);assert.equal(summaryEstimate(store,'s').calls,0,'estimate retains its configured batch cap')
  const literal="do:\n  echo ' a  b '\n  exit 1"
  assert.ok(summarySource(line({role:'user',content:literal})).endsWith(literal),'literal whitespace remains exact')
}))
test('Codex, Pi and portable tool results retain evidence without treating reasoning or compacted history as new dialogue',()=>{
  assert.match(summarySource(line({type:'response_item',payload:{type:'function_call_output',call_id:'c1',output:'exit code: 1'}})),/c1.*\nexit code: 1/)
  assert.match(summarySource(line({type:'message',timestamp:42,message:{role:'toolResult',toolCallId:'p1',isError:true,content:[{type:'text',text:'permission denied'}]}})),/ERROR \/ failed.*\npermission denied/)
  assert.match(summarySource(line({role:'tool',tool_call_id:'h1',content:'cancelled'})),/h1.*\ncancelled/)
  assert.equal(summarySource(line({type:'compacted',replacement_history:[{role:'user',content:'old decision'}]})),'')
  assert.equal(summarySource(line({type:'assistant',message:{content:[{type:'thinking',thinking:'private'}]}})),'')
})
test('Codex custom tool calls and failures enter leaf summary work from exact originals',fixture(async({store,dir})=>{
  const input="*** Begin Patch\n*** Update File: staging-plan.md\n@@\n-old\n+new\n*** End Patch", result='exit code: 1. Patch failed; no files changed.'
  const rows=[{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Only edit the staging plan; production remains forbidden.'}]}},
    {type:'response_item',payload:{type:'custom_tool_call',call_id:'patch-1',name:'apply_patch',input}},
    {type:'response_item',timestamp:'2026-01-01T09:00:00Z',payload:{type:'custom_tool_call_output',call_id:'patch-1',output:result}},
    {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'I think the edit succeeded.'}]}}]
  const file=join(dir,'custom-tools.jsonl');writeFileSync(file,rows.map(line).join(''));store.ingest('s',file)
  const work=summaryWork(store,'s',{batchSize:4})
  assert.match(work.content,/tool call apply_patch; id=patch-1/)
  assert.ok(work.content.includes(input),'custom tool input preserves literal patch newlines')
  assert.match(work.content,/tool result id=patch-1/);assert.ok(work.content.includes(result))
  assert.match(work.content,/source time: 2026-01-01T09:00:00Z/)
  assert.equal(work.last,3);assert.equal(store.exact('s',2),line(rows[2]),'failure evidence remains exactly recoverable')
}))
test('condensation keeps a critical exception beyond the former 3600-character child cutoff',fixture(async ({store,dir})=>{
  const file=join(dir,'source.jsonl');writeFileSync(file,line({role:'user',content:'source'}));store.ingest('s',file)
  const exception='只有测试环境获准；生产部署仍禁止，撤销旧方案。'
  for(let i=0;i<4;i++)store.addNode({session:'s',id:'child-'+i,level:0,first:i,last:i,children:[],summary:'old detail '.repeat(420)+exception,digest:'d'+i,model:'fixture'})
  const work=summaryWork(store,'s')
  assert.equal(work.level,1);assert.equal(work.content.split(exception).length-1,4)
  const prompt=buildSummaryPrompt(work.content,work)
  assert.match(prompt,/Source records: #0–#3/);assert.match(prompt,/superseded/)
  assert.match(prompt,/Do not call tools/);assert.doesNotMatch(prompt,/read the cited originals before acting/,'writer records recall needs, reader carries recall policy')
}))
test('previous leaf is context only; changing policy or child body invalidates pending work',fixture(async ({store,dir})=>{
  const file=join(dir,'source.jsonl');writeFileSync(file,Array.from({length:6},(_,i)=>line({role:'user',content:'fact '+i})).join(''));store.ingest('s',file)
  let work=summaryWork(store,'s',{batchSize:2});store.addNode({session:'s',id:work.batch_id,level:0,first:work.first,last:work.last,children:[],summary:'Current constraint: no production deployment.',digest:work.digest,model:'fixture'})
  work=summaryWork(store,'s',{batchSize:2});assert.match(buildSummaryPrompt(work.content,work),/<preceding_summary context_only="true">/)
  for(let i=1;i<4;i++)store.addNode({session:'s',id:'c'+i,level:0,first:2*i,last:2*i+1,children:[],summary:('facts '+i+' with exact constraints ').repeat(200),digest:'d',model:'fixture'})
  const before=summaryWork(store,'s').batch_id
  store.db.prepare("UPDATE nodes SET summary=summary || ' Updated constraint.' WHERE id='c3'").run()
  assert.notEqual(summaryWork(store,'s').batch_id,before)
}))
test('complete overlength output is marked as reduced navigation; incomplete output is still refused',fixture(async ({store,dir})=>{
  const file=join(dir,'source.jsonl'),raw=line({role:'user',content:'Original constraint'})+line({role:'assistant',content:'Pending, not done'})
  writeFileSync(file,raw);store.ingest('s',file)
  await buildHierarchy(store,'s',{model:'fixture',batchSize:2,summarize:async()=> '# Details\n'+'a'.repeat(6001)})
  assert.equal(store.nodeRows('s',0).length,1)
  assert.match(store.nodeRows('s',0)[0].summary,/SuperLcm reduced navigation/)
  assert.equal(store.exact('s',0),raw.split('\n')[0]+'\n')
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'Deployment completed.'}}]})})
  await assert.rejects(summarizeWithModel('facts',{model:'fixture',apiKey:'fixture',apiProvider:'openai',fetchImpl}),/incomplete/)
  assert.throws(()=>checkedSummary('plausible partial',{finishReason:{kind:'max-tokens'}}),/incomplete/)
}))

test('Hermes SQLite mirror retains JSON-string calls, named tool outcomes and structured-content sentinel',()=>{
  const calls=JSON.stringify([{id:'hermes-run',function:{name:'shell',arguments:'{\"command\":\"exit 1\"}'}}])
  assert.match(summarySource(line({role:'assistant',content:null,tool_calls:calls})),/tool call shell; id=hermes-run/)
  assert.match(summarySource(line({role:'tool',tool_name:'shell',tool_call_id:'hermes-run',content:'exit code 1'})),/tool result shell; id=hermes-run/)
  assert.match(summarySource(line({role:'user',content:'\0json:'+JSON.stringify([{type:'text',text:'生产部署不批准。'}])})),/生产部署不批准/)
})

test('valid imported administrative scalars do not block summary work or estimates',fixture(async({store,dir})=>{
  for(const raw of ['null','42','true','[]'])assert.equal(summarySource(raw),'')
  const file=join(dir,'scalars.jsonl');writeFileSync(file,'null\n'+line({role:'user',content:'do not deploy'})+line({role:'assistant',content:'pending'}))
  store.ingest('s',file);assert.match(summaryWork(store,'s',{batchSize:2}).content,/do not deploy/);assert.doesNotThrow(()=>summaryEstimate(store,'s'))
}))
