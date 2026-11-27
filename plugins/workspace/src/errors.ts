import { defineErrors } from "@yesimbot/foundation";

/**
 * Workspace's own failures. Tools keep reporting their documented `error` strings (`invalid_path`, `html_file_too_large`
 * and so on); these codes cover what is thrown to the host: startup configuration, resource reads and device calls.
 */
export const WORKSPACE_ERRORS = defineErrors({
  workspace_shared_path_required: { model: "共享文件空间缺少存储路径。", user: "共享文件空间缺少存储路径。", status: 500 },
  workspace_not_started: { model: "工作区插件尚未启动。", user: "工作区插件尚未启动。", status: 503 },
  workspace_identity_unavailable: { model: "当前会话的工作区身份不可用。", user: "当前会话的工作区身份不可用。", status: 500 },
  workspace_read_denied: { model: "当前会话没有读取工作区文件的权限。", user: "当前会话没有读取工作区文件的权限。", status: 403 },
  workspace_uri_invalid: { model: "文件地址格式不对。", user: "文件地址格式不对。", status: 400 },
  workspace_skill_not_found: { model: "没有这个技能。", user: "没有这个技能。", status: 404 },
  workspace_path_escapes_root: { model: "路径超出了允许的目录。", user: "路径超出了允许的目录。", status: 400 },
  workspace_resource_not_file: { model: "这个路径不是文件。", user: "这个路径不是文件。", status: 400 },
  workspace_resource_too_large: { model: "文件超过读取上限。", user: "文件超过读取上限。", status: 413 },
  workspace_skill_mount_reserved: { model: "/skills 是技能保留的挂载点。", user: "/skills 是技能保留的挂载点，请换一个目录。", status: 500 },
  workspace_mount_invalid: { model: "沙箱挂载配置不正确。", user: "沙箱挂载配置不正确，详见日志。", status: 500 },
  workspace_html_renderer_url_invalid: {
    model: "HTML 渲染服务地址必须是不带账号密码的 HTTP(S) 地址。",
    user: "HTML 渲染服务地址必须是不带账号密码的 HTTP(S) 地址。",
    status: 500,
  },
  workspace_desktop_model_unusable: {
    model: "视觉操作模型的连接不能把工具结果里的截图交给模型。",
    user: "视觉操作模型的连接不能把工具结果里的截图交给模型，请换一个模型。",
    status: 500,
  },
  workspace_desktop_failed: { model: "桌面截图失败。", user: "桌面截图失败。", status: 502 },
  workspace_desktop_screenshot_invalid: { model: "桌面返回的截图格式不对。", user: "桌面返回的截图格式不对。", status: 502 },
  workspace_device_file_unavailable: { model: "设备上的文件读取失败。", user: "设备上的文件读取失败。", status: 502 },
  workspace_device_file_too_large: { model: "设备上的文件超过读取上限。", user: "设备上的文件超过读取上限。", status: 413 },
  workspace_device_file_invalid: { model: "设备返回的文件内容格式不对。", user: "设备返回的文件内容格式不对。", status: 502 },
  workspace_git_method_not_allowed: { model: "git 只允许 GET、HEAD 和 POST 请求。", user: "git 只允许 GET、HEAD 和 POST 请求。", status: 400 },
});
