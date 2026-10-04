# GLM 5.3 Flash 独立审查与复核

2026-10-04 按用户要求，以 Pi 的 `opencodex/opencode-go/glm-5.3-flash` 开独立只读审查。覆盖 0.5.11 的共享摘要策略、原文投影、API/CLI/MCP 写入口、Claude 压缩入口、DSH 来源与摘要树、后台覆盖展示及相关测试。审查工具限于 read、grep、find、ls，没有改变默认模型、生产会话或服务。

交叉核查确认 Codex 的 `custom_tool_call` / `custom_tool_call_output` 未进入摘要输入，原文仍在。0.5.12 已修复，GLM 重读代码及回归测试后确认该项关闭。原因、迁移边界和验证见 [Codex 工具来源补全](CODEX-CUSTOM-TOOLS-0.5.12.md)。

GLM 初审另列两项低风险 estimate 问题。主会话对 100 个混合空记录/消息夹具比较估算与实际规划，计数全部相同；同时核实正常字符及合并预算上界。GLM 定点复核重读源码后撤回两项，未为无法复现的推测增加预检门槛。

DSH 结束状态假设也经本机宿主源码核实关闭：插件拦截 max-tokens/tool-calls，宿主 summarizeWithLlm 的 finishError 拒绝 error/aborted/max-tokens。旧无 marker 检查点与同次 prepared 树共用身份的假设没有实际触发链，未列为缺陷。MCP 对话内摘要提交没有模型停止原因信号的现有边界已在设计说明中补充。

最终复核在本次范围内没有新增可确认缺陷。主会话 `npm run validate` 141/141，版本同步后语法检查和打包测试 3/3 通过；GLM 没有自行运行测试，通过数来自主会话验证。DSH 宿主运行时 37/37 为上一轮证据，本次未改 DSH 运行逻辑，也未重复运行或重新启用 DSH。

这是一轮代码及输入链路审查。没有运行 Haiku/gpt-6-luna 的真实摘要对拍，没有重写旧摘要，也不能据此宣称所有模型概括都不会丢失信息。真实语义质量仍需对照合成原文逐项检查；结构与提示正确不等于所有模型输出正确。
