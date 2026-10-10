import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {ClaudeStore} from '../src/store.js'
import {summaryWork,summaryEstimate,buildHierarchy,segmentMessages} from '../src/summarize.js'
import {estimateSummaryTokens,takeTokenPrefix,takeTokenSuffix} from '../src/summary-tokens.js'
const fixture=t=>{const dir=mkdtempSync(join(tmpdir(),'slcm-token-budget-')),store=new ClaudeStore(join(dir,'archive'));t.after(()=>store.close());return {dir,store}}
const ingest=({dir,store},id,texts)=>{const file=join(dir,id+'.jsonl');writeFileSync(file,texts.map(content=>JSON.stringify({role:'user',content})).join('\n')+'\n');store.ingest(id,file);return file}
const options={batchSize:10000}
test('Unicode token estimates and excerpts account for CJK and keep complete surrogate pairs',()=>{
  assert.equal(estimateSummaryTokens('abcdefgh'),2);assert.equal(estimateSummaryTokens('中文'),3);assert.equal(estimateSummaryTokens('😀'),2)
  for(const text of [takeTokenPrefix('a😀中文z',3),takeTokenSuffix('a😀中文z',3)]) {
    assert.ok(estimateSummaryTokens(text)<=3);assert.equal(text.isWellFormed(),true)
  }
})
test('20K token settings persist and old character settings migrate without being reinterpreted',t=>{
  const dir=mkdtempSync(join(tmpdir(),'slcm-old-tuning-'));mkdirSync(dir,{recursive:true})
  const db=new DatabaseSync(join(dir,'lcm.sqlite'));db.exec('CREATE TABLE summary_tuning(id INTEGER PRIMARY KEY,target_chars INTEGER NOT NULL,batch_size INTEGER NOT NULL,fanout INTEGER NOT NULL); INSERT INTO summary_tuning VALUES(1,24000,64,6)');db.close()
  const store=new ClaudeStore(dir)
  assert.equal(store.tuning().target_chars,24000);assert.equal(store.tuning().target_tokens,null)
  store.setTuning({target_tokens:20000});store.close()
  const reopened=new ClaudeStore(dir);t.after(()=>reopened.close())
  assert.equal(reopened.tuning().target_tokens,20000);assert.equal(reopened.tuning().fanout,6);assert.equal(reopened.tuning().batch_size,64)
  assert.throws(()=>reopened.setTuning({target_tokens:1999}),/Unsupported/)
})
test('20K English source can exceed the old 64K character ceiling and stays within its token budget',t=>{
  const f=fixture(t),file=ingest(f,'english',Array.from({length:500},(_,i)=>'decision '+i+' '+'a'.repeat(192)))
  const original=readFileSync(file),work=summaryWork(f.store,'english',options)
  assert.ok(work.content.length>64000);assert.ok(estimateSummaryTokens(work.content)<=20000)
  assert.ok(work.last<499);assert.deepEqual(readFileSync(file),original)
  const estimate=summaryEstimate(f.store,'english',options)
  assert.equal(estimate.target_tokens,20000);assert.equal(estimate.segments,1);assert.ok(estimate.tail_tokens<20000)
})
test('equal character counts produce different CJK and English chunk boundaries',t=>{
  const f=fixture(t);ingest(f,'cjk',Array.from({length:20},()=> '汉'.repeat(1000)));ingest(f,'latin',Array.from({length:20},()=> 'a'.repeat(1000)))
  const work=summaryWork(f.store,'cjk',options)
  assert.ok(work);assert.ok(estimateSummaryTokens(work.content)<=20000);assert.equal(summaryWork(f.store,'latin',options),null)
})
test('hundreds of short messages do not independently trigger small token summaries',t=>{
  const f=fixture(t);ingest(f,'short',Array.from({length:600},()=> 'ok'))
  assert.equal(segmentMessages({}),10000);assert.equal(summaryWork(f.store,'short',options),null)
  assert.equal(summaryEstimate(f.store,'short',options).calls,0)
})
test('oversized Unicode records retain both ends and an exact-source reference without exceeding 20K',t=>{
  const f=fixture(t),content='FIRST constraint '+('汉😀abc '.repeat(20000))+' FINAL exception',file=ingest(f,'oversize',[content])
  const before=readFileSync(file),work=summaryWork(f.store,'oversize',options)
  assert.match(work.content,/FIRST constraint/);assert.match(work.content,/FINAL exception/);assert.match(work.content,/lcm_read event 0/)
  assert.ok(estimateSummaryTokens(work.content)<=20000);assert.equal(work.content.isWellFormed(),true)
  assert.deepEqual(readFileSync(file),before)
})
test('changing token size rejects a pending model result and keeps original data',async t=>{
  const f=fixture(t),file=ingest(f,'pending',['a'.repeat(40000),'b'.repeat(40000),'later'])
  const before=readFileSync(file)
  const result=await buildHierarchy(f.store,'pending',{...options,model:'fixture',summarize:async()=>{f.store.setTuning({target_tokens:10000});return '# A late summary that must not be committed.'}})
  assert.equal(result.stopped,'settings-changed');assert.equal(f.store.nodeRows('pending',0).length,0);assert.deepEqual(readFileSync(file),before)
})

test('short sibling summaries wait for enough combined content and then form one exact parent',t=>{
  const f=fixture(t);ingest(f,'siblings',Array.from({length:12},()=> 'source original'))
  for(let i=0;i<4;i++)f.store.addNode({session:'siblings',id:'leaf-'+i,level:0,first:i,last:i,children:[],summary:'Exact fact '+i+'. '+'a'.repeat(1000),digest:'d'+i,model:'fixture'})
  assert.equal(summaryWork(f.store,'siblings',options),null,'four ~250-token summaries remain readable leaves')
  assert.equal(summaryEstimate(f.store,'siblings',options).calls,0,'a deferred merge is not shown as pending paid work')
  for(let i=4;i<8;i++)f.store.addNode({session:'siblings',id:'leaf-'+i,level:0,first:i,last:i,children:[],summary:'Exact fact '+i+'. '+'a'.repeat(1000),digest:'d'+i,model:'fixture'})
  const work=summaryWork(f.store,'siblings',options)
  assert.equal(work.level,1);assert.equal(work.children.length,8);assert.equal(work.first,0);assert.equal(work.last,7)
  for(let i=0;i<8;i++)assert.ok(work.content.includes('Exact fact '+i))
  assert.ok(work.targetTokens<estimateSummaryTokens(work.content))
})
test('owned siblings split groups and complete child content stays within the input budget',async()=>{
  const {selectSummaryMerge,mergeContent}=await import('../src/summary-merge.js')
  const nodes=Array.from({length:9},(_,i)=>({id:'n'+i,first:i,last:i,summary:'x'.repeat(2600)}))
  const group=selectSummaryMerge(nodes,new Set(['n3']),{fanout:4,targetTokens:20000})
  assert.deepEqual(group.map(n=>n.id),['n4','n5','n6','n7'])
  const small=selectSummaryMerge(nodes,new Set(),{fanout:4,targetTokens:2000})
  assert.equal(small,null,'four complete large children cannot be squeezed into a smaller input batch')
  assert.ok(estimateSummaryTokens(mergeContent(group))<=20000)
  assert.equal(selectSummaryMerge(nodes.slice(0,3),new Set(),{fanout:4,targetTokens:20000}),null)
})
test('an over-budget child does not block later leaves or trigger a truncated merge',async()=>{
  const {selectSummaryMerge,mergeContent}=await import('../src/summary-merge.js')
  const nodes=[{id:'big',first:0,last:0,summary:'B'.repeat(90000)},...Array.from({length:4},(_,i)=>({id:'n'+i,first:i+1,last:i+1,summary:'完整约束。'.repeat(100)}))]
  const group=selectSummaryMerge(nodes,new Set(),{fanout:4,targetTokens:20000})
  assert.deepEqual(group.map(n=>n.id),['n0','n1','n2','n3'])
  assert.equal(mergeContent(group).includes('B'),false)
  assert.ok(group.every(n=>mergeContent(group).includes(n.summary)))
})

test('mixed large and short siblings select the complete legal adjacent suffix',async()=>{
  const {selectSummaryMerge,mergeContent}=await import('../src/summary-merge.js')
  const nodes=[9000,4000,4000,4000,4000].map((tokens,i)=>({id:'m'+i,first:i,last:i,summary:'x'.repeat(tokens*4)}))
  const group=selectSummaryMerge(nodes,new Set(),{fanout:4,targetTokens:20000})
  assert.deepEqual(group.map(n=>n.id),['m1','m2','m3','m4'])
  assert.ok(estimateSummaryTokens(mergeContent(group))<=20000)
})
