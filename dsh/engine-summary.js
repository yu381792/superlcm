import { randomUUID } from 'node:crypto'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { cleanRoute, routeIsConfigured } from './engine-config.js'
import { appendRecallEnvelope } from './marker.js'
import { nativeSummaryTask } from './summary-task.js'
import { summaryCallContext } from './summary-session.js'
import { SUMMARY_SYSTEM, RECALL_POLICY, summaryInstructions, checkedSummary } from '../src/summary-policy.js'
export async function summarizeWithRecall(engine,args) {
    const lease=engine.acquireSummary?.()
    try {
    await (lease?.ready||engine.summaryModelReady)
    const metadata = args[3] ?? nativeSummaryTask(engine,args[0],args[1])
    const children = Array.isArray(metadata?.trustedChildNodeIds)
      ? [...new Set(metadata.trustedChildNodeIds)]
      : []
    const summarizeArgs = args.slice(0, 3)
    const config=lease?.config||engine.config
    const primaryRoute = cleanRoute({
      provider: config?.summarizationProvider,
      model: config?.summarizationModel,
    })
    const fallbackRoute = cleanRoute(lease?.fallback||engine.fallbackSummarizationRoute)

    const attempt = async (route) => {
      if (route) engine.summaryGuards.assertRoute(route)
      const receiver = route === null ? Object.create(engine) : Object.assign(Object.create(engine), {
        config: {
          ...config,
          summarizationProvider: route.provider,
          summarizationModel: route.model,
          modelPolicies: Array.isArray(config?.modelPolicies)
            ? config.modelPolicies.map((policy) => ({
                ...policy,
                summarizationProvider: route.provider,
                summarizationModel: route.model,
              }))
            : [],
        },
      })
      let result
      const modelContext=lease?.ctx||engine.summaryContext
      const ctx = modelContext && route?.provider === primaryRoute.provider ? modelContext : engine.ctx
      const input = summarizeArgs[0]
      const directive = SUMMARY_SYSTEM + '\n\n' + summaryInstructions({...metadata?.summaryTask,maxChars:null})
      Object.defineProperty(receiver, 'ctx', { value: summaryCallContext(ctx, summarizeArgs[1].session.id, route, { input, directive }) })
      try {
        result = await BasicCompactionEngine.prototype.summarize.call(receiver, ...summarizeArgs)
        if (result === null || typeof result !== 'object' || !Array.isArray(result.summary)) {
          throw new TypeError('BasicCompactionEngine.summarize() returned an invalid summary result')
        }
        checkedSummary(result.summary.filter(block=>block.type==='text').map(block=>block.text).join('\n'),{maxChars:null})
        if (route) engine.summaryGuards.succeededRoute(route)
      } catch (error) {
        if (route && !summarizeArgs[2]?.aborted) engine.summaryGuards.failedRoute(route, error, engine.rollingConfig.summaryRetryCooldownMs)
        throw error
      }
      return result
    }

    let result
    try {
      result = await attempt(routeIsConfigured(primaryRoute) ? primaryRoute : null)
    } catch (primaryError) {
      const signal = summarizeArgs[2]
      if (signal?.aborted || !routeIsConfigured(fallbackRoute)) throw primaryError
      engine.ctx.logger?.warn?.(
        `primary summarization route ${primaryRoute.provider}/${primaryRoute.model} failed; retrying once with fallback ${fallbackRoute.provider}/${fallbackRoute.model}`,
      )
      try {
        result = await attempt(fallbackRoute)
      } catch (fallbackError) {
        if (signal?.aborted) throw fallbackError
        throw new AggregateError(
          [primaryError, fallbackError],
          `primary and fallback summarization routes failed (${primaryRoute.provider}/${primaryRoute.model} -> ${fallbackRoute.provider}/${fallbackRoute.model})`,
        )
      }
    }

    // Native host owns the outer frame; put the consumer caution in the
    // returned body as well so its old established-background sentence cannot
    // make this historical snapshot look like a present user instruction.
    const summary = args[3] === undefined
      ? [{type:'text',text:`Historical snapshot, source records #${metadata.summaryTask.first}–#${metadata.summaryTask.last}. State applies at the end of that range, not the present day. ${RECALL_POLICY}`},...result.summary]
      : result.summary
    const nodeId = randomUUID()
    return {
      ...result,
      summary: appendRecallEnvelope(summary, { id: nodeId, children }),
    }
    } finally {lease?.release()}
}
