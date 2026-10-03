# 来源与许可

`dsh/` 中的异步压缩引擎、摘要索引和当前会话召回工具迁自本人的
`dsh-superlcm` 项目（SuperLcm 0.3.0-alpha.13），继续采用 MIT 许可。
DSH 运行时由用户的 DSH 安装提供，不打包到 SuperLcm 中。

0.5.1 的同层摘要合并、摘要前缀预算及失败后暂停重试的设计，参考
[Lossless Claw](https://github.com/Martian-Engineering/lossless-claw)
（Martian Engineering，MIT 许可）。这里按 DSH 的原生事件与压缩接口重新实现，
没有打包它的 OpenClaw 宿主代码。对照版本为
`e05d8d34b2a44fdef556ce95dd90115b46630200`。

DSH 图标来自 DeepSeek Harness 的 `@deepseek-ai/dsh-web-frontend` 0.2.1-alpha.1
中的 `dist/favicon.svg`，仅用于标识兼容载体；颜色改为随界面变化。
来源：https://github.com/deepseek-ai/deepseek-harness 。许可原文如下：

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
