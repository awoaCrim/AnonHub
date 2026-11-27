import { ClipboardCheck, DocumentText as FileText, Globe, Monitor, Search, TerminalSquare as SquareTerminal, Gear as Wrench } from "reicon-vue";
import type { Component } from "vue";

import type { WorkStep } from "../../../src/shared/work";

export const STEP_STATUS: Record<WorkStep["status"], string> = { running: "正在执行", ok: "完成", failed: "没成功", unknown: "结果未知" };
const LABELS: Record<string, string> = {
  computer_exec: "命令行",
  computer_job: "后台命令",
  computer_browser: "浏览器",
  computer_ui: "桌面操作",
  computer_use: "操作电脑",
  computer_switch: "切换电脑",
  read: "查看",
  readFile: "读文件",
  writeFile: "写文件",
  editFile: "改文件",
  listFiles: "列文件",
  read_tool_output: "翻看输出",
  describe_image: "看图片",
  render_html: "生成页面",
  task_report: "提交结果",
  git: "Git",
  bash: "终端",
  search_web: "网页搜索",
  search_images: "图片搜索",
  read_webpage: "读取网页",
  import_image_reference: "导入参考图",
  generate_image: "生成图片",
  edit_image: "修改图片",
  list_conversations: "查看对话列表",
  read_conversation: "读取对话",
  relay_to_conversation: "转告对话",
  schedule_list: "查看定时任务",
  schedule_create: "新建定时任务",
  schedule_update: "修改定时任务",
};
/** Input fields that say what a call was about, most telling first. */
const SUBJECT_KEYS = ["query", "q", "url", "path", "command", "title", "name", "instruction", "prompt", "id", "jobId"];
const JOB_ACTIONS: Record<string, string> = { read: "查看输出", stop: "停止", list: "列出后台命令" };
/** Actions whose text is what was typed. */
const TYPED = new Set(["fill", "type", "type_text", "setValue"]);
/** Characters one block shows; the server already keeps a long value's start and end. */
const TEXT_LIMIT = 8000;
/** Characters of a step's one-line summary. */
const SUMMARY_LIMIT = 160;

/**
 * How one step of the bot's work reads in the console: a command (or a one-line action), a few facts about how it
 * ended, and its output (user, 2026-11-20: 「我需要可以点开查看具体的命令和对应的输出」「至少我得知道，执行了哪些命令，正在执行
 * 什么命令吧？」). Text typed into pages and controls is not shown: a password field cannot be told apart reliably.
 */
export interface StepView {
  label: string;
  /** One line saying what this call did, for the head of its detail and its tab. */
  summary: string;
  /** A command line, shown as code. */
  command?: string;
  /** One line for an action that is not a command, or the file it was about. */
  line?: string;
  /** The rest of the input, as JSON, when there is nothing simpler to say. */
  input?: string;
  meta: string[];
  outputs: { label: string; text: string; error?: boolean }[];
}

export function stepLabel(tool: string): string {
  return LABELS[tool] ?? tool;
}

export function stepIcon(tool: string): Component {
  if (tool === "computer_exec" || tool === "computer_job" || tool === "bash") return SquareTerminal;
  if (tool === "computer_browser" || tool === "read_webpage") return Globe;
  if (tool.startsWith("computer_")) return Monitor;
  if (tool === "task_report") return ClipboardCheck;
  if (/search/.test(tool)) return Search;
  if (/file|read|directory/i.test(tool)) return FileText;
  return Wrench;
}

export function describeStep(step: WorkStep): StepView {
  const input = record(step.input);
  const view: StepView = { label: stepLabel(step.tool), summary: "", meta: [], outputs: [] };
  if (step.tool === "computer_exec" && typeof input.command === "string") {
    view.command = input.command;
    if (typeof input.cwd === "string" && input.cwd) view.meta.push(`目录 ${input.cwd}`);
    if (input.background === true) view.meta.push("在后台运行");
    if (typeof input.timeoutMs === "number") view.meta.push(`最多等 ${seconds(input.timeoutMs)}`);
    shellOutput(step.output, view);
  } else if (step.tool === "computer_job") {
    view.line = [JOB_ACTIONS[String(input.action)] ?? String(input.action ?? ""), typeof input.jobId === "string" ? input.jobId : ""].filter(Boolean).join(" ");
    shellOutput(step.output, view);
  } else if (step.tool === "computer_browser") {
    view.line = browserLine(input);
    browserOutput(step.output, view);
  } else if (step.tool === "task_report") {
    view.line = `状态：${String(input.status ?? "")}`;
    if (typeof input.result === "string" && input.result.trim()) view.outputs.push({ label: "报告", text: clip(input.result) });
  } else {
    const { path, ...rest } = input;
    if (typeof path === "string") view.line = path;
    const shown = typeof path === "string" ? rest : step.input;
    if (shown !== undefined && shown !== null && (typeof shown !== "object" || Object.keys(shown).length)) view.input = json(masked(shown));
    if (step.output !== undefined) view.outputs.push({ label: "结果", text: plain(step.output), error: step.status === "failed" });
  }
  view.summary = oneLine(view.command ?? view.line ?? subject(input));
  return view;
}

/** A command's or a background command's result: exit code, standard output and errors, and Core's explanation. */
function shellOutput(output: unknown, view: StepView) {
  if (output === undefined) return;
  if (typeof output === "string") {
    view.outputs.push({ label: "结果", text: clip(output), error: true });
    return;
  }
  const result = record(output);
  const inner = record(result.output);
  if (typeof inner.exitCode === "number") view.meta.push(`退出码 ${inner.exitCode}`);
  if (inner.timedOut === true) view.meta.push("到时被终止");
  if (typeof inner.signal === "string") view.meta.push(`信号 ${inner.signal}`);
  if (typeof inner.jobId === "string") view.meta.push(`后台编号 ${inner.jobId}`);
  if (typeof inner.durationMs === "number") view.meta.push(`用时 ${seconds(inner.durationMs)}`);
  const stdout = typeof inner.stdout === "string" ? inner.stdout : typeof inner.output === "string" ? inner.output : "";
  const stderr = typeof inner.stderr === "string" ? inner.stderr : "";
  if (stdout.trim()) view.outputs.push({ label: "输出", text: clip(stdout) });
  if (stderr.trim()) view.outputs.push({ label: "错误输出", text: clip(stderr), error: true });
  const note = [result.code, result.message].filter((part): part is string => typeof part === "string" && !!part).join("：");
  if (note) view.outputs.push({ label: "说明", text: note, error: result.status !== "succeeded" });
  if (!stdout.trim() && !stderr.trim() && typeof inner.exitCode === "number") view.meta.push("没有输出");
  if (!view.outputs.length && !Object.keys(inner).length) view.outputs.push({ label: "结果", text: plain(output), error: result.status !== "succeeded" });
}

function browserLine(input: Record<string, unknown>): string {
  const ref = typeof input.ref === "string" ? ` ${input.ref}` : "";
  switch (input.action) {
    case "navigate":
      return `打开 ${String(input.url ?? "")}`;
    case "click":
      return `点击${ref}`;
    case "fill":
      return `填写${ref}（${typedLength(input)}，不显示内容）`;
    case "press":
      return `按键 ${String(input.key ?? "")}`;
    case "inspect":
      return "读取页面";
    case "screenshot":
      return "截图";
    case "click_at":
      return `点击画面位置 (${String(input.x)}, ${String(input.y)})`;
    case "sequence":
      return `连续操作 ${Array.isArray(input.steps) ? input.steps.length : ""} 步`;
    case "tabs":
      return "查看标签页";
    case "type":
      return `逐键输入（${typedLength(input)}，不显示内容）`;
    case "hotkey":
      return `组合键 ${String(input.keys ?? "")}`;
    case "scroll": {
      const notches = Number(input.dy);
      return `在画面位置 (${String(input.x)}, ${String(input.y)}) ${notches > 0 ? "向下" : "向上"}滚动 ${Math.abs(notches)} 格`;
    }
    case "upload":
      return `上传 ${Array.isArray(input.files) ? input.files.map(String).join("、") : ""}${ref ? ` 到${ref}` : ""}`;
    default:
      return String(input.action ?? "浏览器操作");
  }
}

/** The page it ended on, Core's or the device's explanation, and the page text. Element lists are left out. */
function browserOutput(output: unknown, view: StepView) {
  if (output === undefined) return;
  if (typeof output === "string") {
    view.outputs.push({ label: "结果", text: clip(output), error: true });
    return;
  }
  const result = record(output);
  const inner = record(result.output);
  const page = typeof inner.snapshot === "string" ? inner : record(inner.page ?? result.page);
  const where = [page.title, page.url].filter((part): part is string => typeof part === "string" && !!part);
  if (where.length) view.meta.push(`页面：${where.join(" · ")}`);
  const note = [result.code, result.message, page.note].filter((part): part is string => typeof part === "string" && !!part).join("：");
  if (note) view.outputs.push({ label: "说明", text: note, error: result.status !== "succeeded" });
  if (typeof page.text === "string" && page.text.trim()) view.outputs.push({ label: "页面正文", text: clip(page.text) });
}

/** A copy without what was typed: the text of fill/type actions, also inside `sequence` steps and desktop actions. */
function masked(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => masked(item, depth + 1));
  const entry = value as Record<string, unknown>;
  const typed = TYPED.has(String(entry.action)) || entry.type === "type" || TYPED.has(String(entry.type));
  return Object.fromEntries(
    Object.entries(entry).map(([key, item]) => [
      key,
      typed && (key === "text" || key === "value") && typeof item === "string" ? `（${item.length} 个字，不显示）` : masked(item, depth + 1),
    ]),
  );
}

/** The field a call was about (a query, an address, a path), or its first short text. Typed text is never one. */
function subject(input: Record<string, unknown>): string {
  for (const key of SUBJECT_KEYS) if (typeof input[key] === "string" && input[key]) return input[key];
  const typed = TYPED.has(String(input.action));
  const text = Object.entries(input).find(([key, value]) => typeof value === "string" && value && !(typed && (key === "text" || key === "value")));
  return text ? String(text[1]) : "";
}

/** The first line, cut to what fits a heading. */
function oneLine(text: string): string {
  const lines = text.trim().split("\n");
  const first = lines[0]!.trim();
  const short = first.length > SUMMARY_LIMIT ? `${first.slice(0, SUMMARY_LIMIT)}…` : first;
  return lines.length > 1 && short === first ? `${short} …` : short;
}

function typedLength(input: Record<string, unknown>): string {
  const text = typeof input.text === "string" ? input.text : typeof input.value === "string" ? input.value : "";
  return `${text.length} 个字`;
}

function plain(value: unknown): string {
  return typeof value === "string" ? clip(value) : json(masked(value));
}

function json(value: unknown): string {
  try {
    return clip(JSON.stringify(value, null, 2) ?? "");
  } catch {
    return "";
  }
}

function clip(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…` : text;
}

function seconds(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60_000)} 分钟`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
