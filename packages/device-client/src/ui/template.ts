/** Local document. Credentials are never embedded in HTML. */
export const dashboardHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YesImBot · 我的电脑</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header>
<div>
<span class="brand">Y</span>
<strong>YesImBot</strong>
<span class="muted">我的电脑</span>
</div>
<span id="state" class="badge">读取状态…</span>
</header>
<main>
<section class="hero">
<p class="eyebrow">你的设备，由你授权</p>
<h1>把这台电脑接到机器人</h1>
<p>选择开放的能力和会话。关闭浏览器后，客户端继续在后台运行。</p>
<p id="identity" class="mono">
</p>
<div class="actions">
<button id="start" class="primary">启动连接</button>
<button id="stop">暂停连接</button>
<button id="diagnose">检查连接</button>
</div>
</section>
<div id="notice" role="status" hidden>
</div>
<section id="diagnostics" class="card" hidden>
<h2>连接检查</h2>
<ul id="checks">
</ul>
<p class="muted">只检查网络与服务，不发送消息，不截图。</p>
</section>
<fieldset id="settings">
<section class="card">
<div class="step">1</div>
<h2>连接服务</h2>
<label>设备网关地址<input id="gateway" type="url" placeholder="https://devices.example.com" autocomplete="off">
</label>
<p class="muted">由服务管理员提供，与你的控制台账号配套。</p>
<label>机器人网页地址<input id="console-url" type="url" placeholder="https://你的机器人站点/" autocomplete="off"></label>
<p class="muted">使用与手机、网页相同的机器人账号和会话。本客户端只接入这台电脑。</p>
<a id="open-chat" class="primary" target="_blank" rel="noopener noreferrer" hidden>打开对话</a>
</section>
<section class="card">
<div class="step">2</div>
<h2>开放哪些能力</h2>
<div class="cap-grid">
<label class="choice">
<input id="files" type="checkbox">
<span>
<strong>工作区文件</strong>
<small>访问按会话隔离的文件目录，以及下面填写的项目目录。</small>
</span>
</label>
<label class="choice">
<input id="shell" type="checkbox">
<span>
<strong>命令行</strong>
<small>运行系统命令，具有当前用户的电脑权限。</small>
</span>
</label>
<label class="choice">
<input id="browser" type="checkbox">
<span>
<strong>浏览器</strong>
<small>连接本机 Chrome 或 Edge，读取和操作网页。</small>
</span>
</label>
<label class="choice">
<input id="desktop" type="checkbox">
<span>
<strong>桌面操作</strong>
<small>查看屏幕、点击和输入，需本机桌面服务。</small>
</span>
</label>
</div>
<label>工作区文件夹<input id="workspace" placeholder="./workspaces">
</label>
<div id="files-options" hidden>
<label>项目目录<textarea id="project-roots" placeholder="每行一个绝对路径，例如 /home/me/code/my-app"></textarea>
</label>
<p class="muted">机器人的文件工具可以直接读写这些目录里的文件：改之前必须先读过，读完后文件又被改动就会拒绝写入。留空则只能使用按会话隔离的文件夹。命令行权限不受这里限制。</p>
</div>
<div id="browser-options" hidden>
<label>本机浏览器连接地址<input id="browser-endpoint" type="url" placeholder="http://127.0.0.1:9222/">
</label>
<p class="muted">先启动开启远程调试的 Chrome 或 Edge，再填它的本机 HTTP 地址。此权限只连接这个浏览器。</p>
<p class="muted">Windows 命令提示符示例：<code class="mono">start msedge --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="%LOCALAPPDATA%\\YesImBot-browser"</code>。macOS / Linux 用 Chrome / Chromium 搭配相同参数，并换成本机目录。</p>
<p class="muted">已配对的电脑新增浏览器能力时，需要先解除配对，保存设置后重新配对。</p>
</div>
<p id="native-desktop" class="muted" hidden>当前使用客户端附带的桌面服务，无需填写服务地址。</p>
<div id="desktop-options" hidden>
<label>本机桌面服务地址<input id="desktop-endpoint" placeholder="http://127.0.0.1:端口/sse">
</label>
<p class="muted">需要已安装的兼容 MCP 桌面服务。只启用文件能力时不需要它。</p>
</div>
</section>
<section class="card">
<div class="step">3</div>
<h2>哪些会话可以使用</h2>
<p class="muted">私聊与群聊独立配置。空的工具或授权列表表示全部拒绝。</p>
<div class="columns">
<div>
<label class="check">
<input id="direct-enabled" type="checkbox">允许私聊使用</label>
<div id="direct-tools" class="tool-list">
</div>
</div>
<div>
<label class="check">
<input id="group-enabled" type="checkbox">允许群聊使用</label>
<div id="group-tools" class="tool-list">
</div>
</div>
</div>
<h3>授权规则</h3>
<p class="muted">填写原生 ID；留空发送者表示该会话的所有人。群聊会检查本轮每个发送者。填写 * 表示显式允许全部。</p>
<div id="actors">
</div>
<div class="actions">
<button id="add-actor">添加规则</button>
</div>
</section>
<div class="save-bar">
<p>修改配置前请先暂停连接。增加能力或更换网关，需要先解除配对。</p>
<button id="save" class="primary">保存设置</button>
</div>
</fieldset>
<section class="card">
<div class="step">4</div>
<h2>绑定你的账号</h2>
<div id="pair-form">
<div class="columns">
<label>设备名称<input id="name" value="我的电脑" maxlength="128">
</label>
<label>一次性配对码<input id="code" autocomplete="off" spellcheck="false" placeholder="从云端控制台「我的设备」获取">
</label>
</div>
<button id="pair" class="primary">配对这台电脑</button>
<p class="muted">请先保存设置。成功后点击「启动连接」，并在云端工作区中选择这台设备。</p>
</div>
<div id="paired" hidden>
<p>这台电脑已绑定。重新配对将使用新的设备身份，旧的防重记录会保留。</p>
<button id="unpair" class="danger">撤销并解除配对</button>
</div>
</section>
<section id="update-card" class="card" hidden>
<h2>版本与更新</h2>
<p id="update-text" class="muted">
</p>
<label class="check">
<input id="update-auto" type="checkbox">自动更新：有新版本时自动下载，等手头的操作做完再重启，配对和设置都保留</label>
<div class="actions">
<button id="update-check">检查更新</button>
<button id="update-now" class="primary" hidden>立即更新</button>
</div>
</section>
<footer>
<span>本机控制页 · 只允许本机授权访问</span>
<button id="shutdown">退出客户端</button>
</footer>
</main>
<script src="/app.js" defer>
</script>
</body>
</html>`;
