import z from '@deepseek-ai/schemastery'
import { ROLLING_DEFAULTS } from './engine-config.js'
  // dsh 0.1.7: 运行时可热更字段（原 installSection 的 settings 区）改为在 Config 上
  // 声明 volatile。Settings 表单直接读写本条目的 Config，变更经 loader 的
  // volatile 提交路径更新 fiber.config 并触发 loader/volatile-update。
  // 注意：必须用单层 z.object —— z.intersect 会把 volatile ref 按 key 拆散合并，
  // 丢失引用语义（实测 schemastery 3.18.3），所以这里平铺声明全部字段。
export const engineSchema = z.object({
    // —— 继承自 BasicCompactionEngine.Config 的字段（保持同形）——
    thresholdRatio: z.number(),
    headroomTokens: z.number().step(1).min(0),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(z.object({})),
    auto: z.boolean(),
    archiveHome: z.string().default(''),
    controlFile: z.string().default(''),
    summaryAdapter: z.any(),
    runtimeTuning: z.any(),
    // —— SuperLcm 自有字段，全部 volatile，可运行中热更 ——
    summarizationProvider: z.string().default('').volatile(),
    summarizationModel: z.string().default('').volatile(),
    fallbackSummarizationProvider: z.string().default('').volatile(),
    fallbackSummarizationModel: z.string().default('').volatile(),
    budgetMode: z.string().default(ROLLING_DEFAULTS.budgetMode).volatile(),
    prepareRatio:z.number().min(0.01).max(0.98).default(0.7).volatile(),
    switchRatio:z.number().min(0.02).max(0.99).default(0.8).volatile(),
    emergencyRatio:z.number().min(0.03).max(0.999).default(0.9).volatile(),
    mode: z.const('rolling').default(ROLLING_DEFAULTS.mode).volatile(),
    tailCount: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.tailCount).volatile(),
    minRetainTokens: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.minRetainTokens).volatile(),
    pressureFoldTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.pressureFoldTokens).volatile(),
    foldBatchTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.foldBatchTokens).volatile(),
    softActiveTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.softActiveTokens).volatile(),
    hardActiveTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(ROLLING_DEFAULTS.hardActiveTokens).volatile(),
    foldTiming: z.const('background').default(ROLLING_DEFAULTS.foldTiming).volatile(),
    summaryPrefixTargetTokens: z.number().step(1).min(0).default(ROLLING_DEFAULTS.summaryPrefixTargetTokens).volatile(),
    condensedMinFanout: z.number().step(1).min(2).default(ROLLING_DEFAULTS.condensedMinFanout).volatile(),
    summaryTimeoutMs: z.number().step(1).min(1000).default(ROLLING_DEFAULTS.summaryTimeoutMs).volatile(),
    summaryRetryCooldownMs: z.number().step(1).min(1000).default(ROLLING_DEFAULTS.summaryRetryCooldownMs).volatile(),
  })
