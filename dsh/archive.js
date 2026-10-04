import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import { home } from '../src/store.js'
import { tools } from '../src/mcp.js'
import { dshSessionKey,projectDshEvent } from '../src/dsh.js'
import { SuperLcmStore, resolveDatabasePath } from './store.js'
import { migrateLegacyIndex } from './migration.js'
import { reindexSession } from './core.js'
import { apply as mountNativeTools } from './tool.js'
import { ArchiveWorker } from './worker-client.js'
import { readRawDshSession } from './raw-session.js'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'superlcm-archive'
export const inject = ['tools','sessionQuery','sessions']
export const Config = z.object({archiveHome:z.string().default('')})

export function projectEvent(id, event) {
  return projectDshEvent(id,event,extractSessionEventText(event))
}

export function apply(ctx,config={}) {
  const archiveHome=resolve(config.archiveHome || home()), expected = join(archiveHome, 'lcm.sqlite')
  if ((process.env.DSH_SUPERLCM_DB||process.env.DSH_LOSSLESS_DB) && resolve(resolveDatabasePath()) !== expected) throw Error('DSH_SUPERLCM_DB must point to the shared SuperLcm archive; remove the old override')
  const native = new SuperLcmStore(expected)
  const reporter = native.compressionReporter({ kind: 'archive', profile: ctx.get?.('profileContext')?.name || null,
    enabled: true, routeReady: true, onError: () => ctx.logger?.warn?.('SuperLcm 归档状态写入失败') })
  const migrated = migrateLegacyIndex(native)
  if (migrated.added) ctx.logger?.info?.(`SuperLcm 已迁入 ${migrated.added} 条旧 DSH 摘要`)
  for (const conflict of migrated.conflicts) ctx.logger?.warn?.(`SuperLcm 旧摘要迁入冲突：${conflict.sessionId}/${conflict.nodeId}（${conflict.fields.join(', ')}）；共享索引与旧档案均保留，未覆盖`)
  const warn = error => ctx.logger?.warn?.('SuperLcm 归档：' + (error?.message || error))
  const dirty = new Set(), cursors = new Map(), observed = new Set()
  let stopped = false, running = null
  reporter.report('', 'starting')
  const worker = new ArchiveWorker({...process.env,SUPERLCM_HOME:archiveHome}, warn, {
    onUnavailable(error) { reporter.report('', 'failed'); warn(error) },
    onReady() {
      if (stopped) return
      reporter.report('', 'loaded')
      // The host can mount this plugin after its ready event. Retry already
      // archived sources at worker readiness instead of waiting for a new chat
      // message or requiring the user to import a stranded archive manually.
      for (const id of native.archivedSessionIds()) observed.add(id)
      for (const session of ctx.sessions.list()) observed.add(session.id)
      for (const id of observed) dirty.add(id)
      queueMicrotask(drain)
      // Live sessions and existing mirrors do not include cold histories that
      // this plugin has never observed. Discover those after a late mount too;
      // a failed persistence listing must not block the known-source replay.
      void (async () => {
        try {
          const sessions = await ctx.sessionQuery.listSessions()
          if (stopped) return
          for (const { header } of sessions) {
            if (observed.has(header.id)) continue
            observed.add(header.id); dirty.add(header.id)
          }
          queueMicrotask(drain)
        } catch (error) { warn(error) }
      })()
    },
  })

  const capture = async id => {
    const live = ctx.sessions.get(id), cursor = cursors.get(id)
    // After initial replay, use the live immutable event feed by seq. Copying
    // a whole long log after every tool event would turn capture into O(n²).
    const incremental = live && cursor !== undefined
    const observation = incremental ? {
      header: live.header,
      events: Array.from({ length: Math.max(0, live.seq - cursor) }, (_, index) => live.eventAt(cursor + index)),
      close() {},
    } : await readRawDshSession(ctx, id)
    try {
      const events = observation.events, header = observation.header
      const session = { id, header, snapshotEvents: () => events }
      if (!incremental) {
        const indexed = reindexSession(native, session)
        if (indexed.errors.length) warn(Error('DSH 摘要索引：' + JSON.stringify(indexed.errors)))
      }
      const title = [...events].reverse().find(event => event.type === 'session/title')?.data?.title
      let from = cursors.get(id)
      if (from === undefined) from = await worker.request({ method: 'cursor', session: dshSessionKey(id) })
      if (!incremental && from > events.length) throw Error('DSH event history became shorter; refusing to replace archived history')
      // Bound each request by bytes and records, including a very large tool result.
      let batch = [], bytes = 0
      const flush = async () => {
        await worker.request({ method: 'capture', packet: { header, title, records: batch } })
        from += batch.length; cursors.set(id, from); batch = []; bytes = 0
      }
      for (let index = incremental ? 0 : from; index < events.length; index++) {
        const record = projectEvent(id, events[index]), size = Buffer.byteLength(JSON.stringify(record))
        if (size > 4 * 1024 * 1024) throw Error('DSH event exceeds the archive record limit at seq ' + events[index].seq)
        if (batch.length >= 500 || bytes + size > 24e6) await flush()
        batch.push(record); bytes += size
      }
      await flush() // Also sync a title or committed summary when there are no new events.
      reporter.report(id, 'synced', { end: from - 1 })
    } finally { await observation.close() }
  }
  const drain = () => {
    if (running || stopped) return running
    running = (async () => {
      while (dirty.size && !stopped) {
        const id = dirty.values().next().value; dirty.delete(id)
        try { await capture(id) } catch (error) {
          reporter.report(id, 'failed', { end: (cursors.get(id) ?? 0) - 1 })
          warn(Error(id + ': ' + error.message))
        }
      }
    })().finally(() => { running = null; if (dirty.size && !stopped) drain() })
    return running
  }
  ctx.on('session/event', (session) => { observed.add(session.id); dirty.add(session.id); queueMicrotask(drain) })
  ctx.on('ready', async () => {
    try { for (const { header } of await ctx.sessionQuery.listSessions()) { observed.add(header.id); dirty.add(header.id) }; drain() }
    catch (error) { warn(error) }
  })
  mountNativeTools(ctx, { store: native })
  for (const tool of tools.filter(t => !t.name.startsWith('lcm_summary_'))) {
    ctx.tools.register(createMcpToolDefinition(ctx, {
      ...tool, rawName: tool.name,
      description: 'SuperLcm 共享会话档案。' + tool.description,
      async call(args) {
        // Current-session reads observe all events accepted before this call.
        await drain()
        const value = await worker.request({ method: 'call', name: tool.name, args })
        return { content: [{ type: 'text', text: JSON.stringify(value) }] }
      },
    }))
  }
  ctx.effect(() => async () => { stopped = true; reporter.close(); await running; await worker.close(); native.close() })
}
