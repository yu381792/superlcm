import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { ClaudeStore } from '../src/store.js'
import { verifiedCompactionInput } from '../src/claude-compaction-input.js'
import { cutIndex, tailStart, planCompaction } from '../src/compaction.js'
import { summarizeWithModel, buildHierarchy } from '../src/summarize.js'
import { startWeb } from '../src/web.js'

const msg = (role, text, extra = {}) => ({ role, text, ...extra })
const events = ['user: old request', 'assistant: old answer', 'user: next request', 'assistant: next answer', 'user: latest request'].map((preview, ordinal) => ({ ordinal, preview }))
const nodes = [{ id: 'old', level: 0, first: 0, last: 1, summary: 'Verified older facts' }]
const plan = (messages, context = {}) => planCompaction({ meta: { code: 'fixture' }, events, nodes, messages, tokens: 250000, ...context })

test('tool-only cutoff candidates collapse and a complete tool group remains intact', () => {
  const messages = [msg('user', 'old request'), msg('assistant', 'old answer'), msg('assistant', '', { toolUses: [{ id: 'tool' }], size: 90000 }), msg('user', '', { toolResults: 1, size: 90000 }), msg('user', 'next request'), msg('assistant', 'next answer'), msg('user', 'latest request')]
  assert.equal(cutIndex(messages, events, 1), 2)
  const result = plan(messages)
  assert.equal(result.use, true)
  const retained = messages.slice(result.start)
  assert.equal(retained.some(m => m.toolUses?.length), retained.some(m => m.toolResults))
  assert.deepEqual(retained.filter(m => m.role === 'user').map(m => m.text), ['next request', 'latest request'])
})

test('native continuation is verified from archived metadata, not a text prefix', t => {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-issue1-')), store = new ClaudeStore(join(dir, 'store'))
  t.after(() => store.close())
  const native = 'This session is being continued from a previous conversation that ran out of context.\n' + 'Old summary. '.repeat(300)
  const source = join(dir, 'source.jsonl')
  writeFileSync(source, [
    { type: 'user', message: { content: 'earlier task' } },
    { type: 'assistant', message: { content: 'earlier answer' } },
    { type: 'user', isCompactSummary: true, message: { content: [{ type: 'text', text: native }] } },
    { type: 'user', message: { content: 'latest real user prompt' } },
    { type: 'assistant', message: { content: 'current answer' } }
  ].map(JSON.stringify).join('\n') + '\n')
  store.ingest('s', source)
  store.addNode({ session: 's', ...nodes[0], last: 2, children: [], digest: 'synthetic', model: 'fixture' })
  const live = [msg('user', native.slice(0, 2000), { size: 90000 }), msg('assistant', '', { size: 90000 }), msg('user', 'latest real user prompt'), msg('assistant', 'current answer')]
  const context = verifiedCompactionInput(store, 's', live)
  assert.equal(context.messages[0].nativeSummary, true)
  assert.equal(tailStart(context.messages, 2), 2)
  assert.equal(plan(context.messages, { events: context.events, nodes: store.nodeRows('s', 0) }).use, true)
  store.setTakeover({ enabled: true, window: 300000 })
  const run = spawnSync(process.execPath, ['src/cli.js', 'compact-packet', 's'], { env: { ...process.env, SUPERLCM_HOME: store.dir }, input: JSON.stringify({ messages: live, tokens: 250000 }), encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const packet = JSON.parse(run.stdout)
  assert.equal(packet.use, true, packet.reason)
  assert.equal(packet.start, 2)
  assert.equal(verifiedCompactionInput(store, 's', [msg('user', native.slice(0, 2000) + ' analyze this quote')]).messages[0].nativeSummary, false)
  assert.equal(verifiedCompactionInput(store, 's', [msg('user', 'another prompt'), ...live]).messages[1].nativeSummary, false)
  const quoted = join(dir, 'quoted.jsonl')
  writeFileSync(quoted, JSON.stringify({ type: 'user', message: { content: native } }) + '\n')
  store.ingest('quoted', quoted)
  assert.equal(verifiedCompactionInput(store, 'quoted', live).messages[0].nativeSummary, false)
  assert.equal(tailStart(live, 2), 0)
  appendFileSync(source, JSON.stringify({ type: 'user', message: { content: native + ' This is my quoted instruction.' } }) + '\n')
  store.ingest('s', source)
  const ambiguous = verifiedCompactionInput(store, 's', live)
  assert.equal(ambiguous.messages[0].nativeSummary, false, 'ordinary user text sharing the truncated prefix blocks synthetic classification')
  assert.equal(tailStart(ambiguous.messages, 2), 0)
})

test('an imported native summary with no covered historical source is never discarded', t => {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-issue1-import-')), store = new ClaudeStore(join(dir, 'store'))
  t.after(() => store.close())
  const native = 'This session is being continued from a previous conversation that ran out of context.\nHistorical constraint: never deploy without approval.'
  const source = join(dir, 'source.jsonl')
  writeFileSync(source, [
    { type: 'user', isCompactSummary: true, message: { content: native } },
    { type: 'user', message: { content: 'new prompt' } },
    { type: 'assistant', message: { content: 'new answer' } }
  ].map(JSON.stringify).join('\n') + '\n')
  store.ingest('s', source)
  const live = [msg('user', native, { size: 90000 }), msg('user', 'new prompt'), msg('assistant', 'new answer')]
  const context = verifiedCompactionInput(store, 's', live)
  assert.equal(context.messages[0].nativeSummary, false)
  const result = plan(live, { ...context, nodes: [], tokens: 250000 })
  assert.equal(result.use, false)
  // A complete summary covering the imported continuation makes it replaceable.
  store.addNode({ session: 's', id: 'covered-native', level: 0, first: 0, last: 0, summary: 'Historical constraint: never deploy without approval.', children: [], digest: 'fixture', model: 'fixture' })
  const ready = verifiedCompactionInput(store, 's', live)
  assert.equal(ready.messages[0].nativeSummary, true)
  assert.equal(plan(ready.messages, { events: ready.events, nodes: store.nodeRows('s', 0) }).use, true)
})

test('partial imports with an ordinary prefix still protect an uncovered native continuation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-issue1-mid-import-')), store = new ClaudeStore(join(dir, 'store'))
  t.after(() => store.close())
  const native = 'This session is being continued from a previous conversation that ran out of context.\nHistorical constraint only in this continuation: never deploy without approval.'
  const source = join(dir, 'source.jsonl')
  writeFileSync(source, [
    { type: 'user', message: { content: 'a message from the middle of a conversation' } },
    { type: 'user', isCompactSummary: true, message: { content: native } },
    { type: 'user', message: { content: 'new prompt' } }
  ].map(JSON.stringify).join('\n') + '\n')
  store.ingest('s', source)
  store.addNode({ session: 's', ...nodes[0], last: 0, children: [], digest: 'synthetic', model: 'fixture' })
  const live = [msg('user', native, { size: 90000 }), msg('user', 'new prompt')]
  const context = verifiedCompactionInput(store, 's', live)
  assert.equal(context.messages[0].nativeSummary, false)
  assert.equal(plan(context.messages, { events: context.events, nodes: store.nodeRows('s', 0) }).use, false)
})

const sse = chunks => chunks.map(x => 'data: ' + (typeof x === 'string' ? x : JSON.stringify(x)) + '\n\n').join('')
const call = (response, extra = {}) => summarizeWithModel('Synthetic source only', { model: 'requested-model', apiProvider: 'openai', baseURL: 'http://127.0.0.1:9', fetchImpl: async () => response, ...extra })
const stream = text => new Response(text, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
const delta = (content, extra = {}) => ({ model: 'actual-model', choices: [{ index: 0, delta: { content }, ...extra }] })

test('SSE accepts deltas, CRLF, comments, multi-line data, usage and choice zero', async () => {
  const raw = ': keepalive\r\n\r\nevent: message\r\ndata: {"choices": [\r\ndata: {"index":0,"delta":{"content":"Complete "}}]}\r\n\r\n' + sse([
    { choices: [{ index: 1, delta: { content: 'ignore' } }, { index: 0, delta: { content: 'grounded summary' } }] },
    delta('', { finish_reason: 'stop' }), { choices: [], usage: { total_tokens: 8 } }, '[DONE]'
  ])
  assert.equal(await call(stream(raw)), 'Complete grounded summary')
})

test('SSE accepts complete message content arrays and a terminal choice without DONE', async () => {
  assert.equal(await call(stream(sse([{ choices: [{ message: { content: [{ type: 'text', text: 'Whole summary' }] }, finish_reason: 'stop' }] }]))), 'Whole summary')
})

for (const [name, raw, pattern] of [
  ['malformed', sse([delta('partial'), '{broken', '[DONE]']), /Malformed/],
  ['null event', sse(['null', '[DONE]']), /Malformed/],
  ['named error event', sse([delta('partial', { finish_reason: 'stop' })]) + 'event: error\ndata: {"message":"SECRET SOURCE"}\n\n', /upstream error/],
  ['unknown event body', sse([delta('partial'), { message: 'SECRET SOURCE' }, '[DONE]']), /no choices/],
  ['upstream error', sse([delta('partial'), { error: { message: 'SECRET SOURCE' } }, '[DONE]']), /upstream error/],
  ['truncated', sse([delta('partial')]), /before completion/],
  ['nonterminal', sse([delta('partial', { finish_reason: 'in_progress' }), '[DONE]']), /nonterminal/],
  ['length capped', sse([delta('partial', { finish_reason: 'length' }), '[DONE]']), /incomplete/],
  ['empty success', sse([delta('', { finish_reason: 'stop' }), '[DONE]']), /no text/],
  ['no choice', sse([{ choices: [] }, '[DONE]']), /before completion/],
  ['after DONE', sse([delta('summary'), '[DONE]', delta('extra')]), /after completion/],
  ['after final choice', sse([delta('summary', { finish_reason: 'stop' }), delta('extra'), '[DONE]']), /after its final/]
]) test(`SSE refuses ${name} rather than storing partial summaries`, async () => {
  await assert.rejects(call(stream(raw)), error => pattern.test(error.message) && /model .*finish_reason/.test(error.message) && !error.message.includes('SECRET SOURCE'))
})

test('empty and nonempty in_progress JSON report the configured model and reason', async () => {
  for (const content of ['', 'partial summary']) await assert.rejects(call(new Response(JSON.stringify({ model: 'upstream-model', choices: [{ message: { content }, finish_reason: 'in_progress' }] }))), /model requested-model, finish_reason in_progress/)
  await assert.rejects(call(new Response(JSON.stringify({ choices: [{ message: { content: 'JSON without terminal evidence' } }] }))), /no terminal finish reason/)
})

test('stream bytes can arrive across UTF-8 and event boundaries', async () => {
  const raw = Buffer.from(sse([delta('完整摘要'), delta('', { finish_reason: 'stop' }), '[DONE]']))
  const body = new ReadableStream({ start(controller) { for (let i = 0; i < raw.length; i++) controller.enqueue(raw.subarray(i, i + 1)); controller.close() } })
  assert.equal(await call(new Response(body, { headers: { 'content-type': 'text/event-stream' } })), '完整摘要')
})

test('untrusted response metadata cannot enter persisted or displayed diagnostics', async () => {
  for (const format of ['json', 'sse']) {
    for (const content of ['', 'partial text']) {
      const result = { model: 'sk-SECRET-credential', choices: [{ index: 0, message: { content }, finish_reason: 'SECRET_SOURCE_FRAGMENT' }] }
      const response = format === 'json' ? new Response(JSON.stringify(result)) : stream(sse([result, '[DONE]']))
      await assert.rejects(call(response), error => /model requested-model, finish_reason unsupported/.test(error.message) && !/SECRET|sk-/.test(error.message))
    }
  }
})

test('failed background generation preserves source and writes a safe diagnostic', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-issue1-worker-')), store = new ClaudeStore(join(dir, 'store'))
  t.after(() => store.close())
  const source = join(dir, 'source.jsonl'), raw = [JSON.stringify({ role: 'user', content: 'SECRET SOURCE request' }), JSON.stringify({ role: 'assistant', content: 'SECRET SOURCE answer' })].join('\n') + '\n'
  writeFileSync(source, raw); store.ingest('s', source)
  try { await buildHierarchy(store, 's', { model: 'requested-model', batchSize: 2, summarize: () => call(stream(sse([delta('partial'), { error: { message: 'SECRET SOURCE' } }], '[DONE]'))) }); assert.fail('should reject') }
  catch (error) { store.recordSummaryError('s', error); store.setStatus('s', 'summary_error') }
  assert.equal(store.nodeRows('s', 0).length, 0)
  assert.equal(store.exact('s', 0) + store.exact('s', 1), raw)
  assert.match(store.summaryError('s'), /model requested-model/)
  assert.doesNotMatch(store.summaryError('s'), /SECRET SOURCE/)
  store.recordSummaryError('s', Error('SECRET SOURCE generic failure'))
  assert.doesNotMatch(store.summaryError('s'), /SECRET SOURCE/)
})

test('the real background CLI persists diagnostics through new turns and clears them after successful retry', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-issue1-cli-')), store = new ClaudeStore(join(dir, 'store'))
  t.after(() => store.close())
  const source = join(dir, 'source.jsonl')
  writeFileSync(source, events.map(e => JSON.stringify({ role: e.preview.split(': ')[0], content: e.preview.split(': ')[1] })).join('\n') + '\n')
  store.ingest('s', source)
  let succeed = false
  const fake = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(succeed ? sse([delta('Whole tested summary', { finish_reason: 'stop' }), '[DONE]']) : sse([delta('', { finish_reason: 'in_progress' }), '[DONE]']))
  })
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => fake.close(resolve)))
  store.setGlobalSetting('api', 'requested-model', 'openai', `http://127.0.0.1:${fake.address().port}/v1/chat/completions`)
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', 'summarize', 's'], { env: { ...process.env, SUPERLCM_HOME: store.dir, SUPERLCM_SEGMENT_MESSAGES: '2' }, stdio: 'ignore' })
    child.once('error', reject); child.once('close', resolve)
  })
  assert.equal(await run(), 1)
  assert.equal(store.source('s').status, 'summary_error')
  assert.match(store.summaryError('s'), /finish_reason in_progress/)
  appendFileSync(source, JSON.stringify({ role: 'user', content: 'another real prompt' }) + '\n')
  store.ingest('s', source)
  assert.equal(store.source('s').status, 'summary_error', 'successful indexing does not resolve a summary failure')
  const web = await startWeb({ store: new ClaudeStore(store.dir), env: { HOME: dir }, discovery: async () => [], catalog: async () => ({ models: [] }) })
  t.after(() => web.close())
  const detail = await fetch(web.url + 'api/conversation?session=s').then(r => r.json())
  assert.equal(detail.status, 'summary_error')
  assert.match(detail.summary_error_detail, /finish_reason in_progress/)
  succeed = true
  assert.equal(await run(), 0)
  assert.equal(store.source('s').status, 'ok')
  assert.equal(store.summaryError('s'), null)
  assert.equal(store.nodeRows('s', 0).length, 3)
})
