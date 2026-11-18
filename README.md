# Aurora Chat — Web front-end

This repository is the web front-end of **Aurora Chat**, a community-maintained chat client.

It is a fork of the open-source project [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)
(MIT, © DeepSeek), with substantial modifications and additions: multi-protocol API presets
(Anthropic Messages / OpenAI Chat / OpenAI Responses), usage statistics, a local SQLite memory,
automatic context compaction, and a style-pack system (backgrounds, icons, fonts, colours, effects).

Aurora Chat is **not** an official DeepSeek product and is not affiliated with or endorsed by DeepSeek.
Names, interface and trademarks belong to their respective owners. The upstream project is licensed
under the MIT license; the upstream text is preserved in [`LICENSE-UPSTREAM`](./LICENSE-UPSTREAM) while [`LICENSE`](./LICENSE) holds this project's MIT license.

## Project layout

- `src/` — React + TypeScript application (rspack build)
- `services/` — API providers, presets, style packs, memory, usage, chat history
- `desktop/` and `mobile/` shells, build scripts and documentation live in the sibling
  [aurora-chat-app](https://github.com/qeggs-dev/aurora-chat-app) repository

## Development

```bash
pnpm install
pnpm dev        # http://localhost:8090
pnpm build      # production build into dist/
```

Enter your API key in the app settings before the first chat. The app talks directly to the
configured API endpoint (default DeepSeek Anthropic-compatible endpoint); no proxy is involved.

## License

- This project: MIT, © Qeggs and Aurora Chat contributors — see [`LICENSE`](./LICENSE).
- Upstream code: MIT, © DeepSeek — preserved in [`LICENSE-UPSTREAM`](./LICENSE-UPSTREAM).

Upstream online demo (for comparison only): <https://deepseek-ai.github.io/chat-demo/>
