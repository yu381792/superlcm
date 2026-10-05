# DSH 网页模型目录恢复

2026 年 10 月 5 日，网页启动配置中的 `llm-pi-ai` 模型供应商段缺失，默认模型仍指向 OpenCodex 的 Luna Fast。实际会话记录出现 `NO_ADAPTER`，模型目录不再包含 OpenCodex。页面记录显示，这发生在精简 `pi-both` 工具配置的操作之后；该轮之后配置文件只剩 115 行。

从本机已有升级前备份恢复缺失的 `llm-pi-ai` 段，写入前锁定配置文件并保存备份，保留现有工具预设、默认模型与 SuperLcm 接管关闭设置。运行中的模型同步插件随后按当前导出目录更新 OpenCodex 的模型配置。

验证直接调用运行中 DSH 的 `session/modelCatalog`，并在真实 Chrome 的模型菜单确认 OpenCodex 10 个模型及 DeepSeek 2 个模型可选，包含 GPT 6.1 Sol、Astra、Luna、GLM 5.3 Flash 与 DeepSeek。当前选择仍为 Luna Fast。没有调用模型、恢复目标或重启服务。私有备份与含认证配置的完整回执不进入仓库。
