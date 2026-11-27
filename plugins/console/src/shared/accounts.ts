export const OPS_PROGRAM_STATES: readonly OpsProgramState[] = ["RUNNING", "STARTING", "STOPPED", "STOPPING", "BACKOFF", "EXITED", "FATAL", "UNKNOWN"];

/** Public DTOs only; never add credentials or manager capabilities. */
export type AccountRole = "owner" | "member";

export type OpsProgramState = "RUNNING" | "STARTING" | "STOPPED" | "STOPPING" | "BACKOFF" | "EXITED" | "FATAL" | "UNKNOWN";

export type OpsProgramName = "koishi" | "napcat";

export interface AccountSession {
  enabled: boolean;
  authenticated: boolean;
  username?: string;
  expiresAt?: number;
  accountId?: string;
  role?: AccountRole;
}

export interface RuntimeView {
  id: string;
  state: "setup-required" | "starting" | "running" | "stopping" | "stopped" | "error";
  qqAccount?: string;
  errorCode?: string;
  updatedAt?: string;
  location?: "local" | "server";
  name?: string;
  version?: string;
  policyVersion?: string;
}

export interface AccountView {
  id: string;
  username: string;
  enabled: boolean;
  createdAt: string;
  /** Optional plugins this member may enable. Required plugins are always available. */
  plugins: string[];
  runtime: RuntimeView;
}

export interface CreateAccountInput {
  username: string;
  password: string;
  qqAccount?: string;
  /** Omitted means every optional plugin. */
  plugins?: string[];
}

export interface AccountsResponse {
  accounts: AccountView[];
}

export interface AccountResponse {
  account: AccountView;
}

export interface RuntimeResponse {
  runtime: RuntimeView;
}

/** Compact health of one bot. `null` fields are unknown (source unavailable), never a fabricated zero. */
export interface BotSummary {
  qqOnline: boolean | null;
  modelReady: boolean | null;
  /** `null` also when the roleplay plugin is not installed. */
  roleReady: boolean | null;
  allowedChannels: number | null;
  todayCalls: number | null;
  /** Epoch milliseconds of the newest conversation activity. */
  lastActivityAt: number | null;
  attention: number | null;
  /** Details below are absent from runtimes that predate them. */
  chatModel?: string | null;
  todayTokens?: number | null;
  /** Labels of enabled plugins. */
  plugins?: string[];
  /** Attention messages, at most five. */
  issues?: string[];
  /** Recent delivery failures. */
  failures?: number | null;
  conversations?: number | null;
  uptimeSeconds?: number | null;
  /** Newest conversations, at most five. */
  recent?: BotRecentChat[];
}

export interface BotRecentChat {
  type: "channel" | "guild" | "direct";
  channelId: string;
  at: number;
}

export interface AccountHealth {
  id: string;
  health: BotSummary | null;
  error?: "not_running" | "timeout" | "unreachable";
}

export interface OpsProgram {
  state: OpsProgramState;
  pid?: number;
  uptimeSeconds?: number;
}

/** What the host manager knows about one instance's container. Absent fields are unknown. */
export interface OpsInstance {
  /** "owner" or the friend's account ID. */
  target: string;
  container: { name: string; running: boolean; startedAt?: string };
  memory?: { usedBytes: number; limitBytes: number };
  cpuPercent?: number;
  programs: { koishi?: OpsProgram; napcat?: OpsProgram };
  release?: { commit: string; deployId?: string; deployedAt?: string };
}

export interface OpsSnapshot {
  owner?: OpsInstance;
  accounts: Record<string, OpsInstance>;
}

export interface InstanceRestartInput {
  target: string;
  program: OpsProgramName;
}

export interface InstanceRestartResponse {
  /** Restarting the owner's own bot is accepted and carried out after the reply. */
  accepted?: boolean;
  instance?: OpsInstance;
}

export interface AccountsHealthResponse {
  generatedAt: string;
  /** The owner's own bot. */
  owner: BotSummary | null;
  accounts: AccountHealth[];
  /** Container-level state from the host manager; `null` when the manager cannot be reached. */
  ops?: OpsSnapshot | null;
}
