# 发布与下载安装

用户无需克隆仓库或使用维护者的本机路径。维护者可在 GitHub 的 Actions 中
手动运行 `Build distributable package`，下载 `superlcm-install-package` 产物，
取得 `superlcm-mcp-<版本>.tgz` 安装包；也可以在源码目录运行 `npm pack --ignore-scripts`。
该操作只构建安装包，不会发布到 npm，也不会创建公开发布记录。

用户先安装 Node.js 22.16 或更新版本，然后在安装包所在目录运行：

```sh
npm install -g ./superlcm-mcp-0.5.16.tgz
superlcm web
```

浏览器打开命令输出的本机地址，在「接入」中选择载体。默认接入归档、后台摘要和查询，上下文由各工具自身压缩。dsh harness 用户先按
[官方说明](https://github.com/deepseek-ai/deepseek-harness) 安装并启动 dsh harness，再完成全局接入并重新加载。后台摘要在接入卡片选择已保存的自定义 API；默认接入不需要压缩模型，也不需要旧的 dsh-superlcm 插件。

控制台导航为「对话 → 接入 → 压缩 → 设置」。独立「压缩」页分开管理 Claude Code 和 DSH 的可选 SuperLcm 接管，默认关闭。DSH「插件 → SuperLcm」仅显示「后台设置」，点击进入后台 DSH 压缩页。需要接管时在该页明确开启并保存，首次开启后重新加载 DSH；原聊天模型与原生压缩政策保留，所选压缩模型的调用额度只在生成压缩摘要时使用。详见 [DSH 接入与压缩](DSH.md)。

安装器写入 DSH 全局配置，所有启动方式共用同一套归档。之后新增的启动方式默认保留原生压缩；需要接管时先重新接入以捕获原生政策。供应商、账号和聊天模型配置保留，读取模型目录本身不调用生成模型。
原配置先备份，验证失败会恢复；旧插件和旧索引保留，不删除原文。

`package.json` 已移除 `private` 发布限制并设置公开包访问方式。维护者拥有
`superlcm-mcp` 包名权限并完成 npm 登录后，可以自行执行 `npm publish`。
包名归属和 npm 登录尚未代用户核实，此处不声称安装包已经上线 npm。

Claude Code 用户也可以继续从现有插件市场安装 SuperLcm，执行
`/superlcm:console` 打开控制台，再通过同一个 dsh harness 接入按钮安装。
