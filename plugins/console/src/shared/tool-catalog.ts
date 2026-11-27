/** Which built-in tool runs where: one row per tool, one column per platform and conversation kind. */
export interface ToolCatalog {
  columns: { platform: string; kind: "direct" | "group"; label: string }[];
  groups: { plugin: string; label: string; tools: { name: string; sensitive: boolean; allowed: boolean[] }[] }[];
}
