# Lossless Claw 摘要粒度设计对照（2026-10-06）

结论：少一些、内容完整的底层摘要，比不断产生很小的摘要更适合长任务。高层摘要仍用于导航，原文承担精确证据。不能单看摘要数量，也不能把字符数和 token 数直接比较。

本次核对 Martian-Engineering/lossless-claw 的 main，HEAD 为 `e05d8d34b2a44fdef556ce95dd90115b46630200`。配置默认值以运行时配置解析器为准；源码里个别旧注释与运行时默认值不一致。

| 项目 | Lossless Claw 当前设计 | SuperLcm 本次行为与取舍 |
| --- | --- | --- |
| 底层分块 | `leafChunkTokens` 默认上限 20,000 token；`leafMinFanout` 默认 8 条 | 按用户追加要求改为 20,000 个估算 token。借鉴中英文与符号权重，不用字符数冒充 token；短消息数不会单独触发常规小段 |
| 摘要长度 | 运行时底层目标 2,400 token，高层 2,000 token | 当前提示目标 1,200 token、输出上限 2,048 token、摘要上限 6,000 字符；更大的输入不应被解读成可以删掉更多关键约束 |
| 升层 | 正常扇出 4，还要求累计摘要内容达到最低规模；同深度、连续来源才合并 | 当前每四个同层节点合并，完整子摘要进入模型，不截掉子摘要尾部。对于很短子摘要，规模条件值得继续借鉴 |
| 调用保护 | 每会话默认十分钟最多 24 次摘要调用，超出后暂停三十分钟；扫荡还有限轮次和时间 | 当前具有每会话写入租约、启动去重和设置撤销保护；没有实现同等的十分钟调用预算。不能宣称只改粒度就保证硬性调用上限 |

分块、摘要目标和调用预算来自[配置解析器](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/db/config.ts)及[配置参考](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/docs/configuration.md)。高层合并规模、同深度连续选择和摘要递进策略核对了[压缩实现](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/compaction.ts)。

Lossless 当前的自动上下文压缩按上下文门槛触发；它提供 capture-only 宿主模式，普通 CLI 可以保留归档与查询、将原生压缩留给宿主。它还明确说明按提示相关性重选历史会改变缓存前缀，因此该选项默认关闭。这支持本次把归档摘要与上下文替换分开的方向，但它的接管压缩门槛不适合原样套在不接管的后台档案上。[机制说明](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/docs/configuration.md)

本机原设置为 12,000 字符、扇出 4；抽查最近底层原文段多数约 6,500–12,000 字符，大记录还会令之前的小段提前闭合。每四段还有一次合并调用，多个活跃会话会叠加在网关日志里。截图频繁小请求与这一粒度相符，抽查本身不能证明重复摘要或承诺费用下降四倍。

本次先降低字符粒度频率，随后按用户追加要求在 0.5.15 改为 20,000 个估算 token，扇出保持 4。Lossless 的分块也使用估算器：中日韩文字约 1.5 token/码点、普通拉丁文字约 0.25、其他补充平面字符约 2。我们按同样的权重思路规划摘要输入，包含来源标记；这不是供应商实测计费 token。[估算器](https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/estimate-tokens.ts)

旧摘要不重写。后续判断依据应是新增有效原文量对应的模型调用次数、底层摘要的关键约束与否定是否保留，以及检索能否准确定位原文。若继续改进，优先做每会话调用预算；不为减少调用把整个长任务压成一条笼统摘要，也不通过自动替换当前上下文来控制档案规模。
