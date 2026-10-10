// Run the shipped CLI, MCP and summary implementation from an unpacked tarball.
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
const root=fileURLToPath(new URL('../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'SuperLcm install 用户 # % ')),home=join(dir,'private-store')
assert.ok(process.env.npm_execpath,'Run via npm')
const run=(file,args,options={})=>{const p=spawnSync(process.execPath,[file,...args],{cwd:dir,env:{...process.env,SUPERLCM_HOME:home,SUPERLCM_SUMMARY_MODE:'off',SUPERLCM_SEGMENT_MESSAGES:'2'},encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024,...options});assert.equal(p.status,0,p.stderr||p.error?.message);return p.stdout}
const pack=JSON.parse(run(process.env.npm_execpath,['pack','--json','--ignore-scripts','--pack-destination',dir],{cwd:root}))[0]
const archive=join(dir,pack.filename),expanded=join(dir,'installed');mkdirSync(expanded)
const tar=spawnSync('tar',['-xf',archive,'-C',expanded],{encoding:'utf8'});assert.equal(tar.status,0,tar.stderr)
const pkg=join(expanded,'package'),load=name=>import(pathToFileURL(join(pkg,'src',name)).href)
const {ClaudeStore}=await load('store.js'),{summaryWork,buildHierarchy}=await load('summarize.js')
const source=join(dir,'originals.jsonl'),english='Please verify the project and preserve all original files. We should not deploy without approval.'
const rows=Array.from({length:8},(_,i)=>({role:i%2?'assistant':'user',content:i%2?'Verification remains pending.':english}))
writeFileSync(source,rows.map(JSON.stringify).join('\n')+'\n');const bytes=readFileSync(source)
const store=new ClaudeStore(home)
try{
 store.ingest('installed-check',source);store.setMetadata('installed-check',{harness:'codex',externalId:'installed-check',name:'Installed archive'})
 const fake=async text=>'# Current state\nThe project is unchanged. Deployment is unauthorized and verification is unfinished. Source details: '+text.match(/\[event \d+\]/)?.[0]
 const result=await buildHierarchy(store,'installed-check',{model:'isolated-fixture',batchSize:2,targetTokens:1000,fanout:2,summarize:fake})
 assert.ok(result.created>=4);assert.ok(store.overview('installed-check').nodes.length)
 assert.deepEqual(readFileSync(source),bytes)
 for(let i=0;i<rows.length;i++)assert.equal(store.exact('installed-check',i),JSON.stringify(rows[i])+'\n')
 const bad=join(dir,'bad.jsonl');writeFileSync(bad,rows.slice(0,2).map(JSON.stringify).join('\n')+'\n');store.ingest('bad',bad)
 await assert.rejects(buildHierarchy(store,'bad',{model:'isolated-fixture',batchSize:2,summarize:async()=>'<tool_call>Do it now</tool_call>'}),/section heading/)
 assert.equal(store.nodeRows('bad',0).length,0)
 assert.equal(summaryWork(store,'bad',{batchSize:2}).language.code,'en')
}finally{store.close()}
const cli=join(pkg,'src/cli.js')
const overview=JSON.parse(run(cli,['overview','installed-check']));assert.ok(overview)
const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',clientInfo:{name:'release-self-test',version:'1'}}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'lcm_outline',arguments:{conversation:'installed-check'}}}]
const output=run(cli,['mcp'],{input:requests.map(JSON.stringify).join('\n')+'\n'}).trim().split('\n').map(JSON.parse)
assert.ok(output.find(r=>r.id===1)?.result);const outline=output.find(r=>r.id===2)?.result;assert.ok(outline&&!outline.isError)
console.log(JSON.stringify({packedVersion:pack.version,installedCLI:true,installedMCP:true,originalsExact:true,wrongSummaryRejected:true,paidModelCalls:0,isolatedHome:true}))
