import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  describeNode,
  doctorSession,
  expandNode,
  reindexSession,
  searchSuperLcmContext,
} from './core.js'
import { SuperLcmStore, resolveDatabasePath } from './store.js'

export const name = 'SuperLcm-tools'
export const inject = ['tools']

function requireSession(exec) {
  const session = exec?.agent?.session
  if (session === undefined || session === null) {
    throw new Error('this tool requires a live DSH agent session')
  }
  return session
}

function asJsonBlocks(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function canonicalScope(value) {
  return ['summary', 'events', 'both'].includes(value) ? value : 'both'
}

function positiveInteger(value, fallback, max) {
  if (!Number.isSafeInteger(value) || value <= 0) return fallback
  return Math.min(value, max)
}

export function createSuperLcmToolDefinitions(store) {
  const jsonOutput = {
    schema: { type: 'json' },
    render: (_args, value) => asJsonBlocks(value),
  }

  return [
    defineTool({
      name: 'lcm_grep',
      description: 'Search compacted summary nodes and/or exact raw events in the current DSH session. Use this before guessing details from old context.',
      parameters: {
        query: { type: 'string', required: true, description: 'Text to search for.' },
        scope: { type: 'string', enum: ['summary', 'events', 'both'], description: 'Search summaries, raw events, or both. Default: both.' },
        limit: { type: 'number', description: 'Maximum hits per section. Default 20, maximum 100.' },
      },
      output: jsonOutput,
      execute(args, exec) {
        const session = requireSession(exec)
        reindexSession(store, session)
        return Promise.resolve(searchSuperLcmContext(store, session, args.query, {
          scope: canonicalScope(args.scope),
          limit: positiveInteger(args.limit, 20, 100),
        }))
      },
      presentCall: args => ({ card: 'generic', title: `Search SuperLcm context: ${String(args.query ?? '')}`, kind: 'search', rawInput: args }),
    }),

    defineTool({
      name: 'lcm_describe',
      description: 'Describe one compacted summary node in the current session: summary, source event range, parents, children, model, and token accounting.',
      parameters: {
        node_id: { type: 'string', required: true, description: 'Node id returned by lcm_grep, lcm_expand_query, or a checkpoint marker.' },
      },
      output: jsonOutput,
      execute(args, exec) {
        const session = requireSession(exec)
        reindexSession(store, session)
        return Promise.resolve(describeNode(store, session, args.node_id))
      },
      presentCall: args => ({ card: 'generic', title: `Describe LCM node ${String(args.node_id ?? '')}`, kind: 'read', rawInput: args }),
    }),

    defineTool({
      name: 'lcm_expand',
      description: 'Recover exact JSON event data cited by one compacted node. Results are paged without dropping the middle of a large event; follow next.sourceOffset and next.eventCharOffset until next is null.',
      parameters: {
        node_id: { type: 'string', required: true, description: 'Node id to expand.' },
        source_offset: { type: 'number', description: 'Index into the node source-event list. Default 0.' },
        event_char_offset: { type: 'number', description: 'Character offset inside the first selected event. Default 0.' },
        max_chars: { type: 'number', description: 'Maximum exact event characters to return. Default 30000, maximum 100000.' },
        recursive_depth: { type: 'number', description: 'Include DAG metadata to this child depth. Default 0, maximum 8.' },
      },
      output: jsonOutput,
      execute(args, exec) {
        const session = requireSession(exec)
        reindexSession(store, session)
        return Promise.resolve(expandNode(store, session, {
          nodeId: args.node_id,
          sourceOffset: Number.isSafeInteger(args.source_offset) ? args.source_offset : 0,
          eventCharOffset: Number.isSafeInteger(args.event_char_offset) ? args.event_char_offset : 0,
          maxChars: positiveInteger(args.max_chars, 30000, 100000),
          recursiveDepth: Number.isSafeInteger(args.recursive_depth) ? args.recursive_depth : 0,
        }))
      },
      presentCall: args => ({ card: 'generic', title: `Expand LCM node ${String(args.node_id ?? '')}`, kind: 'read', rawInput: args }),
    }),

    defineTool({
      name: 'lcm_expand_query',
      description: 'Search compacted summaries, then recover exact source-event pages for the best matching nodes. Use lcm_expand for further pages.',
      parameters: {
        query: { type: 'string', required: true, description: 'Text to search in compacted summaries.' },
        limit: { type: 'number', description: 'Number of matching nodes. Default 3, maximum 10.' },
        max_chars: { type: 'number', description: 'Total exact event-character budget shared across matches. Default 30000, maximum 100000.' },
      },
      output: jsonOutput,
      execute(args, exec) {
        const session = requireSession(exec)
        reindexSession(store, session)
        const limit = positiveInteger(args.limit, 3, 10)
        const totalBudget = positiveInteger(args.max_chars, 30000, 100000)
        const search = searchSuperLcmContext(store, session, args.query, { scope: 'summary', limit })
        let remaining = totalBudget
        const matches = search.summaries.map((hit, index) => {
          const remainingMatches = search.summaries.length - index
          const allocation = remaining === 0 ? 0 : Math.max(1, Math.floor(remaining / remainingMatches))
          if (allocation === 0) return { hit, expansion: null }
          const expansion = expandNode(store, session, {
            nodeId: hit.nodeId,
            maxChars: allocation,
            recursiveDepth: 1,
          })
          const used = expansion.chunks.reduce((total, chunk) => total + chunk.content.length, 0)
          remaining = Math.max(0, remaining - used)
          return { hit, expansion }
        })
        return Promise.resolve({
          sessionId: search.sessionId,
          query: args.query,
          maxChars: totalBudget,
          returnedChars: totalBudget - remaining,
          matches,
        })
      },
      presentCall: args => ({ card: 'generic', title: `Search and expand SuperLcm context: ${String(args.query ?? '')}`, kind: 'search', rawInput: args }),
    }),

    defineTool({
      name: 'lcm_reindex',
      description: 'Rebuild or incrementally refresh the SQLite summary-DAG index from committed compaction events in the current DSH session. Raw session events are never modified.',
      parameters: {
        rebuild: { type: 'boolean', description: 'Delete this session\'s derived index first, then rebuild it. Default false.' },
      },
      output: jsonOutput,
      execute(args, exec) {
        const session = requireSession(exec)
        const result = reindexSession(store, session, { rebuild: args.rebuild === true })
        return Promise.resolve({ ...result, stats: store.stats(session.id ?? session.header?.id) })
      },
      presentCall: args => ({ card: 'generic', title: args.rebuild === true ? 'Rebuild SuperLcm index' : 'Refresh SuperLcm index', kind: 'execute', rawInput: args }),
    }),

    defineTool({
      name: 'lcm_doctor',
      description: '检查当前会话的 SuperLcm DAG、精确源指针、重复 ID、缺失节点、悬空子边和 SQLite 完整性 / Check the current session\'s SuperLcm DAG, exact source pointers, duplicate ids, missing nodes, dangling child edges, and SQLite integrity.',
      parameters: {
        repair: { type: 'boolean', description: 'Rebuild the derived SQLite index before checking. Raw session events remain untouched. Default false.' },
      },
      output: jsonOutput,
      execute(args, exec) {
        const session = requireSession(exec)
        const repair = args.repair === true
        const reindex = repair ? reindexSession(store, session, { rebuild: true }) : null
        return Promise.resolve({ repair, reindex, report: doctorSession(store, session) })
      },
      presentCall: args => ({ card: 'generic', title: args.repair === true ? 'Repair and check SuperLcm' : 'Check SuperLcm', kind: args.repair === true ? 'execute' : 'read', rawInput: args })
    }),
  ]
}

// 兼容旧版 SuperLcm、SuperLCM 与 dsh-lossless-context <= 0.2.x 的导出 / Compatibility exports for older SuperLcm, SuperLCM, and dsh-lossless-context <= 0.2.x.
export const createSuperLCMToolDefinitions = createSuperLcmToolDefinitions
export const createLosslessToolDefinitions = createSuperLcmToolDefinitions

export function apply(ctx) {
  const store = new SuperLcmStore(resolveDatabasePath())
  ctx.effect(() => () => store.close())
  for (const definition of createSuperLcmToolDefinitions(store)) {
    ctx.tools.register(definition)
  }
}
