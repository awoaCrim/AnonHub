<div align="center">
  <img src="assets/logo.png" width="40%" alt="AnonHub" />

# AnonHub

有性格的个人 AI 助手

[![CI](https://github.com/awoaCrim/AnonHub/actions/workflows/ci.yml/badge.svg)](https://github.com/awoaCrim/AnonHub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)

</div>

AnonHub 是一个开源、可自部署的个人 AI 助手。它有自己的角色和记忆，也有自己的电脑：你在网页或手机上和它聊天，它替你查资料、处理文件、整理邮件和日程、按计划去办事，说起话来始终是你给它设定的那个人。需要时，也可以把它带进 QQ 和微信，和朋友们一起聊。

## 主要功能

- **角色扮演**：项目自有的角色卡格式（身份、性格、说话方式、关系、示例对话……），带参考图和三视图，在控制台里即改即存；它也能在你的私聊里修改自己的角色卡。附带内置角色卡。
- **长期记忆**：记住跨会话的偏好、事实和经历；长对话自动分区，旧内容按需展开。
- **它自己的电脑**：独立的工作区，可以读写文件、执行命令、运行脚本、使用技能；接上你的电脑后，还能在你授权的范围里操作桌面和浏览器。
- **替你办事**：联网搜索与网页阅读、Google 邮件 / 日历 / 网盘、图片生成与编辑、后台任务与定时任务，事情办完再回来告诉你。
- **连接与扩展**：MCP 服务、从 npm 安装扩展；它也能在主人的私聊里自己装扩展。
- **像人一样聊天**：自己决定回不回、什么时候回；回复只经 `send_message` 发出，连续的消息会合并再看，会用表情包。
- **在哪都能找到它**：网页聊天（多个对话，各自选角色和模型）、Android 客户端，以及 QQ 和微信的私聊与群聊。

## 快速开始

### Linux + Docker

需要 Linux amd64、Docker Engine 和 Compose v2。

```bash
git clone https://github.com/awoaCrim/AnonHub.git
cd AnonHub
bash scripts/install-linux.sh
```

安装器会询问 QQ 号和管理员初始密码（至少 12 位），然后构建镜像并启动。控制台默认只监听 `127.0.0.1:5140`，从本机经 SSH 隧道访问：

```bash
ssh -L 5140:127.0.0.1:5140 <服务器>
```

打开 <http://127.0.0.1:5140>，用 `admin` 登录，接入模型、选好角色卡，就可以开始聊了。QQ 和微信在控制台里扫码登录。

- `--bind`、`--port`、`--data-dir`、`--public-origin` 分别改监听地址、端口、数据目录和公开访问地址；`bash scripts/install-linux.sh --help` 列出全部参数。
- 重复运行保留已有配置和登录数据。

### 配置

全部设置在状态目录的 `config/` 下，由控制台读写：

- `app.json`：监听地址、端口和日志级别；
- `<模块>.json`：`{ "enabled": true, "config": { … } }`；
- `secrets/<模块>.json`：密钥，模块配置里以 `{ "$secret": "<JSON pointer>" }` 引用。

## 在哪里和它聊

| 入口     | 接入方式                                                                         |
| -------- | -------------------------------------------------------------------------------- |
| 网页聊天 | 控制台自带                                                                       |
| Android  | `apps/android`，打开同一站点的网页聊天和控制台                                   |
| QQ       | [NapCat](https://github.com/NapNeko/NapCatQQ)，OneBot 11 反向 WebSocket          |
| 微信     | 每个实例内置的 [agent-wechat](https://github.com/thisnick/agent-wechat) 守护进程 |

## 支持的模型

| 协议      | 说明                                      |
| --------- | ----------------------------------------- |
| OpenAI    | 也可填 `baseURL` 接入任何 OpenAI 兼容接口 |
| Anthropic | Claude                                    |
| Google    | Gemini                                    |
| DeepSeek  | DeepSeek                                  |

思考等级、工具调用和图片输入按模型配置。

## 开发

仓库是 Yarn 4 工作区加 Turborepo，Yarn 随仓库固定在 `.yarn/releases/`；需要 Node.js 24。

```bash
yarn install
yarn lint            # oxlint
yarn fmt:check       # oxfmt
yarn check-types
yarn build
yarn test
python3 -m unittest discover -s scripts/tests -v
```

构建后用 `yarn server --state <状态目录>` 运行宿主。状态目录的初始化见 `docker/init.mjs`（容器）和 `scripts/init-local-runtime.mjs`（Windows 本地运行时）。

| 目录                       | 内容                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| `apps/server`              | 宿主：读取 `config/`，运行 Core、扩展、连接器、控制台和网页聊天      |
| `apps/android`             | Android 客户端（Gradle + Kotlin）                                    |
| `core`                     | 内核：消息准入、每个会话的运行时、提示词、回复工具、模型注册         |
| `packages/agent-runtime`   | 与宿主无关的智能体循环：存储、回合队列、模型调用、工具执行、插件钩子 |
| `packages/contracts`       | 共享的协议与类型                                                     |
| `packages/foundation`      | 错误、配置、文件、网络、日志等基础设施                               |
| `platforms/onebot`         | QQ 连接器                                                            |
| `plugins/*`                | 控制台、工作区、记忆、搜索、MCP、定时任务、角色扮演、微信等模块      |
| `providers/model-provider` | 模型接入                                                             |
| `docker`、`scripts`        | 镜像、安装与运行时管理脚本                                           |

## 参与

欢迎提 Issue 和 Pull Request，先读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 致谢

- [YesImBot](https://github.com/YesWeAreBot/YesImBot) 及其贡献者，本项目由它发展而来；
- [LINUX DO](https://linux.do) 社区；
- [NapCat](https://github.com/NapNeko/NapCatQQ)、[agent-wechat](https://github.com/thisnick/agent-wechat)、[Vercel AI SDK](https://github.com/vercel/ai)。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=awoaCrim/AnonHub&type=Date)](https://www.star-history.com/#awoaCrim/AnonHub&Date)

## 许可证

[MIT](LICENSE)
