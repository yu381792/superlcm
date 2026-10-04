# LosslessClaw 设计评估：SuperLcm 应该借鉴什么

结论：LosslessClaw 的历史保存、摘要来源追踪和查证规则值得借鉴，但它不能保证压缩后模型的判断能力不变。对当前使用方式，我建议优先让 Codex 自己压缩，SuperLcm 保存原文、生成后台摘要、提供查询；DSH 的压缩接管暂不作为默认推荐。

本次是源码设计评估，没有安装上游插件、调用付费模型或修改现役模型、配置、服务。核查日期为 2026-10-04；上游包版本为 1.1.1，源码固定为 [e05d8d3](https://github.com/Martian-Engineering/lossless-claw/tree/e05d8d34b2a44fdef556ce95dd90115b46630200)。这与此前 DSH 优化文档引用的版本相同，本次重点补查摘要内容如何保真、每轮怎样组装上下文以及失败时的实际行为。SuperLcm 对照版本为 0.5.10、提交 9c889de。

## 1. 它的“无损”究竟指什么

LosslessClaw 不是只存摘要的旁路工具。它接入 OpenClaw 的上下文引擎，负责决定本次模型请求看见哪些原文、哪些摘要。数据库保存原始消息及结构化内容；摘要另存，并记录它来自哪些原文或下层摘要。模型当前看见的是另一份有序清单，清单中的旧原文可以被摘要替换，而数据库中的原文继续保留。见 [架构说明](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/docs/architecture.md) 与 [上下文组装实现](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/assembler.ts#L1492)。

这解决的是“原文以后还能找回来”，不是“摘要让模型知道的内容与原文完全一样”。模型没有主动查询时，遗漏的例外、否定条件、决定的适用范围仍然可能影响判断。我的评估是：可查回原文很有价值，但不能拿它代替压缩后的任务质量验证。

## 2. 摘要内容：最值得借鉴的差距

上游按摘要层级使用不同的写法。最底层保留决定、理由、约束和未完成事项；第一次合并明确要求交代旧决定被什么替代，并按时间顺序写变化；继续合并时突出仍然有效的决定和当前状态；更高层才逐步舍弃操作过程和不再相关的细节。摘要还带时间范围，并提示哪些细节需要展开原文查看。见 [分层摘要提示](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/summarize.ts#L1125)。

SuperLcm 当前 `dsh/draft-tree.js` 的合并提示要求保留决定、标识符、约束和未完成工作，但不同层级共用一条笼统提示；没有同等明确的“先前结论—后续修改—目前有效状态”要求。底层生成则调用 DSH 的 `BasicCompactionEngine.summarize`。因此，我们借鉴了后台分块和摘要树的结构，还不能称为完整复现了上游的内容策略。

例如，前面批准方案 A，后来因为证据变化改为 B。如果摘要只保留两段“决定”，未来模型可能把 A 和 B 当作同时有效。这里需要保存的是变更关系和理由，光把树引用连完整没有用。这个例子解释了可能的失真方式，尚不是对某个真实会话故障原因的定论。

我们自己的 Claude 接管也需要同样审慎：`src/summarize.js` 的后台生成和合并提示较通用，`src/compaction.js` 使用已有摘要替换旧内容，`hooks/compact-mod.js` 在边界不明确、摘要准备不足或调用失败时交回 Claude 原生压缩。Claude 那边体验较好，不能据此证明其摘要在所有任务中保真，也不能只凭界面层数相似就认定 DSH 等效。

## 3. 后台准备与正式替换

上游将尚未发布的摘要与正式上下文分开。发布时核对来源、顺序及内容指纹，即核对准备时的那段原文是否仍是当前这一段；通过后在一次数据库事务中替换并登记摘要，避免只写成功一半。已发布的结果重试时不会重复替换。见 [发布实现](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/pending-summary-publisher.ts#L87)。

不过，一次发布可以只使用从起点连续准备好的部分，后面没准备好的批次保留待处理。它不要求整轮计划中的所有块都齐了才一次大幅压下去。见 [准备与发布协调](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/pending-summary-coordinator.ts#L620) 和 [连续范围选择](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/pending-summary-planner.ts#L450)。

用户要求的“后台准备多块，到 260K 固定本轮范围，准备好一次提交”是更具体的策略。现有 DSH 实现已朝这个方向做了固定范围和一次提交，不能为了贴近 LosslessClaw 就反向改为分次发布；也不能用上游的发布设计为我们以前只压几万的情况开脱。

## 4. 缓存：它也不能保证没有压缩就没有变化

当前版本的自动压缩按上下文阈值触发；旧的缓存冷热参数继续接受，但已不参与自动压缩决定。缓存热不会推迟已达到阈值的工作。此前如果依据旧描述说它会等缓存冷却才压，应以当前实现更正。见 [现行阈值策略](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/docs/configuration.md#threshold-full-sweep-compaction)。

“每轮组装”也不等于“每轮重写摘要”。有序清单不变、预算足够时，组装可以稳定输出同一段旧内容。但预算不足时，上游允许从本次请求中移除较旧的内容；可选的按问题相关性选择内容默认关闭，启用后保留项更可能随问题改变。另有自动查找特定标识符的原文提示，在满足条件且预算允许时插到请求开头。这些都是正式摘要替换之外可能改变请求前部的路径。见 [预算选择](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/assembler.ts#L1579)、[原文提示插入](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/engine.ts#L5020)。

因此，照搬它也不会自动保证“没压缩时缓存一直稳定”。这是对上游路径的设计判断，不是说我们的 DSH 当时执行了这些路径。要定位 DSH 的缓存突降，仍要比较连续两次实际发送的消息，从第一个不同的位置找原因，再对照供应商实际缓存量，不能只看压缩事件或界面的估算数。

上游记录请求内容摘要值、共同前段长度、第一个变化位置、选择方式和保留原文成本，这类诊断比无限值守更值得借鉴。见 [组装诊断](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/engine.ts#L5180)。

## 5. 查回原文：不仅是有几个工具

LosslessClaw 除了搜索和展开原文，还给任务模型一套固定查证规则：新证据优先于旧摘要；结论冲突时先查；精确命令、路径、配置值和因果关系要展开来源；默认先查当前会话，再按需要查其他会话。深度查询可交给范围受限的子智能体处理。见 [查证规则](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/plugin/index.ts#L345) 与 [展开权限规则](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/expansion-policy.ts)。

这一点很适合 SuperLcm：摘要是找资料的目录，回答精确问题要回原文。不过，模型仍可能不知道自己漏了什么；有搜索工具不能保证每次都正确调用。我们需要检查真实任务是否会查证，而不只检查工具调用成功。

## 6. 失败处理与语义风险

上游对空回答、混入推理文本、超时等情况做重试和清洗；一些失败路径最终返回带标记的截断文本，维持上下文管理可继续运行。授权、运行范围及费用限制等错误另有阻断处理，不能笼统说所有错误都会截断。见 [生成及重试](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/summarize.ts#L1880) 与 [截断兜底](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/summary-fallback.ts)。

我的判断是，复杂研究任务不宜默认把截断结果当作合格摘要投入主上下文。完整原文仍在，但关键限制可能已经不在模型眼前。上游的高层摘要也有意逐步删掉过程细节；对普通长期对话合理，对依赖精确条件、反例和阶段裁决的研究任务则需要更谨慎。

摘要模型与任务模型不同是上游支持的配置，本身不是设计错误。真正要验证的是它是否准确保存了决定及其适用范围；使用同一个模型也不能免除这项验证。见 [模型配置实现](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/db/config.ts#L748)。

## 7. 对 SuperLcm 的取舍

| 设计点 | 评估与建议 |
|---|---|
| 原文保留、来源可追踪 | 保留并加强。它支撑查证和错误恢复。 |
| 时间顺序、决定如何被替代 | 优先借鉴。现有通用合并提示不足以证明这方面可靠。 |
| 近期原文和完整工具边界 | 保留。防止正在执行的工作只剩粗摘要。 |
| 固定范围、后台准备、正式提交分开 | 保留现有 DSH 的用户目标，不照搬上游分段发布。 |
| 每轮按预算删除或按问题换旧内容 | 不作为当前默认推荐，先证明必要性和真实请求稳定性。 |
| 失败后截断仍继续压缩 | 对复杂任务不推荐默认采用。失败要能识别，不能伪装为正常摘要。 |
| Codex 原生压缩加 SuperLcm 查证 | 当前首选。减少 SuperLcm 对任务主上下文的干预。 |

评估状态为“警告”：结构设计有明确优点，复杂任务压缩后的理解质量仍未验收。本次抽查的上游测试覆盖压缩范围、发布、组装、工具关系及失败处理，其中部分使用模拟摘要；没有找到可以直接证明我们这类长研究任务压缩后判断不变的实测。参考 [压缩集成测试](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/test/lcm-integration-compaction.test.ts)。这不是断言上游从未进行质量实验。

以后若重新启用 DSH 接管，应做一次有明确结束条件的任务质量对照：相同会话分别使用原文、宿主原生压缩和插件摘要，核对当前有效决定、已经撤销的方案、关键例外、尚未解决的问题，以及是否会回查证据。不能再用“树完整、缓存恢复、测试全绿”替代这项验收，也不靠无限观察来宣称稳定。

本次交付只有评估文档；没有重新启用 DSH、替换压缩引擎或启动会话观察。
