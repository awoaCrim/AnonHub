# YesImBot 用户设备客户端

预览版。客户端主动通过 HTTPS/WSS 连接设备网关，无需 Mac 隧道，不监听公网端口。本机设置页仅监听 `127.0.0.1` 的随机端口。Windows 11 x64 的安装、隐藏启动、升级与退出已验收，Linux 电脑已接入生产；普通非管理员账户、Windows 实际重新登录周期和 macOS 实机尚未验收。

## 安装与配对

在云端控制台的「我的设备」页下载客户端。Windows x64 包自带 Node.js；macOS/Linux 通用包需要预先安装 Node.js 22.16 或更新版本。页面同时提供当前站点的网关地址和文件校验值。安装包不包含凭证、聊天数据或图片密钥。

复制整个目录到自己的 Windows 电脑，用普通用户 PowerShell 运行 `./install.ps1`，或双击 `Install.cmd`。脚本先校验文件，再创建当前用户私有状态目录和开始菜单入口；Windows 运行环境包不需要另装 Node。若组织策略禁止脚本运行，应遵循管理员规定的安装方式；安装器不修改执行策略或提权。

在自动打开的「我的电脑」设置页：

1. 填设备网关地址，选择工作区文件、命令行、桌面能力。
2. 分别配置私聊与群聊可用工具，填写允许的会话和发送者。默认全部拒绝；群规则默认允许该群全部发送者。
3. 保存设置，填入自己云端控制台「我的设备」中的一次性配对码，点击配对。
4. 启动连接，再在云端工作区中选择该设备。网关连接成功不表示桌面服务已经就绪；「检查连接」只做只读可达性检查。

关闭浏览器不会退出客户端。开始菜单 `YesImBot Settings` 重新打开同一实例；`YesImBot Exit` 正常退出并保留配对。设置页支持暂停、诊断和撤销配对。修改设置前先暂停；扩大设备能力或更换网关前先撤销并重新配对，云端确认撤销前保留凭证，不静默丢弃旧身份。

配对码五分钟内一次有效。凭证和 SQLite 状态目录只属于当前系统用户，勿复制给其他账号或删除操作账本来重试。高级用户仍可编辑 `%LOCALAPPDATA%\YesImBot-device\config.json`，例如只开放一个私聊的文件能力：

```json
{
  "version": 1,
  "gateway": "https://devices.example.com",
  "workspaceRoot": "./workspaces",
  "policy": {
    "version": 1,
    "direct": { "enabled": true, "tools": ["workspace.files.read", "workspace.files.write", "workspace.files.list", "workspace.files.mkdir"] },
    "group": { "enabled": false, "tools": [] },
    "actors": [{ "kind": "direct", "platform": "onebot", "conversationId": "10001", "botId": "10000", "userId": "10001" }]
  },
  "capabilities": { "files": true, "shell": false }
}
```

客户端和设备网关在同一台服务器上（例如服务器上的虚拟机）时，可以加 `"localGateway": "http://192.168.241.1:17401"`：先走这个内网地址（只接受 `http://` 加私有 IPv4 和端口，网关要开 `--local-port`/`--local-allow`），连不上就改用 `gateway`，5 分钟后再试内网。检查更新始终用 `gateway` 的 HTTPS 站点。

配置里的 `policy` 是本机最后一道权限检查；云端插件还要单独授权。`*` 表示明确允许全部，包含以后新增的工具；空列表拒绝全部。文件能力以租户、机器人和会话建立隔离目录。命令行/桌面能力则拥有当前系统用户的电脑权限，适合专用系统账号或专用电脑。

## 后台运行与升级

配对完成后，从原安装包执行 `./install.ps1 -Autostart`，注册当前 Windows 用户登录后的隐藏任务。任务不会打开浏览器或提升权限；主动退出后不自动拉起。移除启动项用 `./install.ps1 -RemoveAutostart`，已有客户端由退出入口停止。桌面需要该 Windows 用户已登录，锁屏/注销会影响这些能力。

### 自动更新

发布版客户端（打包时带 `--client-version`）会自己更新：启动两分钟后检查一次，之后每 6 小时检查一次站点的 `/downloads/client.json`（与设备网关同一站点，必须是 HTTPS）。清单里本平台的新版本必须带有效的发布签名（Ed25519，公钥内置在客户端里，私钥只在发布机器上），否则拒绝安装。下载后核对大小和 SHA-256，再逐个核对包内 `SHA256SUMS`，解包到状态目录下新的 `runtime-v<版本>-<随机>` 文件夹，先运行一次 `client.cjs version` 确认能启动，然后等手头没有正在执行的操作时重启进新版本；Windows 的开始菜单入口和登录任务（`*.vbs`）会改指向新版本。配对、设置和账本都不动；上一版文件夹保留，更早的自动删除（`install.ps1` 装的 `runtime-<guid>` 不动）。旧入口启动时如果发现已安装更新的版本，会直接交给新版本运行。本机设置页「版本与更新」可以关闭自动更新、手动检查或立即更新。从源码运行（版本 `0.0.0-dev`）不会自动更新。在 systemd 下运行时，更新后以退出码 75 退出，由服务管理器重启。

发布新版本：

```sh
node scripts/package-device-client.mjs --output .release-local/client/windows-x64 --windows-node v22.23.4 --client-version 2026.1107.1930
node scripts/package-device-client.mjs --output .release-local/client/portable --client-version 2026.1107.1930
node scripts/publish-device-client.mjs --version 2026.1107.1930 --windows .release-local/client/windows-x64 --portable .release-local/client/portable --gateway https://站点 --out .release-local/client/downloads
```

签名私钥默认在 `~/.config/yesimbot/client-release-ed25519.pem`，不要放到服务器或仓库里；丢了只能换公钥，所有电脑需要手动更新一次。把 `--out` 目录里的文件上传到站点宿主状态目录的 `downloads/`：先上传 ZIP，最后替换 `client.json`。

### 手动升级

升级时运行新包的安装脚本：先正常退出本机控制服务，再安装到独立运行目录，保留上一版文件与所有账本。没有控制端点的旧版 CLI 运行时，需要先停止旧进程；安装器不会强杀。指定不同 `-State` 的安装使用独立的开始菜单目录与任务名，不覆盖默认安装的入口。控制服务和运行客户端都持有独占进程租约。设备身份与账本放在 `devices/<deviceId>` 中，解除配对只归档凭证，不删除旧状态。

macOS/Linux 可直接使用：

```sh
node client.cjs ui --state ~/.yesimbot-device --open
node client.cjs ui --state ~/.yesimbot-device --auto-start
node client.cjs quit --state ~/.yesimbot-device
```

可由自己的服务管理器运行 `ui --auto-start`，或用 `init`、`pair`、`run`、`unpair`、`diagnose`、`status` CLI。`status` 只报告本机身份是否已配置，不代表在线。手动安装须保证状态目录仅本人可读写。设置页使用当前用户私有随机令牌，拒绝外部 Origin/Host，不通过 URL 查询参数、HTML 或日志传递凭证。

## 能力

- 文件：`capabilities.files: true`；方法 `workspace.files.read/write/list/mkdir`。云端工作区选择 `storage.kind: device` 并填写 deviceId，仅文件权限即可使用。
- 命令行：`capabilities.shell: true`；方法 `computer.shell.exec`。云端工作区选择 `mode: computer`、明确 deviceId 并开启 shell。
- 桌面：配置 `capabilities.desktop.endpoint` 为**本机 loopback MCP SSE 服务**；方法 `computer.desktop.execute`。当前包不内置操作系统桌面服务，需要另行安装兼容的本机 MCP 驱动。看图模型和密钥在云端工作区配置。
- agent-desktop 桌面：配置 `capabilities.agentDesktop`（默认用客户端包里自带的 agent-desktop，也可用 `command` 指定绝对路径；`physicalInput` 控制被拒时是否用真实键鼠重试一次，不填时只有 Linux 会这样做，Mac 和 Windows 不动鼠标）；方法 `computer.desktop.ui`。先按无障碍元素树静默操作，被拒时再用真实键鼠重试一次；动作后附截图。与 `desktop` 驱动互斥，仍受设备策略与操作账本约束。macOS 需在“辅助功能”里授权一次。旧配置里的 `cua` 自动迁移为 `agentDesktop`。
- 远程桌面（可选）：`capabilities.remoteDesktop: { "port": 5900 }` 只连接本机 `127.0.0.1` 的 RFB/VNC 服务，并宣布 `desktop-stream`；还需要已配对的桌面能力和本机策略允许 `computer.desktop.remote`。这是独立的人工输入授权，不开放新的模型工具。托管 Linux 电脑镜像内置仅监听 loopback 的 x11vnc，不发布 VNC 端口；Windows/macOS 不会自动安装 VNC 服务，也不宣布未配置的能力。接管仍需云端独占租约，浏览器使用 noVNC，断线或租约到期关闭连接，输入不自动重放。旧客户端与进程内设备保留截图及原有适配；云电脑和各桌面平台需分别实机验收后再移除旧链路。
- 浏览器：在本机设置页勾选「浏览器」，填写连接地址（默认 `http://127.0.0.1:9222/`）；也可配置 `capabilities.browser.endpoint` 为本机 loopback Chromium CDP 根地址。私聊和群聊的工具列表中可分别选择「操作浏览器」（`computer.browser.execute`）。浏览器进程需独立启动，设置页提供 Windows Edge 的启动示例；使用独立用户目录和仅限本机的远程调试端口，不能填其他电脑的地址。可用「检查连接」确认是否就绪；Firefox 等桌面操作走 agent-desktop。浏览器能力除按元素操作外，还可 `screenshot` 截取标签页画面、`click_at` 按截图像素点击（验证码、画布），`type`/`hotkey` 给网页终端和画布逐键输入、发组合键，`scroll` 在画面某处转滚轮，`upload` 把会话目录或项目目录里的文件交给网页的文件框或文件选择按钮（不弹出系统窗口），不需要桌面能力，浏览器也可以运行在单独的虚拟屏幕上。已配对设备新增此能力时，先解除配对，再保存并重新配对；升级本身不会自动开放浏览器权限。
- 本机实例迁为执行端时，可设置 `capabilities.shellConversationDirectory: true`，让无显式 cwd 的命令继续使用对应会话的工作区。默认关闭以保留原有客户端行为。新增能力必须经过明确授权，不能仅改配置绕过已有配对能力限制。

## 发送与恢复

云端和本机都在产生副作用前持久化操作编号。重复编号返回记录或查询状态，未知结果不重发。更换设备不能再次执行旧操作编号。撤销立即关闭连接。

配对响应丢失时不要认为配对失败后一定没有设备：在「我的设备」检查并撤销不再使用的条目，再用新配对码。不得删除账本解决“不回复”；应查看 `unknown` 状态。

网关和迁移工具见仓库 `docs/device-architecture.md`。

## 从源码打包与发布下载

先在仓库执行 `yarn build`。普通跨平台包执行 `yarn device:pack`；带 Windows x64 运行环境的包执行：

```sh
node scripts/package-device-client.mjs --output .release-local/device-client/windows-x64 --windows-node v22.23.4
```

打包从 Node 官方下载固定版本，核验官方 SHA-256，并保存来源、许可证和 `SHA256SUMS`。ARM64 可另加 `--windows-arch arm64`，须分别验收。

宿主（`apps/server`）从状态目录的 `downloads/` 提供 `/downloads/client.json` 与版本固定的 ZIP 文件（`apps/server/src/downloads.ts`），清单不缓存，ZIP 永久缓存，其他文件名一律 404。下载信息使用 `version: 1`、可选的 HTTPS `gateway`，以及 `releases` 数组。每个条目包含 `platform`（`windows-x64` 或 `portable`）、站内 `/downloads/<文件名>.zip` 的 `url`、字节数 `size` 和完整 `sha256`。发布前校验包内容不含运行状态、凭证或用户数据；先发布不可变文件，最后更新清单。未发布清单的站点会显示下载暂不可用。

## 2026-11 升级说明：旧格式不再读取

新版客户端不再兼容下列旧文件和字段，遇到时按新格式校验，报出出错的字段，不会自动改写：

- 状态目录根下的 `identity.sqlite` 及同目录的旧扁平账本（`operations.sqlite` 等）。账本现在只在 `devices/<deviceId>/` 里，旧文件被忽略，已配对设备会得到一份空账本。升级后删掉根目录下这些旧文件，必要时重新配对。
- 设置文件里的 `capabilities.cua`、`capabilities.wechat`（设备不再承载微信）。删掉这两个字段；要用桌面能力就填 `capabilities.agentDesktop`（`{}` 即可）。
- 设置文件 `policy` 里的 `computer.desktop.cua`，改成 `computer.desktop.ui`。
- `policy.platforms.<平台>.accounts`，直接删掉。
