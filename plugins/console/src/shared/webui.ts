/** WebUI bootstrap DTOs shared by the server and the browser app. */
export interface WebUIFeatures {
  napcat: boolean;
  /** WeChat QR login through the agent-wechat daemon in this runtime container. */
  wechat: boolean;
  accounts: boolean;
  tenant: boolean;
  usage: boolean;
}

export interface BootstrapResponse {
  authenticated: boolean;
  session?: { username: string; role: "owner" | "member"; expiresAt: number };
  features: WebUIFeatures;
}

export interface SystemSnapshot {
  port: number | null;
  host: string;
  baseDir: string;
  nodeVersion: string;
  /** Process uptime in seconds. */
  uptime: number;
}

export interface WebUILogEntry {
  id: number;
  timestamp: number;
  level: "success" | "error" | "info" | "warn" | "debug";
  name: string;
  content: string;
}

export interface LogsSnapshot {
  entries: WebUILogEntry[];
}
