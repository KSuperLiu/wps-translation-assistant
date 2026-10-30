# 第三方组件

在线 AI 使用 Vercel AI SDK（https://github.com/vercel/ai）：ai 7.0.157、@ai-sdk/openai-compatible 3.0.81、@ai-sdk/anthropic 4.0.92、@ai-sdk/google 4.0.108，均为 Apache-2.0 许可，Copyright 2023 Vercel, Inc.。运行时依赖的许可及声明随插件分发于 third-party-licenses.txt；使用这些 SDK 不表示经过服务商认证。

LiteLLM 是用户自行部署或选择的上游服务，本插件通过兼容 API 接入，不打包或分发 LiteLLM Python SDK。本机环境变量连接脚本由本项目独立实现。

安装网站的本机桥接由本项目独立实现，使用 WPS 自带 RelayHttpServer 的回环接口；没有复制、修改或分发 WPS 的 SDK 源码。

开发工具 `wpsjs` 2.2.3 的许可文件位于安装依赖后的 `node_modules/wpsjs/LICENSE`。网站不复制或修改它的发布页面模板。其余构建工具及传递依赖的许可见对应 npm 包。

Windows EXE 安装器、翻译助手和本站界面由本项目独立实现。产品名称用于描述适配环境，不表示 WPS / 金山办公对本项目的官方认可。
