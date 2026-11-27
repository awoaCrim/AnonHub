import { readFile, stat } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppError, logger } from "@yesimbot/foundation";

import { MCP_ERRORS } from "./errors.js";
import type { McpClientTransport, McpHttpServer, McpServer, McpSseServer, McpStdioServer } from "./types.js";

const log = logger("yesimbot.mcp-client");

export async function connectMcpServer(name: string, server: McpServer): Promise<{ client: Client; transport: McpClientTransport }> {
  log.info("server.connecting", { server: name, type: server.type });

  switch (server.type) {
    case "stdio":
      return await connectToStdioServer(name, server);
    case "http":
      return await connectToHttpServer(name, server);
    case "sse":
      return await connectToSseServer(name, server);
  }
}

export function parseKeyValueString(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = input.split("\n");

  for (const line of lines) {
    const colon = line.indexOf(":");
    const equals = line.indexOf("=");
    const delimiter = colon === -1 ? equals : equals === -1 ? colon : Math.min(colon, equals);

    if (delimiter > -1) {
      const key = line.slice(0, delimiter).trim();
      if (!key) continue;
      result[key] = line.slice(delimiter + 1).trim();
    }
  }

  return result;
}

/** Resolves the configured headers without exposing any value to logs. */
export function parseHeaders(input: Record<string, string> | string | undefined): Record<string, string> {
  return typeof input === "string" ? parseKeyValueString(input) : { ...(input ?? {}) };
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

/** A server URL as it may appear in logs: no credentials, query or fragment, which can carry tokens. */
export function loggableUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid url]";
  }
}

/** Removes every literal occurrence of a secret from a message before it can reach a logger. */
export function redactSecret(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    result = result.split(secret).join("[redacted]");
  }
  return result;
}

/**
 * Reads a Bearer token from an owner-only file. Every failure mode is fail-closed and reports only the
 * category, never the file content.
 */
export async function readBearerTokenFile(path: string): Promise<string> {
  if (path.trim().length === 0) {
    throw new AppError(MCP_ERRORS.mcp_token_path_empty, { effect: "none" });
  }

  let mode: number;
  let uid: number;
  let isFile: boolean;
  try {
    const stats = await stat(path);
    mode = stats.mode;
    uid = stats.uid;
    isFile = stats.isFile();
  } catch (cause) {
    throw new AppError(MCP_ERRORS.mcp_token_unreadable, { effect: "none", cause });
  }

  if (!isFile) {
    throw new AppError(MCP_ERRORS.mcp_token_not_file, { effect: "none" });
  }
  if ((mode & 0o077) !== 0) {
    throw new AppError(MCP_ERRORS.mcp_token_mode, { effect: "none" });
  }
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new AppError(MCP_ERRORS.mcp_token_owner, { effect: "none" });
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    throw new AppError(MCP_ERRORS.mcp_token_unreadable, { effect: "none", cause });
  }

  const token = raw.trim();
  if (token.length === 0) {
    throw new AppError(MCP_ERRORS.mcp_token_empty, { effect: "none" });
  }
  if (/\s/.test(token)) {
    throw new AppError(MCP_ERRORS.mcp_token_multiline, { effect: "none" });
  }

  return token;
}

async function connectToStdioServer(name: string, server: McpStdioServer): Promise<{ client: Client; transport: StdioClientTransport }> {
  log.info("server.stdio_starting", { server: name, command: server.command });
  const env = typeof server.env === "string" ? parseKeyValueString(server.env) : server.env;
  // Environment values may carry credentials; log the configured field names only.
  log.debug("server.stdio_env", { server: name, fields: Object.keys(env ?? {}) });

  const transport = new StdioClientTransport({ command: server.command, args: server.args, env });
  const client = new Client({ name, version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (cause) {
    const secrets = [...Object.values(env ?? {}), ...(server.args ?? [])];
    throw connectFailure("STDIO", cause, secrets);
  }
  return { client, transport };
}

async function connectToHttpServer(name: string, server: McpHttpServer): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  return connectToRemoteServer(name, "HTTP", server, StreamableHTTPClientTransport);
}

async function connectToSseServer(name: string, server: McpSseServer): Promise<{ client: Client; transport: SSEClientTransport }> {
  return connectToRemoteServer(name, "SSE", server, SSEClientTransport);
}

async function connectToRemoteServer<TTransport extends StreamableHTTPClientTransport | SSEClientTransport>(
  name: string,
  protocol: "HTTP" | "SSE",
  server: McpHttpServer | McpSseServer,
  Transport: new (url: URL, options: { requestInit: { headers: Record<string, string> } }) => TTransport,
): Promise<{ client: Client; transport: TTransport }> {
  log.info("server.remote_starting", { server: name, protocol, url: loggableUrl(server.url) });

  const headers = parseHeaders(server.headers);
  const tokenFile = typeof server.bearerTokenFile === "string" && server.bearerTokenFile.length > 0 ? server.bearerTokenFile : undefined;

  // Two competing Authorization sources are ambiguous; refuse instead of guessing an order.
  if (tokenFile !== undefined && hasHeader(headers, "authorization")) {
    throw new AppError(MCP_ERRORS.mcp_auth_conflict, { effect: "none" });
  }

  const token = tokenFile === undefined ? undefined : await readBearerTokenFile(tokenFile);
  const requestHeaders = token === undefined ? headers : { ...headers, Authorization: `Bearer ${token}` };
  // Header values may carry credentials; log the configured field names only.
  log.debug("server.remote_headers", { server: name, protocol, fields: Object.keys(requestHeaders) });

  const transport = new Transport(new URL(server.url), { requestInit: { headers: requestHeaders } });
  const client = new Client({ name, version: "1.0.0" });

  try {
    await client.connect(transport);
  } catch (cause) {
    // Upstream errors are re-emitted through a redactor so a secret cannot leak through a stack message.
    throw connectFailure(protocol, cause, collectSecretValues(requestHeaders));
  }

  return { client, transport };
}

/**
 * The failure of a connection. The transport's own message can echo a credential, so it is redacted before it becomes
 * the cause (the stack of the original is dropped with it); `errorFields` then writes only the redacted text.
 */
function connectFailure(protocol: "STDIO" | "HTTP" | "SSE", cause: unknown, secrets: readonly string[]): AppError {
  const reason = redactSecret(cause instanceof Error ? cause.message : String(cause), secrets);
  return new AppError(MCP_ERRORS.mcp_connect_failed, { effect: "none", detail: `${protocol}: ${reason}`, cause: new Error(reason) });
}

function collectSecretValues(headers: Record<string, string>): string[] {
  return Object.entries(headers).flatMap(([name, value]) => {
    const bearer = name.toLowerCase() === "authorization" ? /^Bearer\s+(.+)$/i.exec(value.trim()) : undefined;
    return bearer?.[1] ? [value, bearer[1]] : [value];
  });
}

export type { McpServer } from "./types.js";
