import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {detectSummaryLanguage,languageInfo,languageRule,userTextFromRecord} from '../src/summary-language.js'
import {checkedSummary} from '../src/summary-policy.js'
import {parseForkTree,forkDirective} from '../src/fork-summary.js'
import {summarizeWithModel,buildHierarchy} from '../src/summarize.js'
import {ClaudeStore} from '../src/store.js'
import {dshSummaryLanguage} from '../dsh/summary-language.js'
test('provider handoff history does not override the current human language',()=>{
 const wrapper='Context handoff (delta_since_target_last_seen):\nProvider context handoff. Thread: synthetic-thread.\n'+'The project has a pending task and the original content should be preserved. '.repeat(200)
 assert.equal(detectSummaryLanguage([userTextFromRecord({type:'message',message:{role:'user',content:wrapper+'\nUser message:\n请继续检查配置，保留所有原始记录。'}})]).code,'zh')
 assert.equal(userTextFromRecord({type:'message',message:{role:'user',content:wrapper}}),'')
 assert.equal(detectSummaryLanguage([userTextFromRecord({role:'user',content:'Please inspect this project and preserve the originals.'})]).code,'en')
})

// #19's real-world examples and an Urdu example with the Persian letters
// shared by both languages. Do not contact a model provider in these tests.
const fa='لطفا این فایل را بخوان و بگو چرا خطا می‌دهد. می‌خواهم که پلاگین را نصب کنی و گزارش بدهی'
const ar='من فضلك اقرأ هذا الملف وأخبرني لماذا يظهر الخطأ. أريد أن تثبت الإضافة وتكتب لي تقريرا'
const ur='براہ کرم یہ فائل پڑھیں اور بتائیں کہ خرابی کیوں آ رہی ہے۔ میں چاہتا ہوں کہ آپ پلگ ان انسٹال کریں اور رپورٹ دیں۔'
const summaries={fa:'# وضعیت\n'+fa,ar:'# ملخص\n'+ar,ur:'# خلاصہ\n'+ur}
const response=content=>new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}))

test('Persian, Arabic and Urdu select the proposed named language rule',()=>{
 for(const [code,text,name] of [['fa',fa,'Persian'],['ar',ar,'Arabic'],['ur',ur,'Urdu']]){
  const language=detectSummaryLanguage([text])
  assert.deepEqual(language,{code,name,script:'Arabic'})
  assert.match(languageRule(language),new RegExp('entire summary in '+name))
  assert.match(forkDirective([{firstMessage:0,lastMessage:0}],500,language.name),new RegExp('Use '+name))
 }
})

test('short and conflicting evidence remains the conservative script-only rule',()=>{
 for(const text of ['سلام سلام سلام','کک يي','ککک ييي','ٹٹٹ '+fa.repeat(6),'ٹٹٹ کککککک'])
  assert.equal(detectSummaryLanguage([text]).code,'arab',text)
 // A few Urdu-specific characters cannot override overwhelmingly Arabic prose.
 assert.equal(detectSummaryLanguage(['ٹٹٹ '+ar.repeat(6)]).code,'ar')
 // Urdu commonly uses Persian ک and ی: these must not make it Persian.
 assert.equal(detectSummaryLanguage([ur]).code,'ur')
})

test('all host record shapes anchor the language to human messages',()=>{
 const records=[
  {type:'user',message:{content:fa}},
  {type:'response_item',payload:{type:'message',role:'user',content:fa}},
  {type:'message',message:{role:'user',content:fa}},
  {type:'user/message',data:{source:{kind:'user'},content:fa}},
 ]
 for(const record of records)assert.equal(detectSummaryLanguage([userTextFromRecord(record)]).code,'fa')
 const events=[records[3],{type:'user/message',data:{source:{kind:'runtime-context'},content:ar.repeat(10)}}]
 assert.equal(dshSummaryLanguage({seq:events.length,eventAt:i=>events[i]}).code,'fa')
})

test('wrong Arabic-script language is rejected for both API and background fork trees',()=>{
 for(const expected of ['fa','ar','ur'])for(const actual of ['fa','ar','ur']){
  const opts={language:languageInfo(expected),requireHeading:true}
  if(expected===actual)assert.doesNotThrow(()=>checkedSummary(summaries[actual],opts))
  else {
   assert.throws(()=>checkedSummary(summaries[actual],opts),error=>error.summaryQuality===true&&/language mismatch/.test(error.message))
   assert.throws(()=>parseForkTree(summaries[actual],[{firstMessage:0,lastMessage:0}],opts.language),/language mismatch/)
  }
 }
 // Inconclusive output is not falsely rejected as a different named language.
 assert.doesNotThrow(()=>checkedSummary('# سلام\n'+'سلام '.repeat(10),{language:languageInfo('fa'),requireHeading:true}))
 // Literal source quotations are preserved, but do not set the prose language.
 assert.doesNotThrow(()=>checkedSummary(summaries.fa+'\n"'+ar.repeat(8)+'"',{language:languageInfo('fa'),requireHeading:true}))
})

test('a wrong-language API response retries with the Persian instruction',async()=>{
 const requests=[]
 const output=await summarizeWithModel('user:\n'+fa,{model:'fixture',apiProvider:'openai',baseURL:'http://127.0.0.1:9',
  summaryTask:{language:languageInfo('fa')},fetchImpl:async(_url,req)=>{
   requests.push(JSON.parse(req.body))
   return response(requests.length===1?summaries.ar:summaries.fa)
  }})
 assert.equal(output,summaries.fa);assert.equal(requests.length,2)
 assert.match(requests[0].messages[1].content,/entire summary in Persian/)
 assert.match(requests[1].messages[1].content,/previous response failed/)
})

test('repeated wrong-language replies are not archived and originals remain unchanged',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'superlcm-issue19-')),file=join(dir,'source.jsonl'),store=new ClaudeStore(join(dir,'store'))
 t.after(()=>store.close())
 const original=[{role:'user',content:fa.repeat(8)},{role:'assistant',content:'pending'}].map(JSON.stringify).join('\n')+'\n'
 writeFileSync(file,original);store.ingest('issue19',file)
 let calls=0
 await assert.rejects(buildHierarchy(store,'issue19',{batchSize:2,model:'fixture',apiKey:'fixture',apiProvider:'openai',baseURL:'http://127.0.0.1:9',
  fetchImpl:async()=>{calls++;return response(summaries.ar)}}),/language mismatch/)
 assert.equal(calls,2);assert.equal(store.nodeRows('issue19',0).length,0)
 assert.equal(readFileSync(file,'utf8'),original)
 assert.equal(store.eventRows('issue19').map(row=>store.exact('issue19',row.ordinal)).join(''),original)
})
