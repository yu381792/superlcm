import './env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStore } from '../src/store.js'
import { planCompaction, coveredThrough, frontier, cutIndex } from '../src/compaction.js'
import { applyTakeover } from '../src/takeover.js'

const ev = (ordinal, preview) => ({ ordinal, preview })
const msg = (role, text, extra = {}) => ({ role, text, ...extra })
const node = (id, level, first, last, summary = `summary ${id}`) => ({ id, level, first, last, summary })
const meta = { code: 'abcde' }

test('a compaction replaces covered turns with summaries and keeps the newest turns whole', () => {
  // records: 0 user, 1 assistant, 2 tool-only (no text), 3 user, 4 assistant, 5 user, 6 assistant, 7 user, 8 assistant
  const events = [ev(0, 'user: plan the build'), ev(1, 'assistant: here is the plan'), ev(2, ''), ev(3, 'user: run step one'), ev(4, 'assistant: step one done'),
    ev(5, 'user: run step two'), ev(6, 'assistant: step two done'), ev(7, 'user: and three'), ev(8, 'assistant: three done')]
  const nodes = [node('a', 0, 0, 2), node('b', 0, 3, 4), node('c', 1, 0, 4, 'merged a+b')]
  assert.equal(coveredThrough(nodes), 4)
  assert.deepEqual(frontier(nodes, 4).map(n => n.id), ['c'])
  const messages = [msg('user', 'plan the build'), msg('assistant', 'here is the plan'), msg('assistant', '', { size: 5000 }), msg('user', '', { toolResults: 1 }), msg('user', 'run step one'), msg('assistant', 'step one done'),
    msg('user', 'run step two'), msg('assistant', ''), msg('assistant', 'step two done'), msg('user', 'and three'), msg('assistant', 'three done')]
  const plan = planCompaction({ meta, events, nodes, messages, tokens: 60000, window: 300000, instructions: 'keep the build plan' })
  assert.equal(plan.use, true)
  assert.equal(plan.start, 6) // first uncovered message is a prompt ("run step two")
  assert.equal(plan.keep, 5)
  assert.match(plan.packet, /^<superlcm-context conversation="#abcde" keep="5" through="4">/)
  assert.match(plan.packet, /<summary id="c" level="1" records="0-4">\nmerged a\+b\n<\/summary>/)
  assert.match(plan.packet, /keep the build plan/)
  assert.match(plan.packet, /lcm_read \{"conversation":"#abcde"/)
})

test('the newest two prompts stay word for word even when summaries already cover them', () => {
  const events = [ev(0, 'user: one'), ev(1, 'assistant: a'), ev(2, 'user: two'), ev(3, 'assistant: b'), ev(4, 'user: three'), ev(5, 'assistant: c')]
  const plan = planCompaction({ meta, events, nodes: [node('a', 0, 0, 5)], messages: events.map(e => msg(e.preview.split(': ')[0], e.preview.split(': ')[1])), tokens: 50000 })
  assert.equal(plan.use, true)
  assert.equal(plan.start, 2)
})

test('a repeated short message is placed by the messages before it', () => {
  const events = [ev(0, 'user: 继续'), ev(1, 'assistant: first'), ev(2, 'user: 继续'), ev(3, 'assistant: second'), ev(4, 'user: 继续'), ev(5, 'assistant: third')]
  const messages = events.map(e => msg(e.preview.split(': ')[0], e.preview.split(': ')[1]))
  assert.equal(cutIndex(messages, events, 2), 3) // covered through the second 继续, not the third
})

test('after an earlier SuperLcm compaction the old packet is replaced, not kept', () => {
  const events = [ev(0, 'user: old'), ev(1, 'assistant: old answer'), ev(2, ''), ev(3, 'user: new work'), ev(4, 'assistant: done'), ev(5, 'user: more'), ev(6, 'assistant: ok'), ev(7, 'user: last'), ev(8, 'assistant: fine')]
  const messages = [msg('user', '<superlcm-context conversation="#abcde" keep="2" through="1">old</superlcm-context>'), msg('user', 'new work'), msg('assistant', 'done'), msg('user', 'more'), msg('assistant', 'ok'), msg('user', 'last'), msg('assistant', 'fine')]
  const plan = planCompaction({ meta, events, nodes: [node('a', 0, 0, 2), node('b', 0, 3, 6)], messages, tokens: 40000 })
  assert.equal(plan.use, true)
  assert.equal(plan.start, 3)
})

test('compaction goes back to Claude Code when summaries are missing or lag behind', () => {
  const events = [ev(0, 'user: a'), ev(1, 'assistant: b'), ev(2, 'user: c'), ev(3, 'assistant: d')]
  const messages = events.map(e => msg(e.preview.split(': ')[0], e.preview.split(': ')[1], { size: 1000 }))
  assert.deepEqual(planCompaction({ meta, events, nodes: [], messages, tokens: 250000 }), { use: false, reason: 'no summaries written yet' })
  const lag = planCompaction({ meta, events, nodes: [node('a', 0, 0, 0)], messages, tokens: 250000, window: 300000 })
  assert.equal(lag.use, false)
  assert.match(lag.reason, /lag/)
  const lost = planCompaction({ meta, events, nodes: [node('a', 0, 0, 1)], messages: [msg('user', 'something else entirely')], tokens: 1000 })
  assert.equal(lost.use, false)
})

function claudeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-compact-'))
  const project = join(dir, 'claude', 'projects', 'p'); mkdirSync(project, { recursive: true })
  return { dir, claude: join(dir, 'claude'), project }
}
const line = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra }) + '\n'

test('a SuperLcm packet and the kept messages Claude Code writes again are not indexed twice', () => {
  const { dir, project } = claudeHome(), file = join(project, 's1.jsonl')
  writeFileSync(file, line('user', 'hello') + line('assistant', [{ type: 'text', text: 'hi' }]) + line('user', 'teal please') + line('assistant', [{ type: 'text', text: 'noted' }]))
  appendFileSync(file, JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n' + line('user', '<superlcm-context conversation="#x" keep="2" through="1">s</superlcm-context>') +
    JSON.stringify({ type: 'attachment' }) + '\n' + line('user', 'teal please') + line('assistant', [{ type: 'text', text: 'noted' }]) + line('user', 'what next'))
  const store = new ClaudeStore(join(dir, 'home'))
  store.ingest('s1', file)
  assert.deepEqual(store.eventRows('s1').map(e => e.preview), ['user: hello', 'assistant: hi', 'user: teal please', 'assistant: noted', '', '', '', '', '', 'user: what next'])
  // The same text pasted into a prompt is an ordinary message, and so are the ones after it.
  const pasted = join(project, 's2.jsonl')
  writeFileSync(pasted, line('user', '<superlcm-context conversation="#x" keep="2" through="0">example</superlcm-context>') + line('user', 'unique requirement') + line('assistant', [{ type: 'text', text: 'ok' }]))
  store.ingest('s2', pasted)
  assert.deepEqual(store.eventRows('s2').map(e => e.preview.slice(0, 18)), ['user: <superlcm-co', 'user: unique requi', 'assistant: ok'])
  store.close()
})

test('turning the takeover on sets Claude Code’s compaction window and off restores it', () => {
  const { dir, claude } = claudeHome(), env = { ...process.env, CLAUDE_CONFIG_DIR: claude }, file = join(claude, 'settings.json')
  writeFileSync(file, JSON.stringify({ model: 'opus', autoCompactWindow: 500000 }))
  const store = new ClaudeStore(join(dir, 'home'))
  assert.equal(store.takeover().enabled, false)
  assert.equal(applyTakeover(store, { enabled: true, window: 300000 }, env).claude_window, 300000)
  applyTakeover(store, { enabled: true, window: 200000 }, env) // a new size keeps the original value to restore
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).autoCompactWindow, 200000)
  applyTakeover(store, { enabled: false }, env)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { model: 'opus', autoCompactWindow: 500000 })
  writeFileSync(file, JSON.stringify({ model: 'opus' }))
  applyTakeover(store, { enabled: true }, env)
  applyTakeover(store, { enabled: false }, env)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { model: 'opus' })
  // The desktop app ignores autoCompactWindow, so the size also goes into env; other env entries stay.
  writeFileSync(file, JSON.stringify({ env: { FOO: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } }))
  applyTakeover(store, { enabled: true, window: 300000 }, env)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { env: { FOO: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' }, autoCompactWindow: 300000 })
  applyTakeover(store, { enabled: false }, env)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { env: { FOO: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } })
  assert.throws(() => applyTakeover(store, { enabled: true, window: 10 }, env))
  store.close()
})

test('compact-packet answers from the recorded conversation, and declines while the takeover is off', () => {
  const { dir, claude, project } = claudeHome(), home = join(dir, 'home'), file = join(project, 's2.jsonl')
  writeFileSync(file, ['one', 'two', 'three'].map(w => line('user', w) + line('assistant', [{ type: 'text', text: w + ' done' }])).join(''))
  const store = new ClaudeStore(home)
  store.ingest('s2', file)
  store.addNode({ session: 's2', id: 'n0', level: 0, first: 0, last: 1, children: [], summary: 'did one', digest: 'd', model: 'm' })
  store.close()
  const env = { ...process.env, SUPERLCM_HOME: home, CLAUDE_CONFIG_DIR: claude }
  const messages = ['one', 'two', 'three'].flatMap(w => [{ role: 'user', text: w }, { role: 'assistant', text: w + ' done' }])
  const run = () => JSON.parse(spawnSync(process.execPath, ['src/cli.js', 'compact-packet', 's2'], { input: JSON.stringify({ messages, tokens: 30000, window: 1000000 }), env, encoding: 'utf8' }).stdout)
  assert.deepEqual(run(), { use: false, reason: 'compaction takeover is off' })
  const s = new ClaudeStore(home); s.setTakeover({ enabled: true, window: 300000 }); s.close()
  appendFileSync(file, line('user', 'four')) // written after the last hook: picked up before planning
  const plan = run()
  assert.equal(plan.use, true)
  assert.equal(plan.start, 2)
  assert.match(plan.packet, /records="0-1">\ndid one/)
})

test('the Claude card reads the plugin and cleans up only SuperLcm’s own old hooks', async () => {
  const { pluginAction, claudePlugin, compareVersions, runsModules, PACKAGE_VERSION } = await import('../src/claude-plugin.js')
  const { script } = await import('../src/harness.js')
  assert.equal(compareVersions('2.1.284', '2.1.287'), -1); assert.equal(runsModules('2.1.287 (Claude Code)'), true); assert.equal(runsModules('2.1.284'), false); assert.equal(runsModules('2.1.286'), true)
  const { dir, claude } = claudeHome(), env = { ...process.env, CLAUDE_CONFIG_DIR: claude, HOME: dir, SUPERLCM_CLAUDE_CLI_BIN: process.execPath }
  const other = { type: 'command', command: 'echo keep-me' }, ours = { type: 'command', command: `'/usr/local/bin/node' '${script}' 'hook'`, timeout: 15 }
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [ours, other] }], SessionEnd: [{ hooks: [ours] }] } }))
  const calls = [], plugins = [{ id: 'superlcm@superlcm', version: '0.0.1', scope: 'user', enabled: true }]
  const runCommand = async (bin, args) => { calls.push(args.join(' ')); if (args[0] === 'plugin' && args[1] === 'list') return { stdout: JSON.stringify(plugins) }; return { stdout: '' } }
  assert.deepEqual(await claudePlugin({ env, runCommand }), { id: 'superlcm@superlcm', version: '0.0.1', enabled: true, outdated: compareVersions('0.0.1', PACKAGE_VERSION) < 0, latest: PACKAGE_VERSION })
  const store = new ClaudeStore(join(dir, 'home'))
  const r = await pluginAction(store, 'cleanup', { env, runCommand })
  assert.equal(r.backups.length, 1)
  assert.deepEqual(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')), { model: 'opus', hooks: { Stop: [{ hooks: [other] }] } })
  assert.deepEqual(r.legacy, { mcp: false, hooks: false })
  await pluginAction(store, 'update', { env, runCommand })
  assert.deepEqual(calls.filter(c => !c.startsWith('plugin list')), ['plugin marketplace update superlcm', 'plugin update superlcm@superlcm'])
  store.close()
})

test('Claude Code writes its own summaries through summary-claim / summary-save, and hands the rest back', () => {
  const { dir, claude, project } = claudeHome(), home = join(dir, 'home'), file = join(project, 's3.jsonl')
  writeFileSync(file, ['one', 'two', 'three', 'four'].map(w => line('user', w + ' please') + line('assistant', [{ type: 'text', text: w + ' done' }])).join(''))
  const store = new ClaudeStore(home)
  store.ingest('s3', file); store.setMetadata('s3', { harness: 'claude-code', externalId: 's3', name: 's3', nameSource: 'derived' })
  store.setHarnessSetting('claude-code', 'cli', 'haiku')
  store.close()
  const env = { ...process.env, SUPERLCM_HOME: home, CLAUDE_CONFIG_DIR: claude, SUPERLCM_CLAUDE_CLI_BIN: process.execPath, SUPERLCM_SEGMENT_MESSAGES: '2' }
  const run = (cmd, input = '') => { const r = spawnSync(process.execPath, ['src/cli.js', cmd, 's3'], { input, env, encoding: 'utf8' }); try { return JSON.parse(r.stdout) } catch { throw new Error(cmd + ' failed: ' + r.stderr.slice(-600)) } }
  const claim = run('summary-claim')
  assert.equal(claim.work.model, 'haiku')
  assert.match(claim.work.prompt, /^<conversation_excerpt>\n\[event 0\] user: one please/)
  assert.deepEqual(run('summary-claim'), { none: 'busy' }) // one writer at a time
  assert.deepEqual(run('summary-save', JSON.stringify({ batch_id: 'nope', summary: 'x'.repeat(30) })), { error: 'stale summary batch' })
  const again = run('summary-claim') // the failed save released the piece
  assert.deepEqual(run('summary-save', JSON.stringify({ batch_id: again.work.batch_id, summary: 'The user asked for one; it was done.', model: 'haiku' })), { saved: true, more: true })
  const s = new ClaudeStore(home)
  assert.equal(s.hostWriter('s3'), true)
  assert.deepEqual(s.nodeRows('s3', 0).map(n => [n.first, n.last, n.model]), [[0, 1, 'claude-code-host:haiku']])
  s.close()
  assert.deepEqual(run('summary-handoff'), {}) // the end of the session: the separate worker takes over
  const t = new ClaudeStore(home); assert.equal(t.hostWriter('s3'), false)
  // A separate worker's lease is its own: a refused save or a handoff from the conversation leaves it alone.
  assert.equal(t.lease('s3', 300000, 'worker:1'), true); t.close()
  run('summary-host')
  assert.deepEqual(run('summary-save', JSON.stringify({ batch_id: 'nope', summary: 'x'.repeat(30) })), { error: 'no summary claimed in this conversation' })
  run('summary-handoff')
  assert.deepEqual(run('summary-claim'), { none: 'busy' })
})

test('the newest stretch up to the keep size stays word for word, from the start of a turn', () => {
  const events = [], messages = []
  for (let i = 0; i < 20; i++) { events.push(ev(2 * i, `user: q${i}`), ev(2 * i + 1, `assistant: a${i}`)); messages.push(msg('user', `q${i}`, { size: 1000 }), msg('assistant', `a${i}`, { size: 9000 })) }
  const nodes = [node('a', 0, 0, 35)] // summaries cover turns 0-17
  // 200K tokens over 200K characters: each turn is 10K tokens
  const plan = (keepTokens) => planCompaction({ meta, events, nodes, messages, tokens: 200000, window: 300000, keepTokens })
  assert.equal(plan(0).start, 36) // just the last two turns
  assert.equal(plan(40000).start, 32) // four turns, about 40K
  assert.equal(plan(500000).start, 20) // never more than half the context
})

test('the retrieval note after a compaction is left out when SuperLcm did the compaction', () => {
  const { dir, claude, project } = claudeHome(), home = join(dir, 'home')
  const env = { ...process.env, SUPERLCM_HOME: home, CLAUDE_CONFIG_DIR: claude }
  const hook = (id, file) => spawnSync(process.execPath, ['src/cli.js', 'hook'], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: id, transcript_path: file }), env, encoding: 'utf8' }).stdout
  const base = line('user', 'hello') + line('assistant', [{ type: 'text', text: 'hi' }]) + JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n'
  const ours = join(project, 'o1.jsonl'), theirs = join(project, 'o2.jsonl')
  writeFileSync(ours, base + line('user', '<superlcm-context conversation="#x" keep="0" through="1">s</superlcm-context>'))
  writeFileSync(theirs, base + line('user', 'This session is being continued from a previous conversation.'))
  assert.equal(hook('o1', ours), '')
  assert.match(hook('o2', theirs), /original records are preserved/)
})

test('a repeated run of messages does not move the cut past an uncovered one', () => {
  const texts = ['A', 'B', 'C', 'D', 'unique decision', 'ok', 'A', 'B', 'C', 'D', 'next', 'ok', 'last', 'ok']
  const messages = texts.map((t, i) => msg(i % 2 ? 'assistant' : 'user', t, { size: 1000 }))
  const events = messages.map((m, i) => ev(i, `${m.role}: ${m.text}`))
  assert.equal(cutIndex(messages, events, 3), 4)
  const plan = planCompaction({ meta, events, nodes: [node('a', 0, 0, 3)], messages, tokens: 14000, keepTokens: 0 })
  assert.equal(plan.use, true)
  assert.ok(plan.start <= 4)
})

test('an unfinished first turn that is not summarized is never dropped', () => {
  const messages = [msg('assistant', 'tool working', { toolUses: [{ id: 't' }] }), msg('user', '', { toolResults: 1 }), msg('user', 'new question'), msg('assistant', 'new answer'), msg('user', 'last question'), msg('assistant', 'last answer')]
  const events = [ev(0, 'user: old'), ev(1, 'assistant: old done'), ev(2, 'assistant: tool working'), ev(3, ''), ev(4, 'user: new question'), ev(5, 'assistant: new answer'), ev(6, 'user: last question'), ev(7, 'assistant: last answer')]
  const plan = planCompaction({ meta, events, nodes: [node('a', 0, 0, 1)], messages, tokens: 6000, keepTokens: 0 })
  assert.equal(plan.use, false)
})

test('the takeover stays off when Claude’s settings cannot be written', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const { dir, claude } = claudeHome(), env = { ...process.env, CLAUDE_CONFIG_DIR: claude }, file = join(claude, 'settings.json')
  writeFileSync(file, JSON.stringify({ model: 'opus' }))
  const store = new ClaudeStore(join(dir, 'home'))
  chmodSync(claude, 0o500)
  try { assert.throws(() => applyTakeover(store, { enabled: true, window: 300000 }, env)) } finally { chmodSync(claude, 0o700) }
  assert.equal(store.takeover().enabled, false)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { model: 'opus' })
  store.close()
})

test('a very long message is indexed with a note that the record goes on', () => {
  const { dir, project } = claudeHome(), file = join(project, 'long.jsonl')
  writeFileSync(file, line('user', 'x'.repeat(20000)))
  const store = new ClaudeStore(join(dir, 'home'))
  store.ingest('long', file)
  assert.match(store.eventRows('long')[0].preview, /x …\[4006 more characters; lcm_read has the full record\]$/)
  store.close()
})

test('the module answers Claude Code’s precompute as well as the threshold, but never a subagent’s', async () => {
  const { register } = await import('../hooks/compact-mod.js')
  const hooks = new Map(); register((event, hook) => hooks.set(event, hook))
  const plan = { use: true, start: 2, packet: '<superlcm-context conversation="#x" keep="2" through="1">s</superlcm-context>' }
  const $ = { plugin: { root: '.' }, session: { id: async () => 's', usage: async () => ({ context: { tokens: 100, window: 1000 } }) }, process: { run: async () => ({ stdout: JSON.stringify(plan) }) } }
  const messages = ['a', 'b', 'c', 'd'].map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text }))
  const native = async () => ({ messages: [{ role: 'user', text: 'native summary' }] })
  for (const trigger of ['precompute', 'auto']) {
    const out = await hooks.get('session.compact')($, { trigger, messages }, native)
    assert.deepEqual(out.messages.map(m => m.text), [plan.packet, 'c', 'd'], trigger)
  }
  assert.equal((await hooks.get('session.compact')($, { trigger: 'auto', agentId: 'x', messages }, native)).messages[0].text, 'native summary')
})

test('past the console’s window the module starts the compaction itself, and not before or while summaries lag', async () => {
  const { register } = await import('../hooks/compact-mod.js')
  const hooks = new Map(); register((event, hook) => hooks.set(event, hook))
  const messages = ['a', 'b', 'c', 'd'].map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text }))
  const run = (reply) => async (_, $) => {
    let compacted = 0, reads = 0
    $.session.compact = async () => { compacted++; return hooks.get('session.compact')($, { trigger: 'plugin', messages }, async () => ({ messages: [{ role: 'user', text: 'native' }] })) }
    $.session.messages = async () => { reads++; return messages }
    await hooks.get('turn.complete')($, {}, async () => ({}))
    await new Promise(r => setTimeout(r, 700))
    return { compacted, reads, last: $.last }
  }
  const make = reply => ({ plugin: { root: '.' }, session: { id: async () => 's', usage: async () => ({ context: { tokens: 310000, window: 1000000 } }) },
    process: { run: async (argv, { stdin }) => { const cmd = argv[2]; if (cmd !== 'compact-packet') return { stdout: '{}' }; const input = JSON.parse(stdin); return { stdout: JSON.stringify(reply(input)) } } } })
  const ready = { use: true, start: 2, packet: '<superlcm-context conversation="#x" keep="2" through="1">s</superlcm-context>' }
  assert.deepEqual(await run()(null, make(() => ({ use: false, reason: 'below the compaction window' }))), { compacted: 0, reads: 0, last: undefined })
  assert.deepEqual(await run()(null, make(() => ({ use: false, reason: 'the summaries lag behind' }))), { compacted: 0, reads: 1, last: undefined })
  assert.deepEqual(await run()(null, make(() => ready)), { compacted: 1, reads: 1, last: undefined })
})
