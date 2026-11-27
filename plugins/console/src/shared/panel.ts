/** Overview DTOs shared by the server and the WebUI. */
export interface PanelPayload {
  generatedAt: string;
  health: { online: boolean; botCount: number; botErrorCount: number; memory: { app: number; total: number }; uptimeSeconds: number };
  model: {
    chatModel: string | null;
    visionModel: string | null;
    defaultChat: string | null;
    defaultEmbedding: string | null;
    providers: string[];
    chatModels: number;
    embeddingModels: number;
    imageInput: boolean;
    imageBudget: { maxCount: number; maxBytesPerImage: number; maxTotalBytes: number } | null;
    describeImage: boolean;
  };
  config: { basePath: string; allowedChannels: number; configPath: string };
  plugins: PanelPlugin[];
  adapters: PanelAdapter[];
  onboarding: PanelOnboarding;
  recent: PanelRecent[];
  attention: PanelIssue[];
}

export interface PanelPlugin {
  key: string;
  label: string;
  enabled: boolean;
  status: "enabled" | "disabled" | "attention";
  detail: string;
  configPath: string;
}

export interface PanelAdapter {
  key: string;
  name: string;
  platform: string;
  enabled: boolean;
  /** `offline`: connected, but the platform reports the account itself offline (QQ kicked off, per NapCat). */
  state: "disabled" | "unconfigured" | "configured" | "error" | "offline" | "online";
  configPath: string;
  error?: string;
  /** The account's own picture (an http(s) URL from the platform), while its bot is known. */
  avatar?: string;
}

export interface PanelIssue {
  level: "error" | "warning";
  message: string;
}

export interface PanelRecent {
  timestamp: string;
  level: "error";
  type: string;
  message: string;
  channel: string;
}

export interface PanelOnboardingStep {
  id: "adapter" | "model" | "role" | "channels";
  title: string;
  description: string;
  target: string;
  done: boolean;
}

export interface PanelOnboarding {
  complete: boolean;
  steps: PanelOnboardingStep[];
}
