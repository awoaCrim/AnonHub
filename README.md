<div align="center">
  <img src="assets/logo.svg" width="128" alt="AnonHub" />

# AnonHub

有性格的个人 AI 助手

**简体中文** | [English](README_EN.md)

[![CI](https://github.com/awoaCrim/AnonHub/actions/workflows/ci.yml/badge.svg)](https://github.com/awoaCrim/AnonHub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)

</div>

AnonHub 是一个开源、可自行部署的个人 AI 助手。它有设定好的角色和长期记忆，也有一台属于自己的电脑。你在网页或手机上和它聊天，它可以替你查资料、处理文件、整理邮件和日程，或按计划执行任务；无论做什么，它说话都保持你为它设定的角色。它也可以加入 QQ 和微信，在私聊和群聊中与朋友们交流。

## 主要功能

- **角色扮演**：使用项目自有的角色卡格式，涵盖身份、性格、说话方式、经历、关系和示例对话等，并可附参考图和三视图。角色卡在控制台中编辑，修改即时保存；在主人的私聊中，它也可以按要求修改自己的角色卡。项目附带内置角色卡。
- **长期记忆**：跨会话记住偏好、事实和经历。长对话会自动折叠较早的内容，需要时再展开查看。
- **自己的电脑**：拥有独立的工作区，可以读写文件、执行命令、运行脚本和使用技能。连接你的电脑后，还能在你授权的范围内操作桌面和浏览器。
- **替你办事**：支持联网搜索与网页阅读、Google 邮件 / 日历 / 云端硬盘、图片生成与编辑，以及后台任务和定时任务；任务完成后会主动告诉你结果。
- **连接与扩展**：支持接入 MCP 服务，也可以从 npm 安装扩展；在主人的私聊中，它可以自行安装扩展。
- **多端可用**：网页聊天（可同时开多个对话，各自选择角色和模型）、Android 客户端，以及 QQ 和微信的私聊与群聊。

## 融入群聊

- **回复时机可控**：可以分别设置哪些消息会触发它：私聊、@它、@全体成员、引用消息、图片、戳一戳和普通群消息。被触发后，它会先读完上下文，再决定是否回复。
- **等对方说完**：对方停止发送若干秒后才开始回复，连续的几条消息合并处理；回复过程中收到的新消息会并入当前这一轮，不会逐条抢答。
- **自然的发送节奏**：一次回复可以分成几条消息，按设定的打字速度依次发出。
- **理解群聊上下文**：能分辨谁在对谁说话、引用了哪条消息、@了谁；图片和转发记录中的图片在需要时再查看。
- **会用表情包**：收藏并发送表情包，表情库可以所有会话共用，也可以按会话分开。
- **权限分明**：频道默认全部拒绝，按规则放行；敏感操作只响应管理员，修改角色卡等工具不在群聊中开放。

## 快速开始

### Linux + Docker

需要 Linux（amd64）、Docker Engine 和 Docker Compose v2。

```bash
git clone https://github.com/awoaCrim/AnonHub.git
cd AnonHub
bash scripts/install-linux.sh
```

安装程序会请你设置管理员初始密码（至少 12 位），然后构建镜像并启动服务。控制台默认只监听 `127.0.0.1:5140`，可以通过 SSH 隧道从本机访问：

```bash
ssh -L 5140:127.0.0.1:5140 <服务器>
```

打开 <http://127.0.0.1:5140>，使用 `admin` 账号登录，接入模型并选择角色卡后即可开始聊天。需要接入 QQ 或微信时，在控制台的「平台」页面扫码登录。

- `--bind`、`--port`、`--data-dir` 和 `--public-origin` 分别用于设置监听地址、端口、数据目录和公开访问地址；运行 `bash scripts/install-linux.sh --help` 可查看全部参数。
- 重复运行安装程序会保留已有的配置和登录数据。

### 配置

所有设置保存在状态目录的 `config/` 下，通过控制台读写：

- `app.json`：监听地址、端口和日志级别；
- `<模块>.json`：模块的启用状态和配置，格式为 `{ "enabled": true, "config": { … } }`；
- `secrets/<模块>.json`：密钥，在模块配置中以 `{ "$secret": "<JSON pointer>" }` 引用。

## 支持的平台

| 平台     | 接入方式                                                                            |
| -------- | ----------------------------------------------------------------------------------- |
| 网页聊天 | 控制台内置                                                                          |
| Android  | `apps/android`，在应用内打开同一站点的网页聊天和控制台                              |
| QQ       | 通过 [NapCat](https://github.com/NapNeko/NapCatQQ) 接入（OneBot 11 反向 WebSocket） |
| 微信     | 每个实例内置 [agent-wechat](https://github.com/thisnick/agent-wechat) 守护进程      |

## 支持的模型

| 协议      | 说明                                            |
| --------- | ----------------------------------------------- |
| OpenAI    | 也可以通过 `baseURL` 接入任何兼容 OpenAI 的接口 |
| Anthropic | Claude 系列                                     |
| Google    | Gemini 系列                                     |
| DeepSeek  | DeepSeek 系列                                   |

思考等级、工具调用和图片输入可以按模型分别配置。

## 开发

本仓库使用 Yarn 4 工作区和 Turborepo 管理，Yarn 版本固定在 `.yarn/releases/` 中；需要 Node.js 24。

```bash
yarn install
yarn lint            # oxlint
yarn fmt:check       # oxfmt
yarn check-types
yarn build
yarn test
python3 -m unittest discover -s scripts/tests -v
```

构建完成后，运行 `yarn server --state <状态目录>` 启动宿主。状态目录的初始化方式见 `docker/init.mjs`（容器）和 `scripts/init-local-runtime.mjs`（Windows 本地运行时）。

| 目录                       | 内容                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| `apps/server`              | 宿主：读取 `config/`，运行 Core、扩展、连接器、控制台和网页聊天      |
| `apps/android`             | Android 客户端（Gradle + Kotlin）                                    |
| `core`                     | 内核：消息准入、各会话的运行时、提示词、回复工具和模型注册           |
| `packages/agent-runtime`   | 与宿主无关的智能体循环：存储、回合队列、模型调用、工具执行和插件钩子 |
| `packages/contracts`       | 共享的协议与类型定义                                                 |
| `packages/foundation`      | 错误、配置、文件、网络、日志等基础设施                               |
| `platforms/onebot`         | QQ 连接器                                                            |
| `plugins/*`                | 控制台、工作区、记忆、搜索、MCP、定时任务、角色扮演、微信等可选模块  |
| `providers/model-provider` | 模型接入                                                             |
| `docker`、`scripts`        | 镜像构建、安装和运行时管理脚本                                       |

## 参与贡献

欢迎提交 Issue 和 Pull Request，提交前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告。

## 致谢

- [YesImBot](https://github.com/YesWeAreBot/YesImBot) 及其贡献者：本项目由它发展而来；
- [LINUX DO](https://linux.do) 社区；
- [NapCat](https://github.com/NapNeko/NapCatQQ)、[agent-wechat](https://github.com/thisnick/agent-wechat)、[Vercel AI SDK](https://github.com/vercel/ai)。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=awoaCrim/AnonHub&type=Date)](https://www.star-history.com/#awoaCrim/AnonHub&Date)

## 许可证

[MIT](LICENSE)
