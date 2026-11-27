<div align="center">
  <img src="assets/logo.svg" width="128" alt="AnonHub" />

# AnonHub

A personal AI assistant with a personality

[简体中文](README.md) | **English**

[![CI](https://github.com/awoaCrim/AnonHub/actions/workflows/ci.yml/badge.svg)](https://github.com/awoaCrim/AnonHub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)

</div>

AnonHub is an open-source, self-hosted personal AI assistant. It has a character you define, a long-term memory, and a computer of its own. Chat with it on the web or on your phone, and it can look things up, work with files, sort out your email and calendar, or carry out tasks on a schedule, all while staying in the character you gave it. It can also join QQ and WeChat, talking with your friends in private and group chats.

## Features

- **Roleplay**: a role card format of its own, covering identity, personality, speaking style, background, relationships, example dialogue and more, with an optional reference image and turnaround sheet. Cards are edited in the console and saved as you type; in its owner's private chat, the assistant can also revise its own card on request. A built-in card is included.
- **Long-term memory**: remembers preferences, facts and experiences across conversations. In long conversations, earlier parts are folded away and expanded again when needed.
- **A computer of its own**: a dedicated workspace where it can read and write files, run commands and scripts, and use skills. Connect your own computer, and it can operate the desktop and browser within the permissions you grant.
- **Gets things done**: web search and page reading, Google Mail / Calendar / Drive, image generation and editing, plus background and scheduled tasks; it reports back when a task is done.
- **Connections and extensions**: connects to MCP servers and installs extensions from npm; in its owner's private chat, it can install extensions by itself.
- **Available everywhere**: web chat (several conversations at once, each with its own character and model), an Android app, and private and group chats on QQ and WeChat.

## At home in group chats

- **Controlled reply triggers**: choose which messages can trigger it: private messages, @-mentions, @everyone, quoted messages, images, pokes and ordinary group messages. Once triggered, it reads the context first and then decides whether to reply.
- **Lets people finish**: it starts replying only after the other person has paused for a few seconds, and reads consecutive messages together; messages that arrive while it is replying join the current turn instead of getting a reply each.
- **Natural pacing**: a reply can be split into several messages, sent one after another at a set typing speed.
- **Understands the conversation**: it can tell who is talking to whom, which message was quoted and who was mentioned; images, including those inside forwarded chats, are opened only when needed.
- **Uses stickers**: it collects and sends stickers, from a library shared across all conversations or kept separate per conversation.
- **Clear permissions**: every channel is denied by default and allowed by rule; sensitive actions respond only to administrators, and tools such as editing the role card are not offered in group chats.

## Quick start

### Linux + Docker

Requires Linux (amd64), Docker Engine and Docker Compose v2.

```bash
git clone https://github.com/awoaCrim/AnonHub.git
cd AnonHub
bash scripts/install-linux.sh
```

The installer asks you to set an initial administrator password (at least 12 characters), then builds the images and starts the service. By default the console listens only on `127.0.0.1:5140`; reach it from your own machine through an SSH tunnel:

```bash
ssh -L 5140:127.0.0.1:5140 <server>
```

Open <http://127.0.0.1:5140>, sign in as `admin`, connect a model and choose a role card, and you can start chatting. To connect QQ or WeChat, scan the QR code on the console's 平台 (Platforms) page.

- `--bind`, `--port`, `--data-dir` and `--public-origin` set the listen address, port, data directory and public URL; run `bash scripts/install-linux.sh --help` for every option.
- Running the installer again keeps the existing configuration and sign-in data.

### Configuration

All settings live under `config/` in the state directory and are read and written by the console:

- `app.json`: listen address, port and log level;
- `<module>.json`: whether a module is enabled and its configuration, as `{ "enabled": true, "config": { … } }`;
- `secrets/<module>.json`: secrets, referenced from a module's configuration as `{ "$secret": "<JSON pointer>" }`.

## Platforms

| Platform | How it connects                                                                      |
| -------- | ------------------------------------------------------------------------------------ |
| Web chat | Built into the console                                                               |
| Android  | `apps/android`, which opens the same site's web chat and console in the app          |
| QQ       | Through [NapCat](https://github.com/NapNeko/NapCatQQ) (OneBot 11 reverse WebSocket)  |
| WeChat   | The [agent-wechat](https://github.com/thisnick/agent-wechat) daemon in each instance |

## Models

| Protocol  | Notes                                                    |
| --------- | -------------------------------------------------------- |
| OpenAI    | Any OpenAI-compatible API can also be used via `baseURL` |
| Anthropic | Claude models                                            |
| Google    | Gemini models                                            |
| DeepSeek  | DeepSeek models                                          |

Thinking level, tool calling and image input are configured per model.

## Development

The repository is a Yarn 4 workspace managed with Turborepo; Yarn is pinned in `.yarn/releases/`. Node.js 24 is required.

```bash
yarn install
yarn lint            # oxlint
yarn fmt:check       # oxfmt
yarn check-types
yarn build
yarn test
python3 -m unittest discover -s scripts/tests -v
```

After building, start the host with `yarn server --state <state directory>`. For how a state directory is initialized, see `docker/init.mjs` (containers) and `scripts/init-local-runtime.mjs` (the Windows local runtime).

| Directory                  | Contents                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/server`              | The host: reads `config/` and runs Core, extensions, connectors, the console and web chat       |
| `apps/android`             | The Android app (Gradle + Kotlin)                                                               |
| `core`                     | The kernel: message admission, per-conversation runtimes, prompts, reply tools, model registry  |
| `packages/agent-runtime`   | A host-independent agent loop: storage, turn queue, model calls, tool execution, plugin hooks   |
| `packages/contracts`       | Shared protocols and types                                                                      |
| `packages/foundation`      | Errors, configuration, files, networking, logging and other foundations                         |
| `platforms/onebot`         | The QQ connector                                                                                |
| `plugins/*`                | Optional modules: console, workspace, memory, search, MCP, schedules, roleplay, WeChat and more |
| `providers/model-provider` | Model access                                                                                    |
| `docker`, `scripts`        | Image builds, installation and runtime management scripts                                       |

## Contributing

Issues and pull requests are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md) first. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Acknowledgements

- [YesImBot](https://github.com/YesWeAreBot/YesImBot) and its contributors: this project grew out of it;
- The [LINUX DO](https://linux.do) community;
- [NapCat](https://github.com/NapNeko/NapCatQQ), [agent-wechat](https://github.com/thisnick/agent-wechat) and the [Vercel AI SDK](https://github.com/vercel/ai).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=awoaCrim/AnonHub&type=Date)](https://www.star-history.com/#awoaCrim/AnonHub&Date)

## License

[MIT](LICENSE)
