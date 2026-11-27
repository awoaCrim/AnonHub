/** Bundled local asset; no external requests or runtime asset directory. */
export const dashboardScript = String.raw`
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const token = location.hash.slice(1) || sessionStorage.getItem("yesimbot-local-token") || "";
  if (token) sessionStorage.setItem("yesimbot-local-token", token);
  history.replaceState(null, "", "/");
  const methods = [["*", "全部工具（包含以后新增工具）"], ["workspace.files.read", "读取文件"], ["workspace.files.write", "写入文件"], ["workspace.files.list", "列出文件"], ["workspace.files.mkdir", "创建文件夹"], ["computer.shell.exec", "运行系统命令"], ["computer.browser.execute", "操作浏览器"], ["computer.desktop.execute", "操作桌面（MCP）"], ["computer.desktop.ui", "操作桌面"]];
  const errors = { local_session_required: "本机访问凭证已失效，请重新打开客户端。", stop_before_editing: "请先暂停连接，再修改设置。", config_changed: "设置已在另一个窗口修改，请刷新后重试。", unpair_before_expanding_capabilities: "增加能力或更换网关前，请先撤销并解除配对。", device_already_paired: "设备已绑定，请勿重复配对。", invalid_pairing_input: "请检查配对码和设备名称。", select_capabilities_first: "请先选择至少一种能力并保存。", pair_before_starting: "请先配对这台电脑。", pairing_failed: "配对未确认。请在云端检查是否已有新设备，再决定是否生成新码。", revocation_not_confirmed: "暂未确认撤销，凭证和账本已保留，请检查网络后重试。", device_client_already_running: "已有客户端使用此状态目录，请先关闭另一个客户端。", local_desktop_endpoint_required: "浏览器或桌面服务必须使用本机 HTTP 地址。", browser_endpoint_root_required: "浏览器地址只填 http://127.0.0.1:端口/，不要带页面路径。", client_action_failed: "操作未完成，请检查必填设置、地址和服务状态。" };
  let base, revision = "", busy = false, current, dirty = false, exiting = false;
  function notice(text, error = false) {
    $("notice").hidden = !text;
    $("notice").textContent = text;
    $("notice").className = error ? "error" : "";
  }
  async function api(path, body) {
    const response = await fetch("/api/" + path, { method: body === void 0 ? "GET" : "POST", headers: { Authorization: "Bearer " + token, ...body === void 0 ? {} : { "Content-Type": "application/json" } }, body: body === void 0 ? void 0 : JSON.stringify(body), cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw Error(errors[result.error] || errors.client_action_failed);
    return result;
  }
  function capabilities() {
    return { files: $("files").checked, shell: $("shell").checked, browser: $("browser").checked, desktop: $("desktop").checked };
  }
  function available(method) {
    const c = capabilities();
    return method === "*" ? Object.values(c).some(Boolean) : method.startsWith("workspace.") ? c.files : method.startsWith("computer.shell") ? c.shell : method.startsWith("computer.browser") ? c.browser : method.startsWith("computer.desktop") ? c.desktop && (method === "computer.desktop.ui" ? nativeDesktop() : !nativeDesktop()) : false;
  }
  let nativeDesktopAvailable = false;
  function nativeDesktop() {
    return !!(base?.capabilities.agentDesktop || (nativeDesktopAvailable && !base?.capabilities.desktop));
  }
  function updateCapabilities() {
    $("files-options").hidden = !$("files").checked;
    $("browser-options").hidden = !$("browser").checked;
    $("desktop-options").hidden = !$("desktop").checked || nativeDesktop();
    $("native-desktop").hidden = !$("desktop").checked || !nativeDesktop();
    document.querySelectorAll("[data-method]").forEach((input) => {
      input.closest("label").hidden = !available(input.dataset.method);
      const all = document.querySelector('[data-kind="' + input.dataset.kind + '"][data-method="*"]');
      input.disabled = input.dataset.method !== "*" && all.checked;
    });
  }
  for (const kind of ["direct", "group"]) for (const [method, label] of methods) {
    const row = document.createElement("label"), input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.method = method;
    input.dataset.kind = kind;
    row.append(input, document.createTextNode(label));
    $(kind + "-tools").append(row);
  }
  function actor(rule = { kind: "direct", platform: "onebot", conversationId: "" }) {
    const row = document.createElement("div");
    row.className = "actor";
    for (const [key, label] of [["kind", "类型"], ["platform", "平台"], ["conversationId", "会话 ID"], ["botId", "机器人 ID（可选）"], ["userId", "发送者 ID（可选）"]]) {
      const field = document.createElement("label");
      field.textContent = label;
      const input = document.createElement(key === "kind" ? "select" : "input");
      input.dataset.field = key;
      if (key === "kind") for (const [value, text] of [["direct", "私聊"], ["group", "群聊"], ["any", "两者"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        input.append(option);
      }
      input.value = rule[key] || "";
      field.append(input);
      row.append(field);
    }
    const remove = document.createElement("button");
    remove.textContent = "移除规则";
    remove.onclick = () => {
      row.remove();
      dirty = true;
    };
    row.append(remove);
    $("actors").append(row);
  }
  function fill(config, nativeAvailable) {
    nativeDesktopAvailable = nativeAvailable === true;
    base = config;
    $("gateway").value = config.gateway || "";
    $("console-url").value = config.consoleUrl || "";
    $("open-chat").hidden = !config.consoleUrl;
    if(config.consoleUrl) $("open-chat").href = config.consoleUrl;
    $("workspace").value = config.workspaceRoot || "./workspaces";
    $("project-roots").value = (config.capabilities.projectRoots || []).join("\n");
    for (const name of ["files", "shell", "browser"]) $(name).checked = !!config.capabilities[name];
    $("desktop").checked = !!(config.capabilities.desktop || config.capabilities.agentDesktop);
    $("browser-endpoint").value = config.capabilities.browser?.endpoint || "http://127.0.0.1:9222/";
    $("desktop-endpoint").value = config.capabilities.desktop?.endpoint || "";
    for (const kind of ["direct", "group"]) {
      $(kind + "-enabled").checked = config.policy[kind].enabled;
      document.querySelectorAll('[data-kind="' + kind + '"]').forEach((input) => input.checked = config.policy[kind].tools.includes(input.dataset.method));
    }
    $("actors").replaceChildren();
    config.policy.actors.forEach(actor);
    updateCapabilities();
    dirty = false;
  }
  function form() {
    const config = structuredClone(base), caps = capabilities();
    config.gateway = $("gateway").value.trim();
    if($("console-url").value.trim()) config.consoleUrl = $("console-url").value.trim(); else delete config.consoleUrl;
    config.workspaceRoot = $("workspace").value.trim();
    config.capabilities = { ...base.capabilities, files: caps.files, shell: caps.shell };
    // One path per line: a path may contain commas.
    const roots = [...new Set($("project-roots").value.split("\n").map((v) => v.trim()).filter(Boolean))];
    if (caps.files && roots.length) config.capabilities.projectRoots = roots;
    else delete config.capabilities.projectRoots;
    if (caps.browser) config.capabilities.browser = { endpoint: $("browser-endpoint").value.trim() };
    else delete config.capabilities.browser;
    if (caps.desktop && nativeDesktop()) { config.capabilities.agentDesktop = base.capabilities.agentDesktop || {}; delete config.capabilities.desktop; }
    if (caps.desktop && !nativeDesktop()) config.capabilities.desktop = { endpoint: $("desktop-endpoint").value.trim() };
    if (!caps.desktop) for (const name of ["desktop", "agentDesktop", "cua"]) delete config.capabilities[name];
    for (const kind of ["direct", "group"]) {
      const selected = [...document.querySelectorAll('[data-kind="' + kind + '"]')].filter((input) => input.checked && available(input.dataset.method)).map((input) => input.dataset.method);
      config.policy[kind] = { enabled: $(kind + "-enabled").checked, tools: selected.includes("*") ? ["*"] : selected };
    }
    config.policy.actors = [...$("actors").children].map((row) => Object.fromEntries([...row.querySelectorAll("[data-field]")].filter((input) => input.value.trim()).map((input) => [input.dataset.field, input.value.trim()])));
    return config;
  }
  const updateErrors = { gateway_not_configured: "还没填设备网关地址。", gateway_not_https: "设备网关不是 HTTPS 地址，不能自动更新。", update_site_unavailable: "暂时连不上下载站，稍后会再试。", invalid_release_manifest: "下载站的版本信息看不懂，稍后会再试。", release_signature_invalid: "新版本的签名不对，已拒绝安装。", update_download_mismatch: "下载的文件不完整，稍后会再试。", update_download_too_large: "下载的文件不对，已放弃。", update_failed_to_start: "新版本没能启动，继续用现在的版本。" };
  function newer(a, b) {
    const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  }
  function renderUpdate(update) {
    $("update-card").hidden = !update;
    if (!update) return;
    const available = update.latest && newer(update.latest, update.version);
    const checked = update.checkedAt ? "（" + new Date(update.checkedAt).toLocaleString("zh-CN", { hour12: false }) + " 检查）" : "";
    const texts = {
      checking: "正在检查新版本…",
      downloading: "正在下载新版本 " + (update.latest || "") + "…",
      installing: "正在安装新版本…",
      waiting: "新版本 " + (update.latest || "") + " 已准备好，等手头的操作做完就自动重启。",
      restarting: "正在重启到新版本。这个页面会断开，过几秒重新打开客户端设置就行。",
      error: "当前版本 " + update.version + "。上次更新没成功：" + (updateErrors[update.error] || "稍后会再试。"),
    };
    $("update-text").textContent = !update.supported
      ? "当前是从源码运行的版本，不会自动更新。"
      : texts[update.status] || (available ? "当前版本 " + update.version + "，有新版本 " + update.latest + (update.auto ? "，会自动安装。" : "。") : "当前版本 " + update.version + "，已是最新" + checked + "。");
    $("update-auto").checked = update.auto;
    const working = ["checking", "downloading", "installing", "waiting", "restarting"].includes(update.status);
    $("update-auto").disabled = busy || !update.supported;
    $("update-check").disabled = busy || working || !update.supported;
    $("update-now").hidden = !available || working;
    $("update-now").disabled = busy;
  }
  function renderState(state) {
    current = state;
    renderUpdate(state.update);
    const names = { stopped: "已暂停", connecting: "连接中 · 离线时自动重连", online: "网关已连接", revoked: "授权已撤销" };
    $("state").textContent = names[state.state] || state.state;
    $("state").className = "badge " + state.state;
    $("identity").textContent = state.deviceId ? "设备 ID：" + state.deviceId : "";
    $("pair-form").hidden = state.paired;
    $("paired").hidden = !state.paired;
    const running = state.state !== "stopped";
    $("settings").disabled = busy || running;
    $("start").disabled = busy || running || !state.paired;
    $("stop").disabled = busy || !running;
    for (const id of ["pair", "unpair", "diagnose", "shutdown"]) $(id).disabled = busy;
  }
  async function refresh() {
    renderState(await api("snapshot"));
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    notice("");
    if (current) renderState(current);
    try {
      await fn();
      if (!exiting) await refresh();
    } catch (error) {
      notice(error.message, true);
    } finally {
      busy = false;
      if (current && !exiting) renderState(current);
    }
  }
  $("settings").addEventListener("input", () => {
    dirty = true;
    updateCapabilities();
  });
  for (const id of ["files", "shell", "browser", "desktop"]) $(id).onchange = updateCapabilities;
  $("add-actor").onclick = () => {
    actor();
    dirty = true;
  };
  $("save").onclick = () => action(async () => {
    await api("config", { config: form(), revision });
    const loaded = await api("config");
    revision = loaded.revision;
    fill(loaded.config, loaded.nativeDesktopAvailable);
    notice("设置已保存。");
  });
  $("pair").onclick = () => action(async () => {
    if (dirty) throw Error("请先保存修改后的设置。");
    await api("pair", { code: $("code").value.trim(), name: $("name").value.trim() });
    $("code").value = "";
    notice("配对成功，可以启动连接。");
  });
  $("unpair").onclick = () => {
    if (confirm("撤销这台设备的连接授权并解除本机配对？旧账本会保留。")) action(async () => {
      await api("unpair", {});
      notice("授权已撤销，旧记录已保留。现在可修改能力并重新配对。");
    });
  };
  $("start").onclick = () => action(async () => {
    if (dirty) throw Error("请先保存修改后的设置。");
    await api("start", {});
  });
  $("stop").onclick = () => action(async () => {
    await api("stop", {});
    notice("已暂停连接。正在执行的操作会取消，未知结果不会自动重做。");
  });
  $("diagnose").onclick = () => action(async () => {
    if (dirty) throw Error("请先保存设置，再检查连接。");
    const results = await api("diagnose", {});
    $("checks").replaceChildren();
    for (const result of results) {
      const item = document.createElement("li");
      item.textContent = (result.ok ? "✓ " : "! ") + result.message;
      $("checks").append(item);
    }
    $("diagnostics").hidden = false;
  });
  $("update-check").onclick = () => action(async () => {
    renderUpdate(await api("update/check", {}));
  });
  $("update-now").onclick = () => action(async () => {
    renderUpdate(await api("update/check", { install: true }));
  });
  $("update-auto").onchange = () => {
    const auto = $("update-auto").checked;
    // Keep the box as clicked while the request runs; the reply confirms it.
    if (current && current.update) current.update.auto = auto;
    action(async () => {
      renderUpdate(await api("update/auto", { auto }));
    });
  };
  $("shutdown").onclick = () => {
    if (confirm("退出客户端并断开设备连接？")) action(async () => {
      await api("shutdown", {});
      exiting = true;
      clearInterval(timer);
      $("state").textContent = "已退出";
      $("settings").disabled = true;
      document.querySelectorAll("button").forEach((button) => button.disabled = true);
      notice("客户端已退出，可以关闭此页。");
    });
  };
  const timer = setInterval(() => {
    if (!document.hidden && !busy) refresh().catch(() => {
      $("state").textContent = "客户端已退出或无法访问";
    });
  }, 3e3);
  if (!token) {
    notice("请从本机客户端入口打开此页。", true);
    $("settings").disabled = true;
    clearInterval(timer);
    return;
  }
  Promise.all([api("config"), api("snapshot")]).then(([loaded, state]) => {
    revision = loaded.revision;
    fill(loaded.config, loaded.nativeDesktopAvailable);
    renderState(state);
  }).catch((error) => notice(error.message, true));
})();
`;
