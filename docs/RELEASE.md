# 发布与下载安装

用户无需克隆仓库或使用维护者的本机路径。维护者可在 GitHub 的 Actions 中
手动运行 `Build distributable package`，下载 `superlcm-install-package` 产物，
取得 `superlcm-mcp-<版本>.tgz` 安装包；也可以在源码目录运行 `npm pack --ignore-scripts`。
该操作只构建安装包，不会发布到 npm，也不会创建公开发布记录。

用户先安装 Node.js 22.16 或更新版本，然后在安装包所在目录运行：

```sh
npm install -g ./superlcm-mcp-0.5.3.tgz
superlcm web
```

浏览器打开命令输出的本机地址，在「接入」中选择载体。DSH 用户先按
[官方说明](https://github.com/deepseek-ai/deepseek-harness) 安装 DSH，并启动一次
要使用的界面，再点击 DSH 的「接入」。选择界面、检查压缩模型并点击
「安装并启用压缩」，随后重新加载 DSH。插件自动保留所有原文并收录压缩摘要，
模型可直接使用 `lcm_find`、`lcm_outline`、`lcm_read`、`lcm_continue` 查档和接续。

DSH 安装器从当前 SuperLcm 安装位置复制发行文件，并复用该 DSH 安装已有的
运行时依赖；不使用维护者的用户名、目录、模型或账号，不联网下载其他插件。
每次接入先备份配置，更新本地包依赖和插件列表；压缩模型沿用所选界面原来的
路线，用户也可在确认前明确修改。生成压缩摘要会使用该模型的调用额度。

`package.json` 已移除 `private` 发布限制并设置公开包访问方式。维护者拥有
`superlcm-mcp` 包名权限并完成 npm 登录后，可以自行执行 `npm publish`。
包名归属和 npm 登录尚未代用户核实，此处不声称安装包已经上线 npm。

Claude Code 用户也可以继续从现有插件市场安装 SuperLcm，执行
`/superlcm:console` 打开控制台，再通过同一个 DSH 接入按钮安装。
