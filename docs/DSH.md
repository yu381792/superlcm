# DSH 接入

DSH、Claude Code、Codex 等载体现在使用同一个 SuperLcm 项目和共享档案。
DSH 的压缩引擎迁入这个包，仍然独占 DSH 的压缩；归档只保存原始事件和复制
已提交的摘要，不运行第二个模型。DSH 会话禁止 SuperLcm 的通用摘要任务，
即使全局摘要设置改变也不会重复生成。

## 安装与选择

在 DSH profile 中安装本包，把 bundle 列表中的 `SuperLcm` 替换为
`superlcm-mcp`。组合包挂载 `superlcm-mcp/dsh`，提供跨载体检索及后台归档。
把原来唯一的 `SuperLcm-compaction` 条目中的 `name` 改成
`superlcm-mcp/dsh-engine`，保留该 profile 的原压缩设置和模型路线。
`compaction-basic` 必须禁用，每个 Agent 只能有一个压缩引擎。
取消单独的 `mcp-superlcm-archive` 条目，避免第二个归档工具入口。

所有载体使用同一个 `SUPERLCM_HOME`，默认 `~/.superlcm-claude`。
旧的 `DSH_SUPERLCM_DB` / `DSH_LOSSLESS_DB` 覆盖若指向其他库，应先取消。
统一插件会拒绝使用两个不同的数据库，不静默分叉。

## 双向接续

DSH 中说“通过 SuperLcm 接续 #df671”，使用 `lcm_continue` 读取 Claude、
Codex 等工具的摘要和最近原文。其他工具中也用相同命令接续 DSH 对话。
`lcm_find` 支持 `harness: "dsh"`，`lcm_outline` 查摘要，`lcm_read` 查完整原文。
原 DSH 摘要标记使用的 `lcm_grep`、`lcm_describe`、`lcm_expand` 等工具保留。

启动后，插件从 DSH 官方会话读取接口补录已有和当前会话；每次事件后增量归档。
原始 DSH 事件完整保存在可移植记录的 `event` 字段，记录序号等于原事件序号。
每个事件只追加一次；重复事件对照摘要值，内容变更或序号断裂会暂停归档并告警。
索引和文件复制在一个本机后台进程执行，不卡住模型的每次事件提交。
单条记录最多 4 MiB，与共享档案现有上限一致；超限会明确告警而不会截掉原文。

旧索引 `~/.dsh/SuperLcm/lcm.sqlite` 和
`~/.dsh/lossless-context/lcm.sqlite` 以只读方式迁入共享库，旧库原地保留。
仅已成功提交且所有引用事件已归档的摘要进入共享目录；未提交压缩不会冒充成功。
DSH 摘要选择的原事件可能不连续，目录会给出准确 `source_records`，范围只表示
查阅边界，不能理解为范围内所有事件都已概括。

代码、包和配置可以预先验证。正在运行的 DSH 需要重启后才加载更换后的插件；
本机运行服务的重启依照工作区规则单独取得明确授权。
