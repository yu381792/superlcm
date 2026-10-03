# 发布与下载安装

用户无需克隆仓库或使用维护者的本机路径。维护者可在 GitHub 的 Actions 中
手动运行 `Build distributable package`，下载 `superlcm-install-package` 产物，
取得 `superlcm-mcp-<版本>.tgz` 安装包；也可以在源码目录运行 `npm pack --ignore-scripts`。
该操作只构建安装包，不会发布到 npm，也不会创建公开发布记录。

用户先安装 Node.js 22.16 或更新版本，然后在安装包所在目录运行：

```sh
npm install -g ./superlcm-mcp-0.5.5.tgz
superlcm web
```

浏览器打开命令输出的本机地址，在「接入」中选择载体。dsh harness 用户先按
[官方说明](https://github.com/deepseek-ai/deepseek-harness) 安装并启动 dsh harness，
再点击它的「接入」。供应商和模型从 dsh harness 当前配置读取，直接用下拉列表
选择压缩模型，点击「安装并启用压缩」完成全局接入，首次接入或升级插件后重新加载 dsh harness。「设置 → 压缩」仅包含 Claude Code 的设置；DSH 接入和模型选择仍在「接入」页。
不需要旧的 dsh-superlcm 插件，也不需要区分 web、acp 等内部启动方式。

安装器写入 dsh harness 全局配置，现有和之后新增的启动方式共用同一套插件及
会话档案。原供应商、账号和聊天模型设置保持原样；SuperLcm 压缩插件通过 DSH 的模型服务调用用户选定的模型。压缩会使用该模型的调用额度，读取模型目录本身不调用生成模型。
原配置先备份，验证失败会恢复；旧插件和旧索引保留，不删除原文。

`package.json` 已移除 `private` 发布限制并设置公开包访问方式。维护者拥有
`superlcm-mcp` 包名权限并完成 npm 登录后，可以自行执行 `npm publish`。
包名归属和 npm 登录尚未代用户核实，此处不声称安装包已经上线 npm。

Claude Code 用户也可以继续从现有插件市场安装 SuperLcm，执行
`/superlcm:console` 打开控制台，再通过同一个 dsh harness 接入按钮安装。
