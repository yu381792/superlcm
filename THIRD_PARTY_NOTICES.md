# 来源与许可

`dsh/` 中的异步压缩引擎、摘要索引和当前会话召回工具迁自本人的
`dsh-superlcm` 项目（SuperLcm 0.3.0-alpha.13），继续采用 MIT 许可。
DSH 运行时由用户的 DSH 安装提供，不打包到 SuperLcm 中。

0.5.1 的同层摘要合并、摘要前缀预算及失败后暂停重试的设计，参考
[Lossless Claw](https://github.com/Martian-Engineering/lossless-claw)
（Martian Engineering，MIT 许可）。这里按 DSH 的原生事件与压缩接口重新实现，
没有打包它的 OpenClaw 宿主代码。对照版本为
`e05d8d34b2a44fdef556ce95dd90115b46630200`。
