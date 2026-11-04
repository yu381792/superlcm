// Real installed-Pi tool loop: background at 70%, prepared replacement at 80%.
// Default uses a gated local summary endpoint; --live-luna uses saved Luna.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { ClaudeStore } from '../src/store.js'
import { piExtension } from '../src/pi.js'
import { savePiPolicy } from '../src/pi-compaction-policy.js'
import { readApiKey, saveApiKey } from '../src/api-credentials.js'
import { findCli } from '../src/runtime.js'
import { estimatePiRequest, piOutputReserve, piWindowSafety } from '../src/pi-request.js'
import { estimateSummaryTokens } from '../src/summary-tokens.js'
const mainFork = process.argv.includes('--main-fork')
const lateRedactor=process.argv.includes('--late-redactor'),privateSentinel='PRIVATE_SUMMARY_SOURCE_ONLY'
const queuedInput=process.argv.includes('--queued-input'),abortAfterReplacement=process.argv.includes('--abort-after-replacement'),nativeOverflow=process.argv.includes('--native-overflow')
assert.ok(!(queuedInput||abortAfterReplacement||nativeOverflow)||mainFork,'lifecycle fixtures require --main-fork')
const overGoal=process.argv.includes('--over-planning-target')
const earlyNative=process.argv.includes('--early-native-compaction')
const imageHistory=process.argv.includes('--image-history'),blockImages=process.argv.includes('--block-images'),modelInput=imageHistory?['text','image']:['text']
const imageData='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN3cAAAAASUVORK5CYII='
assert.ok(!blockImages||imageHistory,'blocked-image fixture needs image history')
const fullWindow=process.argv.includes('--full-window'),scale=fullWindow?5:1,window=100000*scale,maxTokens=fullWindow?128000:1024
const otherModel=process.argv.includes('--other-model'), ratio50=process.argv.includes('--ratio50')
assert.ok(!(otherModel||ratio50||overGoal||earlyNative||imageHistory)||mainFork,'native model/ratio fixtures require --main-fork')
const passive = process.argv.includes('--passive-only')
const live = process.argv.includes('--live-luna'), dir = mkdtempSync(join(tmpdir(), 'superlcm-pi-background-'))
const slow = process.argv.includes('--slow-luna'), fail = process.argv.includes('--fail-luna'), cold = process.argv.includes('--cold-input')
const wirePressure=process.argv.includes('--wire-pressure'),lateSystem=process.argv.includes('--late-system'),foregroundDuringSummary=process.argv.includes('--foreground-during-summary'),oversizedBranchPrefix=process.argv.includes('--oversized-branch-prefix')
assert.ok(!wirePressure||mainFork&&cold&&fullWindow,'wire pressure requires the 500K cold native fixture')
assert.ok(!abortAfterReplacement||cold,'abort-after-replacement requires cold recovery')
assert.ok(!lateSystem||mainFork&&cold,'late system fixture requires cold native recovery')
assert.ok(!oversizedBranchPrefix||mainFork&&cold&&fullWindow,'oversized prefix fixture requires 500K cold recovery')
assert.ok(!foregroundDuringSummary||mainFork&&fullWindow&&!cold,'foreground concurrency fixture requires the 500K live native loop')
const huge = process.argv.includes('--huge-tool-output'), largeInput = process.argv.includes('--oversized-input')
const nativePayload = process.argv.includes('--oversized-native-payload'), nativeOutput = process.argv.includes('--oversized-native-output')
const malformed = process.argv.includes('--malformed-summary'), missing = process.argv.includes('--missing-summary-node'), truncated = process.argv.includes('--truncated-summary')
const badSummary = malformed || missing || truncated, nativeFault = nativePayload
assert.ok(!live || !(slow || fail || cold || huge || largeInput || nativeFault || badSummary), 'fault injection uses only the local endpoint')
assert.ok(!overGoal||!live,'over-goal fixture uses only the local endpoint')
assert.ok(!(nativeFault || nativeOutput || badSummary) || mainFork, 'native fork faults require --main-fork')
assert.ok(!passive || mainFork && !live && !slow && !fail && !nativeFault && !badSummary, 'passive fixture uses the local native branch')
const agentDir = join(dir, 'agent'), cwd = join(dir, 'work'), sessions = join(agentDir, 'sessions')
for (const path of [agentDir, cwd, sessions, join(agentDir, 'extensions')]) mkdirSync(path, { recursive: true })
process.env.PI_CODING_AGENT_DIR = agentDir
let packageRoot = dirname(realpathSync(findCli('pi')))
while (!existsSync(join(packageRoot, 'package.json'))) {
  const parent=dirname(packageRoot); if(parent===packageRoot)throw Error('Cannot locate installed Pi SDK package')
  packageRoot=parent
}
const sdk = await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href)
const aiRoot = join(packageRoot, 'node_modules/@earendil-works/pi-ai/dist')
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(aiRoot, 'utils/event-stream.js')).href)
const { fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(join(aiRoot, 'providers/faux.js')).href)
const archive = new ClaudeStore(join(dir, 'archive'))
let server, mainServer, faultTimer, branchSummaryBudget, apiCalls = 0, session, mainCalls = 0, readyApiCalls, swapApiCalls, swapEntry, abortedNativeCalls = 0, transportCalls = 0
const mainPayloads = [], branchPayloads = []
const statuses=[],lifecycle=[],notifications=[]
let mainStartedResolve,releaseBranch,foregroundBeforeSummary=false,branchReleased=false
const mainStarted = new Promise(resolve => { mainStartedResolve = resolve })
const branchGate = new Promise(resolve => { releaseBranch = resolve })
try {
  let model
  mainServer = createServer(async (req, res) => {
    transportCalls++
    if (!mainFork) { res.writeHead(500); res.end('unexpected main HTTP request'); return }
    req.setEncoding('utf8')
    let raw=''; for await (const data of req) raw+=data
    if(blockImages)assert.ok(!raw.includes(imageData),'blocked image must never reach the provider')
    if(lateRedactor){assert.ok(!raw.includes(privateSentinel),'the late redactor must cover foreground, branch and directive anchors');assert.equal(req.headers['x-fixture-redacted'],'yes','auxiliary requests inherit the header processing chain')}
    const body=JSON.parse(raw), last=body.messages.at(-1)?.content
    const directive=typeof last==='string'?last:JSON.stringify(last)
    const branch=directive?.includes('Return one JSON object without fences')
    let content, tool=false, tokens
    if(branch){
      apiCalls++;branchPayloads.push(body)
      if(lateSystem){
        assert.ok(raw.includes('LATE_SYSTEM_POLICY_KEEP'),'the branch must keep the latest folded system policy')
        assert.ok(!raw.includes('LATE_USER_REQUEST_KEEP_VERBATIM'),'the cold branch must omit the retained dialogue tail')
      }
      if(foregroundDuringSummary){let timer;await Promise.race([branchGate,new Promise(resolve=>{timer=setTimeout(resolve,5000)})]);clearTimeout(timer);branchReleased=true}
      // Main-fork failure now retries indefinitely. Explicit user cancellation
      // ends this failure-only fixture after the saved foreground turn pauses.
      if((fail||badSummary)&&!faultTimer)faultTimer=setTimeout(()=>{void session.abort()},500)
      if(fail){res.writeHead(503);res.end('synthetic branch failure');return}
      if(slow||nativeOverflow)await new Promise(resolve=>setTimeout(resolve,nativeOverflow?150:400))
      const plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{"index":')))
      if(missing)plan.pop()
      const blocks=plan.map(part=>({index:part.index,summary:'# 当前状态\n检查尚未结束。部署必须另行获得用户明确授权。原始路径和证据请回查。'}))
      if(overGoal){
        const goal=Number(directive.match(/together must fit (\d+) tokens/)[1])
        const total=()=>estimateSummaryTokens(blocks.map(b=>b.summary).join('\n'))
        const wanted=Math.ceil(goal*1.07)
        blocks[0].summary+='证'.repeat(Math.ceil(Math.max(0,wanted-total())/1.5))
        branchSummaryBudget={goal,total:total(),output:piOutputReserve(body),root:estimateSummaryTokens(blocks.at(-1).summary)}
        assert.ok(branchSummaryBudget.total>goal&&branchSummaryBudget.total<branchSummaryBudget.output)
      }
      content=JSON.stringify({blocks});tokens=500
      if(malformed)content='invalid JSON from synthetic summary provider'
    }else{
      mainPayloads.push(body);mainCalls++;mainStartedResolve();tool=!nativeOverflow&&!(cold&&mainFork)&&mainCalls< (foregroundDuringSummary||slow?2:3)
      if(nativeOverflow&&mainCalls===1){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'maximum context length exceeded',type:'invalid_request_error',code:'context_length_exceeded'}}));return}
      if(nativeOverflow){assert.ok(raw.includes('SuperLcm'),'native overflow recovery must install before retry');assert.equal(mainCalls,2)}
      if(queuedInput&&mainCalls===3)assert.ok(raw.includes('QUEUED_INPUT_KEEP_VERBATIM'),'steering must reach the next real provider request')
      if(abortAfterReplacement){setTimeout(()=>{void session.abort()},0);await new Promise(resolve=>setTimeout(resolve,40))}
      if(foregroundDuringSummary){
        const hard=window-piWindowSafety({contextWindow:window},.8)-1024
        assert.ok(mainCalls===1?estimatePiRequest(body)<hard:estimatePiRequest(body)>hard,'the second raw request must cross the coarse physical guard')
        if(mainCalls===2){foregroundBeforeSummary=apiCalls===1&&!branchReleased;releaseBranch()}
      }
      if(cold&&mainFork){assert.ok(raw.includes('SuperLcm'),'cold recovery must replace provider context before its first main HTTP request');assert.ok(raw.includes('LATE_USER_REQUEST_KEEP_VERBATIM'),'cold recovery must keep the original request in the actual provider context')}
      if(mainCalls=== (slow?2:3)){if(!passive)assert.ok(swapEntry);assert.ok(raw.includes('LATE_USER_REQUEST_KEEP_VERBATIM'));assert.ok(raw.includes('LATE_TOOL_RESULT_KEEP_VERBATIM'))}
      tokens=(mainCalls===1?(foregroundDuringSummary?70000:slow||fail||badSummary?95000:(ratio50?49000:79000)):tool?(ratio50?51000:81000):1100)*scale
      content=tool?null:'合成测试正常结束。'
    }
    const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'call-'+mainCalls,type:'function',function:{name:'background_checkpoint',arguments:'{}'}}]}:{role:'assistant',content}
    res.writeHead(200,{'content-type':'text/event-stream'})
    for(const chunk of [{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:branch&&truncated?'length':tool?'tool_calls':'stop'}],usage:{prompt_tokens:tokens-100,completion_tokens:100,total_tokens:tokens,prompt_tokens_details:{cached_tokens:branch?256:0}}}])res.write('data: '+JSON.stringify(chunk)+'\n\n')
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => mainServer.listen(0, '127.0.0.1', resolve))
  if (live) {
    const origin = new ClaudeStore()
    try {
      const saved = origin.apiModel(origin.harnessSetting('pi')?.api_ref || origin.harnessSetting('dsh')?.api_ref)
      assert.equal(saved?.model, 'gpt-6-luna')
      const { id, ...fields } = saved; model = archive.saveApiModel(fields)
      const key = readApiKey(origin.dir, 'model:' + id, saved.url)
      if (key) saveApiKey(archive.dir, 'model:' + model.id, key, model.url)
    } finally { origin.close() }
  } else {
    server = createServer(async (req, res) => {
      req.setEncoding('utf8')
      let body = ''; for await (const chunk of req) body += chunk
      assert.equal(JSON.parse(body).model, 'fixture-luna'); apiCalls++
      assert.ok(body.includes('部署必须另行获得用户明确授权'))
      if (!cold) await mainStarted // Main model can begin while summary generation is unfinished.
      if (slow) await new Promise(resolve => setTimeout(resolve, 400))
      if (fail || cold) { res.writeHead(503); res.end('synthetic Luna failure'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '# 当前任务\n检查合成项目，保留原文。部署必须另行获得用户明确授权。工作仍在检查阶段。\n\n## 需要回查\n具体路径和工具结果请读取原始记录。' } }] }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    model = archive.saveApiModel({ provider: 'openai', model: 'fixture-luna', url: `http://127.0.0.1:${server.address().port}/v1`, effort: 'high' })
  }
  archive.setHarnessSetting('pi', 'api', null, null, null, model.id); archive.setIntegrationEnabled('pi', true)
  savePiPolicy(archive, { enabled: !passive, ratio: ratio50?.5:.8, ...(mainFork?{summaryMode:'main-fork'}:{}) })
  writeFileSync(join(agentDir, 'extensions/superlcm.ts'), piExtension({ node: process.execPath, script: fileURLToPath(new URL('../src/cli.js', import.meta.url)), home: archive.dir }))
  if(lateRedactor)writeFileSync(join(agentDir,'extensions/zz-redactor.ts'),`export default function(pi){pi.on('before_provider_request',event=>JSON.parse(JSON.stringify(event.payload).replaceAll(${JSON.stringify(privateSentinel)},'[REDACTED]')));pi.on('before_provider_headers',event=>{event.headers['x-fixture-redacted']='yes'})}`)
  if(mainFork&&cold)writeFileSync(join(agentDir,'extensions/99-wire.ts'),`import{writeFileSync}from'node:fs';export default function(pi){pi.on('before_provider_request',event=>{writeFileSync(${JSON.stringify(join(dir,'cold-main-wire.json'))},JSON.stringify(event.payload))})}`)
  if(nativeFault||nativeOutput)writeFileSync(join(agentDir,'extensions/zz-native-fault.ts'), `export default function(pi){pi.on('before_provider_request',event=>({...event.payload,${nativePayload?"tools:[{type:'function',function:{name:'oversized_tool',description:'中'.repeat(120000),parameters:{type:'object',properties:{}}}}]":"max_tokens:90000"}}))}`)
  const manager = sdk.SessionManager.create(cwd, sessions)
  const usage = tokens => ({ input: tokens - 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })
  for (let i = 0; i < 8; i++) {
    // A cold-capacity fixture must exceed the real wire budget, rather than
    // merely reporting large synthetic usage for a tiny request that fits.
    const coldEvidence=cold&&mainFork?'证'.repeat(Math.ceil(window*(oversizedBranchPrefix?1.15:fullWindow?.82:1.03)/12)):foregroundDuringSummary?'证'.repeat(33000):''
    const text=`请检查第 ${i} 处。部署必须另行获得用户明确授权。` + (lateRedactor?privateSentinel:'') + '保留准确路径和失败原因。'.repeat(fullWindow?400:40)+coldEvidence
    manager.appendMessage({ role: 'user', content: imageHistory&&i===0?[{type:'text',text},{type:'image',mimeType:'image/png',data:imageData}]:text, timestamp: Date.now() })
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `第 ${i} 处尚未结束。` + '路径为 /tmp/synthetic-project，工具结果回查原文。'.repeat(fullWindow?120:12) }], api: 'openai-completions', provider: 'fixture-main', model: 'scripted-main', usage: usage((wirePressure?69000:cold ? mainFork&&!fullWindow?90000:95000 : ratio50?40000:70000)*scale), stopReason: 'stop', timestamp: Date.now() })
  }
  if(lateSystem)manager.appendMessage({role:'system',content:'LATE_SYSTEM_POLICY_KEEP',timestamp:Date.now()})
  const original = readFileSync(manager.getSessionFile(), 'utf8')
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: earlyNative?Math.floor(window*.4):1, keepRecentTokens: 512 }, images:{blockImages}, enableAnalytics: false, enableInstallTelemetry: false })
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true })
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, [])
  const modelsFile=join(agentDir,'models.json')
  {
    writeFileSync(modelsFile,JSON.stringify({providers:{'fixture-main':{baseUrl:`http://127.0.0.1:${mainServer.address().port}/v1`,api:'openai-completions',apiKey:'synthetic-no-credential',models:[...(otherModel?[{id:'scripted-summary',name:'Scripted summary',reasoning:false,input:modelInput,contextWindow:window,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]:[]),{id:'scripted-main',name:'Scripted main',reasoning:false,input:modelInput,contextWindow:window,maxTokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}))
  }
  if(otherModel)archive.setHarnessSetting('pi','main-fork','fixture-main/scripted-summary')
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: modelsFile, refreshOnCreate: false })
  if(mainFork&&cold){
    const stream=modelRuntime.streamSimple.bind(modelRuntime)
    modelRuntime.streamSimple=(model,context,options)=>stream(model,context,{...options,onPayload(payload){try{return options.onPayload(payload)}catch(error){writeFileSync(join(dir,'cold-branch-wire.json'),JSON.stringify(payload));throw error}}})
  }
  // Isolated scripted provider: no real credential or chat endpoint is used.
  const hasAuth = modelRuntime.hasConfiguredAuth.bind(modelRuntime)
  modelRuntime.hasConfiguredAuth = provider => provider === 'fixture-main' || hasAuth(provider)
  const key = 'pi-' + manager.getSessionId()
  const checkpoint = { name: 'background_checkpoint', label: 'fixture checkpoint', description: 'Deterministic test barrier', parameters: { type: 'object', properties: {} }, async execute() {
    if(foregroundDuringSummary&&mainCalls===1){
      const deadline=Date.now()+10000
      while(!apiCalls&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20))
      assert.equal(apiCalls,1,'the background branch must start before the tool returns')
    }else if (mainCalls === 1 && !slow && !fail && !badSummary) {
      const deadline = Date.now() + (mainFork?20000:240000)
      while (Date.now() < deadline) {
        if (archive.db.prepare("SELECT 1 FROM sqlite_master WHERE name='pi_prepared_compactions'").get() && archive.db.prepare('SELECT 1 FROM pi_prepared_compactions WHERE session=?').get(key)) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.ok(archive.db.prepare('SELECT 1 FROM pi_prepared_compactions WHERE session=?').get(key), 'background draft must complete while the main tool call is alive')
      readyApiCalls = apiCalls
    }
    if(queuedInput&&mainCalls===2)assert.equal(await session.steer('QUEUED_INPUT_KEEP_VERBATIM：保留这条在途追加指令。'),'queued')
    return { content: [{ type: 'text', text: 'LATE_TOOL_RESULT_KEEP_VERBATIM' + (huge ? '巨'.repeat(120000) : foregroundDuringSummary?'证'.repeat(20000):'') }], details: {} }
  } }
  const result = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: manager, modelRuntime, customTools: [checkpoint],
    model: { id: 'scripted-main', name: 'Scripted test model', api: 'openai-completions', provider: 'fixture-main', baseUrl: `http://127.0.0.1:${mainServer.address().port}/v1`, reasoning: false, input: modelInput, contextWindow: window, maxTokens, cost: usage(1000).cost } })
  session = result.session
  if(!mainFork) modelRuntime.getProvider('fixture-main').streamSimple = (_model, context, options) => {
    const stream = createAssistantMessageEventStream()
    queueMicrotask(async()=>{
      try{
        // Exercise the same effective-provider boundary as a real SDK instead
        // of bypassing it with an agent.streamFunction override.
        await options.onPayload?.({messages:context.messages,max_tokens:_model.maxTokens})
        options.signal?.throwIfAborted()
    mainCalls++; mainStartedResolve()
    assert.ok(!cold, 'cold input at capacity must never reach the main provider')
    assert.ok(!largeInput, 'oversized input must never reach the main provider')
    assert.ok(!fail || mainCalls === 1, 'failed Luna at capacity must stop before the next main provider request')
    assert.ok(!huge || mainCalls === 1, 'unshrinkable tool result must stop before the next main provider request')
    if (mainCalls === 1 && !live) assert.equal(swapEntry, undefined)
    const finalCall = slow ? 2 : 3
    if (mainCalls === finalCall) {
      assert.ok(swapEntry, '80% turn boundary must already have installed the prepared summary')
      const text = JSON.stringify(context.messages)
      assert.ok(text.includes('SuperLcm')); assert.ok(text.includes('LATE_USER_REQUEST_KEEP_VERBATIM')); assert.ok(text.includes('LATE_TOOL_RESULT_KEEP_VERBATIM'))
    }
    assert.ok(mainCalls <= finalCall, 'tool chain must continue naturally, without extra injected turns')
    const message = fauxAssistantMessage(mainCalls < finalCall ? [fauxToolCall('background_checkpoint', {}, { id: 'call-' + mainCalls })] : '合成测试正常结束。', { stopReason: mainCalls < finalCall ? 'toolUse' : 'stop' })
    Object.assign(message, { usage: usage(mainCalls === 1 ? (slow || fail ? 95000 : (ratio50?49000:79000)) : mainCalls === finalCall ? 1100 : (ratio50?51000:81000)), provider: 'fixture-main', model: 'scripted-main' })

        stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end(message)
      }catch(error){
        const message=fauxAssistantMessage('',{stopReason:options.signal?.aborted?'aborted':'error'})
        message.errorMessage=error.message;stream.push({type:'error',reason:message.stopReason,error:message});stream.end(message)
      }
    })
    return stream
  }
  session.subscribe(event => {if(['agent_settled','compaction_start','compaction_end'].includes(event.type))lifecycle.push({type:event.type,aborted:event.aborted,errorMessage:event.errorMessage});if (event.type === 'entry_appended' && event.entry.type === 'compaction') { swapEntry = event.entry; swapApiCalls = apiCalls };if(event.type==='compaction_end'&&event.result){swapEntry=manager.getEntries().findLast(e=>e.type==='compaction');swapApiCalls=apiCalls} })
  await session.bindExtensions({onError:error=>console.error('Fixture extension error:',error.message),uiContext:{notify:text=>{notifications.push(text);console.error('Fixture notice:',text)},setStatus:(_key,text)=>statuses.push(text)}})
  assert.ok(session.getActiveToolNames().includes('lcm_read'))
  await session.prompt('LATE_USER_REQUEST_KEEP_VERBATIM：继续检查，禁止部署。' + (largeInput ? '中'.repeat(120000) : ''))
  if(nativeOverflow){
    assert.ok(swapEntry,'native overflow must not cancel an unfinished background draft')
    assert.equal(mainCalls,2);assert.equal(apiCalls,1)
    assert.ok(readFileSync(manager.getSessionFile(),'utf8').startsWith(original))
    assert.ok(lifecycle.some(e=>e.type==='compaction_end'&&!e.errorMessage))
    console.log(JSON.stringify({ok:true,mode:'native-overflow',summaryCalls:apiCalls,mainCalls,nativeRetryContinued:true,fullOriginalPreserved:true,directory:dir}))
  }else if(foregroundDuringSummary){
    assert.equal(mainCalls,2);assert.equal(apiCalls,1)
    assert.ok(foregroundBeforeSummary,'the next foreground request must run before the slow background summary finishes')
    assert.ok(readFileSync(manager.getSessionFile(),'utf8').startsWith(original))
    console.log(JSON.stringify({ok:true,mode:'foreground-during-summary',summaryCalls:apiCalls,mainCalls,foregroundBeforeSummary,fullOriginalPreserved:true,directory:dir}))
  }else if(mainFork&&cold){
    const deadline=Date.now()+20000
    while(!swapEntry&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20))
    if(!swapEntry)console.error(JSON.stringify({directory:dir,statuses,lifecycle,apiCalls,mainCalls}))
    assert.ok(swapEntry,'a cold over-capacity session must recover without an initial capture')
    assert.equal(mainCalls,1);assert.equal(apiCalls,1)
    if(oversizedBranchPrefix){
      assert.ok(manager.getEntries().some(e=>e.type==='custom'&&e.customType==='superlcm-summary-resize'),'an oversized source must move to an earlier complete boundary')
      assert.ok(!manager.getEntries().some(e=>e.type==='custom'&&e.customType==='superlcm-summary-failure'),'local capacity rejection must not enter timed retry')
    }
    assert.ok(readFileSync(manager.getSessionFile(),'utf8').includes('LATE_USER_REQUEST_KEEP_VERBATIM'))
    const receipt={ok:true,mode:abortAfterReplacement?'abort-after-request-replacement':'cold-native-recovery',foregroundAborted:abortAfterReplacement,installedPi:JSON.parse(readFileSync(join(packageRoot,'package.json'))).version,directory:dir,mainRequestsBeforePreparedContext:0,summaryCalls:apiCalls,fullOriginalPreserved:readFileSync(manager.getSessionFile(),'utf8').startsWith(original),foregroundResumed:!abortAfterReplacement,nativeBoundaryCommit:true,extraContinueRequired:false}
    writeFileSync(join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt))
  }else if(passive){
    assert.equal(swapEntry,undefined);assert.equal(apiCalls,1);assert.equal(mainCalls,3)
    const receipt=archive.db.prepare('SELECT * FROM fork_summary_receipts WHERE session=?').get(key)
    assert.ok(receipt);assert.ok(archive.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE session=?').get(key).n>0)
    assert.ok(readFileSync(manager.getSessionFile(),'utf8').startsWith(original))
    const result={ok:true,mode:'passive-only',installedPi:JSON.parse(readFileSync(join(packageRoot,'package.json'))).version,summaryCalls:apiCalls,mainCalls,contextReplacements:0,fullOriginalPreserved:true,directory:dir}
    writeFileSync(join(dir,'receipt.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
  } else if (fail || cold || huge || largeInput || nativeFault || badSummary) {
    assert.equal(swapEntry, undefined); assert.equal(mainCalls, cold || largeInput || nativeFault ? 0 : 1)
    assert.equal(transportCalls, mainFork ? mainCalls + apiCalls : 0, 'unsafe extra main request must never send HTTP')
    if (!mainFork && (fail || huge)) assert.ok(abortedNativeCalls >= 1, 'exercise the real installed native provider with the aborted signal')
    const raw = readFileSync(manager.getSessionFile(), 'utf8')
    assert.ok(raw.startsWith(original)); assert.ok(raw.includes('LATE_USER_REQUEST_KEEP_VERBATIM'))
    if (cold || largeInput) assert.ok(raw.includes('superlcm-deferred-input'))
    else if(!nativeFault) assert.ok(raw.includes('LATE_TOOL_RESULT_KEEP_VERBATIM'))
    const receipt = { ok: true, mode: nativePayload?'oversized-native-payload':nativeOutput?'oversized-native-output':malformed?'malformed-summary':missing?'missing-summary-node':truncated?'truncated-summary':largeInput ? 'oversized-input' : huge ? 'unshrinkable-tool-result' : cold ? 'cold-input-failure' : 'tool-boundary-failure', directory: dir, mainCalls, abortedNativeCalls, unsafeProviderRequests: mainFork ? transportCalls-mainCalls-apiCalls : transportCalls, fullOriginalPreserved: true }
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt))
  } else {
  if(mainFork){
    const branchPlans=branchPayloads.map(p=>JSON.parse(p.messages.at(-1).content.split('\n').find(line=>line.startsWith('[{"index":'))))
    if(branchPlans.length>1){
      assert.ok(slow&&fullWindow,'only a verified insufficient draft may require expanded recovery')
      assert.equal(branchPlans.length,2);assert.ok(statuses.some(text=>text?.includes('旧摘要覆盖不足')))
      assert.ok(branchPlans[1].at(-1).lastMessage>branchPlans[0].at(-1).lastMessage,'recovery must cover additional source, not regenerate the same range')
    }else assert.equal(branchPlans.length,1)
    assert.equal(apiCalls,branchPlans.length)
    const branch=branchPayloads[0], main=mainPayloads[0]
    writeFileSync(join(dir,'wire-fixtures.json'),JSON.stringify({branch,main}))
    assert.deepEqual(branch.messages.slice(0,-1),main.messages)
    if(otherModel){
      assert.deepEqual({...branch,messages:[],model:undefined,max_tokens:undefined,max_completion_tokens:undefined},{...main,messages:[],model:undefined,max_tokens:undefined,max_completion_tokens:undefined})
      assert.equal(piOutputReserve(branch),1024,'the selected summary model keeps its own output limit')
    }else{
      assert.deepEqual({...branch,messages:[],model:undefined,max_tokens:undefined,max_completion_tokens:undefined},{...main,messages:[],model:undefined,max_tokens:undefined,max_completion_tokens:undefined})
      assert.ok(piOutputReserve(branch)>0&&piOutputReserve(branch)<=maxTokens,'background output is independently bounded by its model and selected prefix')
    }
    assert.equal(branch.model,otherModel?'scripted-summary':'scripted-main');assert.equal(main.model,'scripted-main')
    assert.equal(swapEntry.details.providerUsage.cacheRead,256)
    if(overGoal){
      assert.ok(branchSummaryBudget.total>branchSummaryBudget.goal)
      assert.equal(estimateSummaryTokens(swapEntry.details.summaryTree.map(n=>n.summary).join('\n')),branchSummaryBudget.total,'save the full tree without trimming')
    }
    if(fullWindow){assert.equal(piOutputReserve(main),ratio50&&!nativeOutput?128000:90000);assert.equal(session.model.maxTokens,128000)}
    if(nativeOutput&&!fullWindow)assert.equal(piOutputReserve(main),18000)
  }
  assert.ok(swapEntry); assert.equal(swapEntry.details.backgroundPrepared, true); assert.equal(swapEntry.details.model, mainFork?(otherModel?'scripted-summary':'scripted-main'):model.model)
  if(earlyNative)assert.ok(swapEntry.tokensBefore>=window*(ratio50?.5:.8),'native automatic compaction must not bypass the configured replacement threshold')
  assert.equal(swapEntry.details.replacementModelCalls, 0); assert.equal(swapEntry.fromExtension ?? swapEntry.fromHook, true)
  if (!live && !slow) assert.equal(swapApiCalls - readyApiCalls, 0, 'replacement must not call the summary API')
  assert.equal(mainCalls, slow ? 2 : 3); assert.ok(readFileSync(manager.getSessionFile(), 'utf8').startsWith(original))
  assert.ok(archive.eventRows(key).map(row => archive.exact(key, row.ordinal)).join('').startsWith(original))
  const receipt = { ok: true, directory: dir, installedPi: JSON.parse(readFileSync(join(packageRoot, 'package.json'))).version, backgroundAt: ratio50?'40%':'70%', replacedAt: ratio50?'50%':'80%', mainContinuedDuringPreparation: true,
    mode: mainFork?'native-main-fork':slow ? 'slow-summary-capacity-wait' : 'normal',contextWindow:window,configuredMaxTokens:maxTokens,effectiveMaxTokens:mainFork?piOutputReserve(mainPayloads[0]):undefined, uninterruptedMainTurns: mainCalls, summaryModel: mainFork?(otherModel?'scripted-summary':'scripted-main'):model.model, summaryModelCalls:apiCalls,expandedRecovery:mainFork&&branchPayloads.length>1, replacementSummaryHttpRequests: live || slow ? 'lookup-only path' : swapApiCalls - readyApiCalls,
    nativeBoundaryCommit: true, appendedUserAndToolResultsPreserved: true, fullOriginalPreserved: true,...(queuedInput?{queuedInputDelivered:true}:{}),...(overGoal?{branchSummaryBudget}:{}),...(earlyNative?{earlyNativeCompactionRespected:true}:{}) }
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt))
  }
  if(lateRedactor){assert.ok(original.includes(privateSentinel));assert.ok(readFileSync(manager.getSessionFile(),'utf8').startsWith(original));assert.ok(apiCalls>0);console.log(JSON.stringify({lateRedactor:true,foregroundRequests:mainCalls,summaryRequests:apiCalls,secretReachedProvider:false,originalsUnchanged:true}))}
  assert.ok(!notifications.some(text=>/正在后台准备|正在后台生成归档|摘要准备完成后/.test(text)),'normal background preparation must not notify')
  const completed=notifications.filter(text=>text.startsWith('上下文已压缩'))
  assert.equal(completed.length,swapEntry?1:0,'notify exactly once, and only after the native checkpoint is installed')
} finally {
  clearTimeout(faultTimer)
  if (session) { await session.extensionRunner?.emit?.({ type: 'session_shutdown' }); session.dispose() }
  mainStartedResolve()
  if (server) await new Promise(resolve => server.close(resolve))
  if (mainServer) await new Promise(resolve => mainServer.close(resolve))
  archive.close()
}
