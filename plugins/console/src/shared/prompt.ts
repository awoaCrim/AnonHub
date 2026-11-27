/** `GET /yesimbot/api/v1/prompt`: the prompt one conversation's model receives, in order, with sources. */
export type PromptSegmentSource = "fixed" | "card" | "toggle" | "plugin" | "auto";

export interface PromptSegmentView {
  key: string;
  title: string;
  source: PromptSegmentSource;
  /** False: a switch that is off or an empty card field, listed but not sent. */
  enabled: boolean;
  text?: string;
  chars: number;
  plugin?: string;
}

export interface PromptOverview {
  /** The conversation shown; the most recently active one unless asked. */
  conversation: string;
  conversations: { key: string; label: string; kind: "私聊" | "群聊"; platform: string }[];
  segments: readonly PromptSegmentView[];
  tools: readonly { name: string; chars: number }[];
}
