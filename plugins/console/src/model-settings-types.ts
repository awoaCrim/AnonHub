export type ModelCapability = "text" | "tool" | "image";

export type ModelCapabilityFailure =
  | "authentication"
  | "permission"
  | "quota"
  | "context_limit"
  | "rate_limit"
  | "unavailable"
  | "invalid_request"
  | "invalid_response"
  | "network"
  | "timeout"
  | "cancelled"
  | "invalid_result";

/** The managed editor's public contract. Stored credentials and opaque SDK options never leave the server. */
export interface ModelSettingsModel {
  /** Revision-bound identity for preserving native options when renaming. Omit for new models. */
  key?: string;
  id: string;
  toolCall?: boolean;
  reasoning?: boolean;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
}

export interface ModelSettingsOptions {
  format?: "chat" | "responses";
  webSearch?: boolean;
  thinking?: "auto" | "none" | "low" | "medium" | "high" | "xhigh" | "max";
  imageToolResultSupport?: "native" | "unsupported" | "unknown";
  imageToolResultPlacement?: "tool-output" | "user-message";
  imageToolResultMediaTypes?: string[];
}

/** Images API models are separate from chat models that understand pictures. */
export interface ModelSettingsImageModel {
  key?: string;
  id: string;
  name?: string;
  hidden?: boolean;
}

export interface ModelSettingsConnection {
  key: string;
  enabled: boolean;
  type: string;
  id: string;
  baseURL: string;
  hasApiKey: boolean;
  /** Input only. Omission retains the saved credential. An explicit string replaces it. */
  apiKey?: string;
  chatModels: ModelSettingsModel[];
  embeddingModels: ModelSettingsModel[];
  /** Older clients may omit this table; omission preserves the saved Images models. */
  imageModels?: ModelSettingsImageModel[];
  options: ModelSettingsOptions;
  registered?: boolean;
}

export interface ModelSettingsRoles {
  chatModel: string;
  auxiliaryModel: string;
  visionModel: string;
  embeddingModel: string;
  /** Omission from an older client preserves the saved choice; an empty value disables generation. */
  imageModel?: string;
  /** Empty follows imageModel. */
  imageEditModel?: string;
}

export interface ModelSettingsSave {
  revision: string;
  connections: ModelSettingsConnection[];
  roles: ModelSettingsRoles;
  /** Ordered background-worker model references. Omission retains the saved list; empty follows the current model. */
  taskModels?: string[];
}

export interface ModelSettingsSnapshot extends ModelSettingsSave {
  writable: boolean;
  contextManaged?: boolean;
  reason?: string;
}

/** Lists a provider's models. Without `apiKey`, the saved key of connection `key` is used if its address is unchanged. */
export interface ModelProbeRequest {
  type: string;
  baseURL: string;
  apiKey?: string;
  key?: string;
}

export interface ModelProbeResult {
  ok: boolean;
  models: string[];
  /** `forbidden` is set by the browser client when the console itself refused the request (session or origin). */
  error?: "invalid_request" | "missing_key" | "unauthorized" | "not_found" | "timeout" | "network" | "bad_response" | "rate_limited" | "forbidden";
}

export interface ModelCapabilityProbeRequest {
  /** Saved connection only: capability checks run through the registered ModelService route. */
  key: string;
  model: string;
  capabilities: ModelCapability[];
}

export interface ModelCapabilityCheck {
  capability: ModelCapability;
  ok: boolean;
  error?: ModelCapabilityFailure;
  elapsedMs: number;
  requestIds: string[];
  /** An observed reasoning part is evidence; its absence does not prove lack of reasoning support. */
  reasoningObserved?: boolean;
}

export interface ModelCapabilityProbeResult {
  ok: boolean;
  checks: ModelCapabilityCheck[];
  error?: "invalid_request" | "not_registered" | "rate_limited" | "forbidden" | "network";
}
