import { defineErrors } from "@yesimbot/foundation";

/**
 * Configuration and credential failures say which category failed, never the file or value behind it. What an MCP
 * server answered stays in the log: the model reads the registered sentence.
 */
export const MCP_ERRORS = defineErrors({
  mcp_token_path_empty: { model: "令牌文件路径是空的。", user: "令牌文件必须填写非空路径。", status: 400 },
  mcp_token_unreadable: { model: "令牌文件不可读或不存在。", user: "令牌文件不可读或不存在。", status: 400 },
  mcp_token_not_file: { model: "令牌路径不是普通文件。", user: "令牌路径不是普通文件。", status: 400 },
  mcp_token_mode: { model: "令牌文件权限不是只有主人能读。", user: "令牌文件权限不是只有主人能读（要求 600 或更严格）。", status: 400 },
  mcp_token_owner: { model: "令牌文件的所有者与运行进程不一致。", user: "令牌文件的所有者与运行进程不一致。", status: 400 },
  mcp_token_empty: { model: "令牌文件是空的。", user: "令牌文件是空的。", status: 400 },
  mcp_token_multiline: { model: "令牌文件必须只有一行令牌。", user: "令牌文件必须只有一行令牌。", status: 400 },
  mcp_auth_conflict: {
    model: "令牌文件和 Authorization 请求头不能同时配置。",
    user: "令牌文件和 Authorization 请求头不能同时配置。",
    status: 400,
  },
  mcp_connect_failed: { model: "MCP 服务器连不上。", user: "MCP 服务器连不上，请检查服务器设置。", status: 502, retryable: true },
  mcp_tool_failed: { model: "这个 MCP 工具执行失败了，结果不确定。不要自动重试有副作用的工具。", user: "MCP 工具执行失败。", status: 502 },
  mcp_call_failed: { model: "没能调用这个 MCP 工具，结果不确定。不要自动重试有副作用的工具。", user: "没能调用 MCP 工具。", status: 502, retryable: true },
  mcp_confirmation_args_unsupported: { model: "调用参数无法规范化，无法建立确认。", user: "调用参数无法规范化。", status: 400 },
});
