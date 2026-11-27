/** Dependency-free tool-grant rules, shared by the authorizer and the browser. */

/**
 * True when this tool list grants the tool: by name, or by `*`, which the device client offers as 「全部工具（包含以后新增
 * 工具）」. Its policy names device methods (`computer.shell.exec`); Core guards sensitive tools by their declared
 * capability, not by these lists.
 */
export function grantsTool(tools: readonly string[], name: string): boolean {
  return tools.includes(name) || tools.includes("*");
}

/**
 * Device tools use their own platform application switch, separate from workspace files. `computer_switch`
 * changes which bound computer the whole bot uses; it is part of the same computer capability.
 */
export const COMPUTER_TOOL_NAMES = ["computer_exec", "computer_job", "computer_browser", "computer_use", "computer_ui", "computer_switch"] as const;

export const isComputerTool = (name: string): boolean => (COMPUTER_TOOL_NAMES as readonly string[]).includes(name);
