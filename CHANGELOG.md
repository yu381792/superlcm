# Changelog

## 0.5.25

- Proactive audit: require an actual successful terminal event for DSH summary streams; reject missing/unknown/truncated/aborted/duplicate endings, tool output and output after completion before any checkpoint commit. Invalidate uncommitted drafts from the prior policy.
- Keep tool requests and all matched results, including failed/parallel results, in the same background summary segment. Honor labeled user language in plain-text imports.
- Persist failed-batch cooldown across workers; progressively back off and pause after three failed automatic runs. Configuration changes or explicit generation permit retry; indexing alone does not clear an unresolved error.
- Bound Claude/Codex/Hermes/Pi CLI writers even when subprocesses ignore SIGTERM; fail immediately and escalate termination after a short grace period.
- Add a single release verification command covering regressions, real DSH runtime, unpacked npm CLI/MCP, package import closure and paired core checks. Use synthetic data/local model fixtures; no paid calls or production configuration changes.


## 0.5.24

- 修复摘要语言跟随真实用户消息，避免工具、注入和旧摘要改变语言。
- 修复长原文指令带跑摘要，在源内容后重申任务并检查全部节标题和输出语言。
- API 与 DSH 质量失败最多补试一次，原文与设置保持不变。


## 0.5.23

- Align DSH historical reads with the standalone adapter: preserve all frames, originals and overlapping source sequences without rewriting host logs.
- Shared archive recall uses explicit physical positions; old logs are excluded from summary generation and compaction reconstruction. Source bytes, header identity and already archived prefixes are verified before indexing.
- Read accepted live originals before pending persistence writes, and accept only missing header defaults across storage versions.
- Keep normal Claude, Codex, Hermes and Pi capture and current DSH compression settings unchanged.

## 0.5.22

- 修复思考模型把摘要输出额度耗在隐藏推理上的问题：可见输出按原文语言密度估算；有实际推理证据且被截断时最多补额重试一次，按端点、模型和思考程度保存所需额度，失败显示推理及总输出用量。
- 完整超长摘要最多缩短重写两次，无进展提前停手；仍超长时生成带来源和醒目标记的有限导航摘要。原文完整保留，降级标记向上合并继承，Claude 接管遇到降级摘要仍回退原生方式，避免裁掉的约束被当作已保留。
- API、独立 CLI 和 Claude 宿主后台写摘要均检查完成证据。缺失终止状态、空回答或未完成输出拒绝入库；CLI 修复、API 补额及参数协商前核实配置和写入权，取消后不会继续追加请求。
- Claude 接管拒绝、运行异常及成功记录可在会话后台和 `doctor-local` 查询，显示原因、时刻和覆盖位置；关闭接管后不再保留旧成功状态。安全诊断不回显上游正文、凭证或任意模型元数据。

## 0.5.21

- 修复 Claude 可选压缩接管把工具空消息两侧的同一边界误判为多个位置的问题，真实重复对话仍安全回退到原生压缩。
- 原生压缩摘要用归档记录中的 `isCompactSummary` 标记核实，不再占用最近两次真实用户提问的保留名额，引用同样开头的普通消息仍保留。
- 自定义 OpenAI 兼容摘要接口支持流式响应；损坏、截断或未完成的结果拒绝入库。后台显示安全的失败原因、模型和结束状态，原文和凭证不写入错误详情。

## 0.5.20

- DSH 压缩页面沿用 Claude Code 的预设和自定义输入样式，只显示一个「压缩比例」，默认 80%。后台自动安排提前准备和安全等待，用户无需设置三个门槛。
- 自定义比例保存后读回原值，按当前聊天模型容量计算。既有模型、原生压缩和接管开关保留。未接管时隐藏 Claude 和 DSH 顶部的压缩状态标记，DSH 分块的预设和自定义界面也与 Claude 保持一致。

## 0.5.19

- DSH 接管的摘要收口、上下文替换和安全等待比例可分别设置，默认 70%、80%、90%。门槛按当前聊天模型扣除输出预留后的输入容量计算，较早替换时同步缩小原文保留及摘要预算。
- 独立后台摘要按原文粒度分块。同层合并同时满足至少四段和内容量门槛，默认至少约 2K 摘要正文，短段等待更多相邻摘要，完整合并输入限于配置粒度。
- 合并超过预算时寻找可容纳的相邻组，保留完整子摘要及来源引用。后台调用次数显示上限，少量短摘要不再误报为待合并任务。

## 0.5.18

- DSH 可选压缩接管按本次聊天模型可用输入容量计算门槛：70% 收紧草稿预算，80% 固定范围并在就绪后一次提交，90% 留安全等待空间。
- 普通界面只需调整摘要粒度，默认 20K。近期原文和旧新摘要共用的预算自动适配模型，保留完整最新用户轮次和工具边界。
- 草稿单独持久化，恢复和提交都核对原始事件内容。无进展摘要调用按输入、目标和路由记住，避免冷却或重启后重复付费。
- 在宿主完成新输入入库与路由解析后核最终请求。上下文替换后先由宿主重建请求，旧冻结请求不会发送给模型。默认接入仍使用原生压缩。

## 0.5.17

- 会话名称同步宿主正式标题：补读 Claude 独立改名文件和 Paseo 保存的会话名称，按载体与原会话编号准确匹配。
- 打开后台列表、详情或搜索时刷新名称，改名后无需再发送消息；导入后的正式标题保留正确来源，后台手动改名仍优先。
- 为标题记录增加轻量索引，避免每次刷新扫描整个长对话。

## 0.5.16

- 导航新增独立「压缩」页面，位于接入与设置之间；Claude Code 和 dsh harness 分页设置，旧设置入口链接继续可用。
- DSH 插件仅显示「后台设置」入口，直接打开 SuperLcm 的 DSH 压缩页；后台地址使用实际监听端口或显式公共地址，不携带 DSH 登录参数。
- DSH 保留显式可选接管，默认仍只归档和后台摘要。首次启用备份并验证配置、保留聊天模型及各启动方式原生政策；关闭接管恢复原生政策，读取损坏设置时仍保留原生保护。
- 压缩开关保存和运行应用分开显示；关闭切换也须等待运行时确认，不再提前显示原生压缩已生效。后台摘要的 20K token 粒度与模型设置保持独立。

## 0.5.15

- 底层摘要原文目标改为 20,000 个估算 token，借鉴 Lossless Claw 的中英文与符号权重；后台和 DSH 插件显示相同单位，已有字符设置兼容保留。
- 分块计入原文标记，不再因为仅有数百条短消息提前生成小段；超长单条保留首尾和原文查询位置，不改动完整档案。
- 修复 DSH 摘要模式被状态刷新误判为待加载的问题；前后端共用运行判定，并拒绝把未卸载的旧接管组件显示为摘要模式。

## 0.5.14

- 所有默认接入统一为归档、后台摘要和查询，压缩由宿主自身负责；更新 Claude 接入会关闭接管并恢复宿主先前窗口设置。
- DSH 默认接入不再托管压缩服务，不需要选择压缩模型；迁移和取消接入都会核实原生压缩存在、聊天模型未变化。后台摘要使用接入卡片或 DSH SuperLcm 插件里选择的自定义 API。
- 管理接入新增取消接入，逐工具撤销 SuperLcm 入口、备份配置并保留全部档案；持久开关和任务 revision 阻止缓存钩子及迟到摘要继续写入。
- DSH 摘要输入保留完整消息、工具请求、调用 ID 和失败状态；独立摘要树按准确来源记录补齐旧摘要空洞，导入和启动追溯不触发模型。
- 默认摘要粒度从 12,000 提高到 48,000 字符，保持每 4 段合并；已保存的粒度设置保留，用户可在设置中修改。
- 取消、关闭和改粒度会停止当前摘要批次，提交前在数据库事务内核对设置和租约。

## 0.5.13

- 补齐 MCP 2026-07-28 工具列表和服务发现的必需缓存字段，修复新版 Claude Code 连接成功但工具列表校验失败；旧版协议响应保持兼容。
- 修复 DSH 关闭 SuperLcm 接管后两种自动压缩都停用的问题：关闭时加载真正的 DSH 原生压缩，使用当前会话模型和原生压力策略，同时继续归档。
- 原生自动压缩、溢出恢复及手动压缩共享唯一服务；切换取消旧任务，保留工具边界与原始记录，迟到摘要不再落入上下文。
- 接管启动失败保留原生保护，失败设置不报已应用、不重置溢出重试限制；界面明确区分接管参数与原生策略。

## 0.5.12

- 补齐 Codex `custom_tool_call` 与 `custom_tool_call_output` 的摘要原文投影，保留调用身份、字面输入、失败结果和时间；避免原文已归档但这些证据未进入摘要输入。
- 增加完整导入到叶摘要工作项的回归验证；历史摘要不自动重算，Codex 原生压缩行为不变。

## 0.5.11

- 所有后台摘要与 Claude/DSH 压缩摘要共享分层语义规则：保留状态时间、决策变更及原因、授权范围、失败与未完成事项；摘要消费时按原文查证冲突和精确细节。
- 叶摘要读取校验后的原始消息、工具调用和工具结果，保留时间与正文空白；不再从搜索预览生成摘要而遗漏失败证据。
- 合并传入完整子摘要，超过限制或模型输出截断、超长时拒绝保存，保留原文；摘要任务绑定政策版本及子摘要正文。
- DSH 原生压缩入口从真实会话来源推导层级及子节点；恢复树合并预算提示，历史摘要拼接带顺序和查回节点身份，透明包装仍不升层。
- 新规则仅作用于后续生成摘要；不自动重写旧摘要、不切换模型、不重新启用压缩接管。

## 0.5.10

- 修正 DSH 摘要层级：拼接包装不升层，旧包装按内容证明透明展开；同层摘要按组真实概括后才升层，预算压力下仍保留真实合并和一次阈值替换。
- 区分逻辑摘要森林与实际上下文选区，拆旧包装后不重复计算物理来源；已提交树可重建并验证全部旧摘要成员。
- 后台按真实对话消息统计覆盖，不再把系统与运行事件误报成数千条未摘要；高层范围递归追溯原文，保留历史摘要和原始编号。
- 修复 DSH 读取旧会话头补默认 delegationDepth=0 后归档误判身份变更的问题，恢复同一会话的后续原文、原有摘要和标题收录。

- 修复 Codex 大型 `compacted` 记录超过 4 MiB 后阻断后续归档、消息提交和结束钩子报错的问题；共享读取上限调整为 32 MiB，按分块累积完整记录，避免反复复制，并保留完整原文及校验。

## 0.5.9

- 修复 Claude 重复消息和已压缩前缀导致摘要边界误认的问题；无法确定唯一边界时保留上下文，交回 Claude 压缩。
- Hermes 镜像追加后若数据库提交失败，重试会验证并收录已写入的完整尾部，避免重复追加；不完整尾部保留并告警。
- 自动摘要请求期间持续续期，并在保存事务中检查任务归属；关闭摘要或修改模型后停止旧任务的后续批次和保存，避免重复调用及迟到结果。
- DSH 归档进程失败后明确显示异常，退避重启并确认可用后补录；原生查询工具共享配置的档案目录。
- DSH 设置更新取消旧草稿；正常摘要树检查包含内部节点，重建按一次快照查找来源，减少长会话阻塞。
- 关闭 DSH 通用摘要生成入口，保证只有压缩插件生成摘要；统一发行版本，限制已保存的 API 密钥只用于对应地址。

## 0.5.8

- 固定压缩范围的最后一批即使低于常规最小批量也会完成，避免多保留数万原文；连空检查点都装不下的极小尾段明确留作原文，不购买必然无法缩短的摘要或阻止已准备草稿提交。
- DSH 后台摘要按层级升层；旧摘要和新摘要共用总预算，主上下文采用覆盖选区的高层摘要，原文和低层摘要完整保留。
- 达到压缩门槛时固定本轮选区，修复后台不断追赶新内容、压缩拖至硬上限的问题；一次提交同时替换旧摘要与新原文。
- 摘要树随已提交压缩记录保存，可从 DSH 原始记录重建并跨工具逐层查阅；未提交草稿不进入共享摘要目录。

## 0.5.7

- 修复预设里的默认压缩绕过全局接管：迁移已有预设为继承 SuperLcm，停用独立工具输出裁剪，并将预设冲突纳入接入检查。
- DSH 后台分批准备摘要，达到门槛后一次替换完整选区；近期原文按真实用量校准预算，减少小幅压缩反复重建缓存。
- 为后台摘要建立独立会话标识，修复主对话与摘要请求共用代理推理状态、未提交压缩也可能减少输入并丢缓存的问题。
- DSH 接入统一为一个 SuperLcm 组件，内部管理压缩、归档与设置；通过包名加载，迁移旧入口，支持新用户目录和之后新增的启动配置。

## 0.5.6

- 接续窗口先读取最新工具接入状态，避免页面刚打开时误报已接入工具不支持接续。

- 修复长会话积累后列表切换变慢：先分页再读取统计，消息数量实时维护，已有名称不重复读取原文，快速切换时只显示最新选择；后台检查 Hermes 改为异步，避免阻塞其他页面请求。

- 新增 dsh harness 历史会话导入：读取本机压缩记录，保留工具记录和已有可验证摘要，重复导入自动去重。

- 统一五种工具的接入卡片为「管理接入」，在同一管理窗口中查看状态、检查和安装或更新接入。

- 在 DSH 的「插件 → SuperLcm」提供与 Claude 风格一致的压缩设置，继承已有模型和参数；统一品牌名称、图标及全局设置，停用插件时暂停自动压缩。
- 将「设置 → 压缩」恢复为仅包含原有 Claude Code 设置，撤回 DSH 控件、载体能力列表和后台任务展示；保留 DSH 接入与已保存的压缩设置。

## 0.5.5

- 将 dsh harness 明确标为由 SuperLcm 插件接管压缩，统一界面、文档和能力描述。
- 在「设置 → 压缩」管理 DSH 压缩开关、模型、门槛、原文保留量及比例、近期消息和高级参数；运行中自动应用，不要求手改配置。
- 所有启动方式共用同一份设置，后台回报实际应用的版本；切换模型或关闭压缩会取消旧任务，迟到摘要不提交。

## 0.5.4

- dsh harness 改为全局接入一次，现有和之后新增的启动方式共用压缩及会话档案，界面不再暴露内部启动配置选择。
- 从 DSH 当前已配置的原生适配器和模型目录读取供应商、模型，以联动下拉列表选择；首次安装不依赖旧压缩插件。
- 所选模型通过 DSH 的独立原生模型作用域执行压缩，保留各处聊天模型及账号设置；迁移旧接入时备份并停用旧入口，保留原始数据。

## 0.5.3

- DSH 使用正式图标，控制台提供完整接入向导：选择界面、预览模型、安装并启用原生压缩，更新可重复执行。
- 接入使用发行包的本地副本及 DSH 已安装依赖，通过 DSH 配置写入接口保存；先备份，配置验证失败时恢复。自定义会话库也能准确共享。
- 补齐命令行接入、可分发安装包和手动构建流程，移除 npm 私有包发布限制。页面与后台版本不一致时明确提示重启，避免把 DSH 误标为仅导入。

## 0.5.2

- 控制台加入 DSH 卡片和各载体的压缩能力说明，明确区分压缩接管与仅摘要/接续。DSH 使用原生压缩引擎，同一档案保留原文及已提交摘要。
- DSH 引擎和归档插件回报运行状态；后台显示生成中、等待替换、替换完成、取消与失败。配置、插件版本、进程和近期状态必须一致，才显示已启用；未加载的配置单独标出。
- DSH 不再展示通用摘要模型选择，接口也拒绝为它另配第二个摘要写入器。调整 SQLite 初始化顺序，先设置锁等待，再启用共享数据库的写入模式。

## 0.5.1

- 对照 Lossless Claw 优化 DSH 的长期会话压缩：旧摘要超过预算时，优先把连续同层摘要合成高一层，保留原摘要及完整原文引用；平时维持前缀稳定。
- 后台任务按会话互斥，两个智能体共用同一会话时不会重复生成摘要。账户认证失败暂停该模型路线，显式备用模型仍可使用；其他失败逐步延后重试。
- 后台摘要超时会请求取消，取消未完成时继续占用原任务位置，避免并发追加调用。无有效缩减和已失效的选区继续拒绝提交。

## 0.5.0

- DSH 接入同一套 SuperLcm：原异步压缩引擎作为可选插件迁入，原文和已提交摘要进入共享档案，可与 Claude Code、Codex 双向接续。
- DSH 只使用原压缩引擎生成摘要，归档不会重复调用模型。旧索引只读迁移，保留原库；补录和事件采集在本机后台完成。

## 0.4.23

- Fixed: the compaction notice in 0.4.22 used Claude Code's own after-compaction count, which leaves out the system prompt, tools and rule files every request carries (a real 136K compaction showed 42K while the context still held about 136K). The notice now shows SuperLcm's estimate of the whole context again.

## 0.4.22

- New: after a compaction the conversation shows one line for the user, worded like Claude Code's own: `Conversation compacted · by SuperLcm · 136K → 42K · 19,243 original records kept as #df671` (or `by Claude Code` when SuperLcm handed it back). The sizes are Claude Code's own counts when it has written them, otherwise SuperLcm's estimate. The line follows Claude Desktop's interface language (English in the terminal; `SUPERLCM_UI_LOCALE` overrides).
- Fixed: after its own takeover SuperLcm sometimes still added the retrieval note meant for Claude Code's compaction, because the hook could run before the packet was written to the transcript. The takeover is now recorded when the packet is handed over.

## 0.4.21

- Fixed: the compaction takeover still handed long tool-heavy conversations back to Claude Code's own 70–100 s summary. Two causes, both seen on a real conversation run through Paseo: (1) a stretch of mostly tool calls filled the window while its dialogue stayed under one summary segment, so no summary covered it; the planner now carries such dialogue (up to 40000 characters) into the packet word for word, tool output left to lcm_read, after checking that the conversation in context matches the record. (2) Keeping the newest 40k tokens extended back to the start of a turn even when that turn was one 190k-token task; the planner now keeps less instead of pulling in more than twice its target. On the real 23:26 compaction the plan is now to take over.

## 0.4.20

- Fixed: Hermes showed as not connected, and Connect refused with “找不到 Hermes 自带的 Python”, on Hermes installs whose `~/.local/bin/hermes` launcher execs the entry script without quotes (written that way since late September). The launcher is now read quoted or bare, so Hermes' own Python and config code are found again; an existing SuperLcm setup is recognized as connected.

## 0.4.19

- Fixed: the compaction takeover gave up on conversations in the desktop app whenever the summaries ended on a title record (the app writes one every turn) and a message repeats (such as a recurring heartbeat prompt). The planner looked for the title in the live conversation, could not find it, then matched the first, hours-old copy of the repeated message, judged the summaries far behind ("about 283812 tokens would remain") and handed the compaction to Claude Code's own 70–90 s summary. Only messages are now used to place the summaries, and a repeated message is placed by the messages after it. On the real 21:12 compaction of a long conversation the plan is now to take over.

## 0.4.18

- Relicensed from AGPL-3.0-only to MIT; the contributor license agreement is no longer needed.

## 0.4.17

Fixes from the second review of 0.4.14–0.4.15.

- Turning the takeover off from the console with sizes an older version allowed (say 60K) no longer restores Claude Code's settings while the takeover stays on; the console sends the stored sizes back, and those are now brought inside the limits too. A failed turn-on of such an old setting rolls back to off instead of failing the rollback.
- The compaction start accounts for a lower `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (Claude Code keeps min(output cap, 20K) for output), and the percentage is raised where floating point would land a token short, so the start is never below the chosen size.
- A packet Claude Code prepared ahead of time is swapped in with the messages written since appended after its kept ones; those copies are no longer indexed and summarized a second time.
- The console's history list accepts transcripts up to 4 GiB as well (it still said 256 MiB).

## 0.4.16

- In-conversation summaries (本工具后台写 with the plugin) now work through the whole waiting backlog in one background run instead of 8 pieces per turn, so a long conversation that was never summarized catches up within the hour rather than over dozens of turns. Turns never wait for it.

## 0.4.15

- A conversation's transcript may now be up to 4 GiB (was 256 MiB). It is read in 64 KiB pieces, so the size costs disk for the private copy, not memory (a 563 MB transcript indexes in about 17 s). Before, a longer Claude Code conversation was skipped without a word: nothing recorded, no summaries, so the compaction takeover always fell back to Claude Code's own summary there. A transcript over the cap is now marked `too-large`.

## 0.4.14

- Fixed: the module no longer starts a compaction itself (added in 0.4.10). On a plugin's own `$.session.compact()` Claude Code 2.1.287 skips that plugin's hooks, so a compaction started there was always Claude Code's own summary, never SuperLcm's (checked on a live session; found in review). Instead, turning the takeover on now also sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` so that Claude Code itself starts compacting right at the console's size (window 100K above it, the start at the size), where the module answers with the summaries. When they lag, Claude Code summarizes at that size the usual way.
- Turning the takeover off after an older version turned it on no longer drops a setting that version never touched (the env window for 0.4.7 and earlier, the percentage for 0.4.8–0.4.13).
- A size an older version allowed (below 100K, or kept under 5K) no longer makes turning the takeover off fail halfway with Claude's settings restored but the takeover still shown as on.

## 0.4.13

- Console › Settings › Compaction: the threshold and the recent originals kept each take a custom size besides the presets (threshold 100K–950K, kept 5K–200K).
- Claude Code's own window (the threshold plus 100K) is capped at 1M, Claude Code's own ceiling, so 300K, 500K and 800K on a 1M model become 400K, 600K and 900K. On a model whose window leaves no room above the threshold, the plugin now starts 50K below that window (never below half of it) instead of never reaching the threshold.

## 0.4.12

- Claude Code's own compaction window is now set 100K above the console's size (300K → 400K) instead of to the same value. Claude Code starts its own compaction a little before its window, so with both at 300K it compacted at about 270K, ahead of the plugin; now the plugin swaps in the summaries at 300K and Claude Code compacts only as a fallback when they lag.

## 0.4.11

- Turning the takeover off now restores your own `CLAUDE_CODE_AUTO_COMPACT_WINDOW` even when the takeover was first turned on by 0.4.7 or earlier (which remembered only `autoCompactWindow`); before, that value was dropped instead of restored.

## 0.4.10

- The plugin module starts the compaction itself: after a turn, once the context reaches the window set in the console (300K by default) and the summaries are ready, it compacts with SuperLcm's packet between turns. The console's size now holds wherever the module runs, whatever the host reads from settings.json; while the summaries lag it starts nothing and Claude Code's own threshold still applies.

## 0.4.9

- Compaction takeover now also answers Claude Code's precompute (2.1.286 prepares the compaction in the background and swaps it in at the threshold without asking again). Before, the module let every precompute through, so Claude Code's own summary was what got swapped in and the takeover never ran on desktop sessions.

## 0.4.8

- The Claude desktop app does not pass `autoCompactWindow` to the Claude Code it runs, so its sessions kept compacting at the model default (about 367K) and the takeover's size had no effect there. Turning the takeover on now also sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` under `env` in Claude's settings.json, which every Claude Code reads first; turning it off restores the earlier value. Takes effect for sessions started or resumed afterwards.

## 0.4.7

Fixes from an independent review (GPT-6.1 sol), each with a regression test:

- Compaction takeover: a run of messages repeated later in the conversation could place the cut at the later copy and drop the uncovered messages between; the cut is now also checked against the first uncovered record after it. An unfinished first turn that no summary covers is no longer dropped (the compaction goes back to Claude Code).
- A `<superlcm-context …>` block pasted into a prompt was taken for a compaction packet and hid that message and the next ones from the index; only the first message after Claude Code's compact boundary is treated as a packet now.
- Summary leases have an owner: a refused save or a handoff from the conversation no longer releases a background worker's lease, and a refused save hands the rest back to that worker instead of retrying silently.
- Hermes: reconnecting after Node moved replaced nothing and added a second capture hook; the older SuperLcm hook is replaced now. Two captures at the same moment could store the same messages twice; the mirror is now appended under a write lock.
- Codex: hook trust was not found when the hooks point at the plugin's fixed entry (`~/.superlcm-claude/superlcm.js`).
- A message longer than 16,000 characters was cut in the index without a mark; the cut now says how much more there is and that `lcm_read` has the full record.
- Turning the takeover on when Claude's settings.json cannot be written leaves it off instead of on in name only, and the settings are read again right before they are written.

## 0.4.6

- README: a full Claude Code section leads the page, with a new compaction-takeover animation (`docs/images/takeover-*.gif`, source in `scripts/demos/`), what the plugin brings, which Claude Code versions run the module, and a measured swap.
- The in-conversation summary note now says plainly that it comes from the plugin the user installed and the mode the user chose, so models do not read it as an injection.
- After a compaction SuperLcm itself answered, the SessionStart retrieval note is left out (the packet already says where the originals are).

## 0.4.5

- Compaction takeover keeps the newest stretch word for word (Settings › Compaction › Keep recent originals: 20K, 40K by default, or 80K tokens, at most half the context), from the start of a turn, even where summaries already cover it; only older parts become summaries.

## 0.4.4

- The plugin module (compaction takeover and in-conversation summaries) is marked as supported from Claude Code 2.1.286, the version the Claude desktop app now bundles; checked with a real run of its bundled binary.

## 0.4.3

- 本工具后台写 for Claude Code runs inside Claude Code itself when the plugin is loaded on 2.1.287+: after each turn the plugin module writes the waiting summary pieces with `$.model.complete` on the session's own login (the turn does not wait), instead of starting a separate `claude -p`. New CLI commands `summary-host`, `summary-claim`, `summary-save` and `summary-handoff` carry it; the Stop hook skips its worker while a session writes its own, and at session end, or after a failed model call, the rest goes back to the `claude -p` worker.

## 0.4.2

- The README and the plugin listing lead with the compaction takeover: summaries assembled in the background, a no-wait swap at the threshold, originals kept, and Haiku able to write the summaries.

## 0.4.1

- The Claude Code card treats the plugin as the connection: it shows the plugin version, installs or updates it through `claude plugin`, says whether the terminal and desktop-app Claude Code can run the compaction module, and cleans up the older MCP entry and settings.json hooks (backed up first, other hooks untouched).
- Settings › Compaction is a switch and a threshold choice that apply at once, with a checklist of what the takeover needs (plugin, Claude Code version, summaries, compaction window).

## 0.4.0

- 接管压缩 (Settings › Compaction, off by default): a Claude Code module (`hooks/compact-mod.js`, Claude Code 2.1.287+) answers the main conversation's compaction the lossless-claw way. The level-0 summaries that chain from the first record are replaced by the fewest layered summaries that cover them, everything newer (and at least the last two prompts) stays word for word, and no model is called. A summary gap, an unplaceable cut, a kept part over 60% of the window, a subagent or Claude Code's own precompute all hand the compaction back to Claude Code. Turning it on sets Claude Code's `autoCompactWindow` (300K by default) and remembers the earlier value; turning it off restores it. The console warns when the Claude plugin is not enabled.
- A SuperLcm compaction packet, and the kept messages Claude Code writes again after it, are archived but not indexed or summarized twice.

## 0.3.0

- Custom API models are added once in Settings (name, protocol, endpoint, model ID, reasoning effort, key) and picked on any tool's card; there is no global summary method any more. Editing a model applies to every tool using it, a model in use cannot be deleted, and the same endpoint reuses a saved key. Existing custom API settings become added models with their keys.
- Saving a model makes one real test call and shows the provider's own error, with 仍然保存 to save anyway. Reasoning effort is sent as OpenAI `reasoning_effort` or an Anthropic thinking budget. Base URLs are completed the way the official SDKs do, `localhost` counts as local, API model IDs may use characters such as `@`, and a reasoning model that refuses `max_tokens` is retried with `max_completion_tokens`.
- Hermes' card lists the models Hermes offers for its provider (default first) instead of only the configured default.
- Tool cards show when a conversation was last saved (the old line only counted the AI calling SuperLcm's tools), put the model choice on its own row, and no longer show CLI versions; the early-records filter is gone. Saving a card choice answers at once (settings no longer re-detect every tool).

## 0.2.0-alpha.1

- Open the console from your own Tailscale devices (`tailscale serve`, tailnet only): `SUPERLCM_WEB_REMOTE_HOSTS` and `SUPERLCM_WEB_TAILSCALE_USERS` (`*` or specific logins); Funnel traffic is always refused.
- Custom API accepts a local gateway on this computer without an API key (no authorization header is sent).
- A tool card shows 没在存 when Codex or Claude Code wrote a conversation after SuperLcm's hooks last ran (for example Codex waiting for re-approval after reconnecting), instead of still saying 已接入.
- MCP tools now declare what they do (read-only lookups; summary tools that write only SuperLcm's own summaries; nothing destructive or networked). Codex no longer asks for approval before each SuperLcm call, which in non-interactive runs made every lookup fail. The Codex hook-trust check counts only SuperLcm's exact hook command.
- Three ways to write summaries: 对话模型生成 (now also the default on a fresh install; before, an unsaved setting fell back to the Claude CLI), 本工具后台写 and 自定义 API. 本工具后台写 replaces Claude 订阅 / Codex 订阅: a conversation is summarized by a background run of its own tool, now including Hermes (`hermes chat --source tool`) and Pi (`pi -p --no-session`), with the account, provider and model configured in that tool (Claude and Codex runs no longer strip provider settings or ignore the Codex config). Each tool card picks the model from that tool's own list. Background runs are never captured as conversations: Hermes and Pi hooks now also skip them. Older settings are converted once when the index opens.
- 接入 can approve SuperLcm's own hooks for you (a checkbox, on by default) through each tool's official mechanism: Codex's app-server `config/batchWrite` of `hooks.state` trusted hashes, and Hermes' documented shell-hook allowlist. No terminal step is needed. Fix Codex trust detection, which never recognized the single-quoted hook commands written on macOS/Linux and so always reported 还差一步.
- Support the new Hermes layout (0.21.5+, no venv: its Python is found through `hermes --print-runtime-command`). Launch SuperLcm with a node that no AI tool bundles, so a tool update cannot break it; cards show 需更新 when an older connection should be refreshed, and connecting again updates SuperLcm's own MCP entry and hooks in place.
- Size summary segments by characters only and send every record whole; previously input was cut at 22,000 characters (so 24,000-character segments lost their end) and each message at 2,400. A record longer than a whole segment gets its own segment with head and tail kept. The 单段最多消息数 setting is gone (a hidden 200-message cap remains), and the CLI summary timeout is 180 s.
- 对话模型生成 is the default for every tool: when a piece is ready, a short note asks the conversation's own AI to write it from memory (`lcm_summary_task` with `recent:true` returns only where the piece starts and ends), so nothing is re-sent. Pieces from before the tool last compacted the conversation come with their text. Hermes (`pre_llm_call` hook) and Pi (`before_agent_start`) now get the same note; compactions are recorded from Claude/Codex `PostCompact`, Hermes continuation sessions and Pi `session_compact`. The lag notice counts pending summary calls instead of records.
- Hermes and Pi connect automatically: 接入 registers SuperLcm's MCP tools and capture hooks (Hermes through its own config code; Pi as one extension file), checks that they load, and for Hermes opens a terminal so its hook approval prompt appears. Hermes messages are kept in SuperLcm's own append-only copy, with compression chains joined into one conversation; Pi session files are indexed byte for byte. The Codex setup dialog reads whether its hooks are trusted and can open Codex for the review.
- Delete a conversation from its list row or detail page, or clean up old conversations by tool and last activity under 设置 › 存储; deleted conversations are not recaptured by hooks. 接续到其他工具 is now 换个工具继续.
- The console lives at a fixed address, `http://127.0.0.1:8791/`, with no login token; Host, Origin and JSON-only writes still block other web pages.
- A single 生成摘要 / 补齐摘要 button opens a confirmation that shows how many records and model calls a background pass takes, and offers only methods this computer can run (installed Claude/Codex CLI, saved custom API), each labelled with whose quota or bill it uses; `summarize --backend api` runs a one-off pass with the saved custom API.
- Keep a private byte-for-byte archive of every indexed record under `originals/`, so originals survive the host moving or deleting its transcript; `node src/cli.js archive` backfills existing conversations and recovers Codex rollouts moved into `archived_sessions/`.
- Chinese and English interface, following the browser language with a switch in Settings; a test checks every Chinese string has an English translation.
- Redesign the console into three views: 对话 (list, search, summary-level strip, summary tree, original-record drawer, continue-in-another-tool, rename), 接入 (evidence-based status, guided setup dialog, local import, per-tool summary writer) and 设置 (appearance, storage, summary writer, granularity, MCP tool reference, in a side list). Real tool logos; phone layout; dark mode.
- Replace 18 MCP tools with 6: `lcm_continue`, `lcm_find`, `lcm_outline`, `lcm_read`, plus `lcm_summary_task` / `lcm_summary_submit`, which only appear when in-conversation summaries are enabled.
- Summaries now merge before new text is summarized, so higher levels actually form; first-level segments default to about 12,000 characters / 32 messages and merge 4 at a time, all adjustable.
- Conversations get a short `#code`, track last activity, and sort newest first. Continuing elsewhere is one line: `通过 SuperLcm 接续对话 #code`.
- Remove the queued cross-conversation delivery flow (the target now pulls context with `lcm_continue`); old delivery tables are left untouched.
- Relicense from MIT to AGPL-3.0-only; commercial closed-source licensing is available from the author.

## 0.1.0-alpha.12

- Correct import to indexed-source → target context; move native collection into lazy index management and eliminate automatic page-load scans.
- Persist queued navigation snapshots and add lcm_receive_context for target pickup, with explicit pending/hook-issued/MCP-received states and no DAG merge.
- Replace invisible setup confirmation with an immediate dialog, error feedback, configuration readback and next steps.
- Verify actual Claude MCP loading using initialization-only mcp_status; distinguish diagnostics from existing user-session connectivity.
- Track connection heartbeats and successful tool calls, excluding diagnostic peers; add offline and real-browser regression coverage.

## 0.1.0-alpha.11

- Redesign the four console views around shared real local harness detection, grouped conversation selection, actual saved-node inspection, per-row diagnostics and reviewed setup.
- Replace Claude help examples and implicit Codex cache lists with real runtime model catalogs; retain provider/model and context suffix IDs with visible fallback status.
- Detect Hermes and Pi; import selected immutable native snapshots (Pi latest-leaf ancestry only), without falsely claiming automatic MCP/hook integration.
- Add official-CLI MCP registration, private config backups, stale-preview/conflict refusal and hook merging; native trust remains with the host.
- Add portable contribution/security/capability documents and repeatable offline plus opt-in actual Chrome/CLI tests.

## 0.1.0-alpha.10

- Index Codex transcript records at SessionStart and UserPromptSubmit (when a valid transcript_path exists), before the active agent needs to call the gated summary work/save tools; keep Stop/PostCompact tail ingestion.
- No change to the separate allowlisted lcm_import gate; agent summary writes still require selected agent mode, a real indexed session, and verified source hashes.

## 0.1.0-alpha.9

- Replace invisible subscription datalist with a selectable CLI model list plus manual ID entry; implement Web custom API provider, endpoint, model ID and write-only scoped key fields.
- Support Anthropic Messages and OpenAI-compatible Chat Completions in the actual background worker, store credentials in a separate private file, and test a non-billed loopback worker invocation.

## 0.1.0-alpha.8

- Replace conversation-scoped model settings with a global default and per-configured/observed-harness overrides. Legacy per-session rows remain but no longer route summary workers or agent tools.
- Auto-read local Codex CLI model cache and Claude CLI documented aliases into model suggestions without a model request. Label configuration and past activity separately from live connectivity; custom API remains Anthropic Messages-compatible.

## 0.1.0-alpha.7

- Add local authenticated Web console inspired by the 8790 asset center: named source/target selection, bounded summary preview, queued hook injection, receipt states, per-session summary backends and an actual local MCP handshake test button.
- MCP `lcm_context` returns a bounded navigation packet directly to the calling agent; `lcm_enqueue_context` queues cross-conversation delivery. Claude/Codex hooks can offer queued packets on next prompt/start. No claim of forced model use.
- Add isolated `codex exec --json --ephemeral` summarization backend and optional main-agent summary work/save tools, gated per session with source hash verification. Main-agent mode is off by default.

## 0.1.0-alpha.6

- Add Codex CLI Stop/PostCompact/SessionEnd hook adapter with bounded local transcript paths, independent session IDs and background summaries; Codex compaction stays native.
- Persist original harness and conversation ID with native Claude/Codex title records when available and derived/manual title precedence. Resolve by exact name or ID without guessing ambiguous titles; expose provenance on summaries and source reads.
- Skip model calls for metadata-only transcript batches and migrate prior alpha.5 session metadata in place.

## 0.1.0-alpha.5

- Make the local MCP store cross-harness: preserve session origin, support portable and Codex-shaped JSONL imports, and expose paginated independent summary nodes per conversation to any MCP client.
- Add Codex MCP registration guidance and retain the existing SQLite home/config path for existing Claude indexes. Automatic capture remains Claude-specific until another harness supplies a transcript adapter.

## 0.1.0-alpha.4

- Replace main-agent summary writing with an isolated background Claude CLI subprocess using the local subscription login and configurable `SUPERLCM_CLAUDE_CLI_MODEL`; retain explicitly selected API mode.
- Remove agent summary MCP tools and prompt-injection hook; guard recursive hooks and API/environment leakage. Legacy `agent` mode settings map to the background worker without deleting old nodes.

## 0.1.0-alpha.3

- Select agent mode by default and switch exclusively to API mode when the dedicated summarizer key is configured; suppress prompts and gate agent MCP writes to prevent duplicate summaries.
- Persist the hook-selected mode per session so separately launched MCP processes enforce the same policy.

## 0.1.0-alpha.2

- Add optional active-Claude summary work and validated hierarchical persistence; keep API-backed background summaries as a separate mode.
- Support local Claude Code sessions in the Desktop Code tab using the same hooks and MCP configuration.

## 0.1.0-alpha.1

- Extract Claude Code CLI and Desktop recall adapter as an independent package with no DSH compaction integration.
