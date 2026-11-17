# Aurora Chat — Web 前端

本仓库是 **Aurora Chat** 的 Web 前端，一个社区维护的聊天客户端。

它 fork 自开源项目 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)
（MIT，版权归 DeepSeek），并在其基础上做了大量修改与扩展：多协议 API 预设
（Anthropic Messages / OpenAI Chat / OpenAI Responses）、用量统计、本地 SQLite 记忆、
自动上下文压缩、以及样式包系统（背景、图标、字体、配色、图片特效）。

Aurora Chat **不是** DeepSeek 官方产品，与 DeepSeek 没有隶属或背书关系；名称、界面与商标
归各自权利人所有。上游代码以 MIT 许可发布，见 [`LICENSE`](./LICENSE) 与仓库根目录的
`LICENSE-UPSTREAM`。

## 目录

- `src/` —— React + TypeScript 应用（rspack 构建）
- 服务层：API 协议、预设、样式包、记忆、用量、会话历史
- `desktop/`、`mobile/` 壳、构建脚本与文档在兄弟仓库
  [aurora-chat-app](https://github.com/qeggs-dev/aurora-chat-app)

## 开发

```bash
pnpm install
pnpm dev        # http://localhost:8090
pnpm build      # 生产构建输出到 dist/
```

首次使用前在应用设置里填写 API Key；应用直连配置的 API 端点（默认 DeepSeek 的 Anthropic
兼容端点），不经过任何代理。

## 许可

- 上游代码：MIT，© DeepSeek —— 见 [`LICENSE`](./LICENSE)
- 本 fork 的修改：MIT，© Aurora Chat contributors

上游官方在线 demo（仅供对照）：<https://deepseek-ai.github.io/chat-demo/>
