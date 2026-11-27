/** Extensions read as code, with the highlight.js language each one uses. */
const CODE: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  vue: "xml",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  lua: "lua",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  bat: "dos",
  cmd: "dos",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  env: "ini",
  properties: "properties",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  makefile: "makefile",
  gradle: "gradle",
  graphql: "graphql",
  proto: "protobuf",
};

const MEDIA: Record<string, Pick<FileFormat, "view" | "type">> = {
  pdf: { view: "pdf", type: "application/pdf" },
  mp3: { view: "audio", type: "audio/mpeg" },
  m4a: { view: "audio", type: "audio/mp4" },
  aac: { view: "audio", type: "audio/aac" },
  wav: { view: "audio", type: "audio/wav" },
  ogg: { view: "audio", type: "audio/ogg" },
  oga: { view: "audio", type: "audio/ogg" },
  opus: { view: "audio", type: "audio/ogg" },
  flac: { view: "audio", type: "audio/flac" },
  mp4: { view: "video", type: "video/mp4" },
  m4v: { view: "video", type: "video/mp4" },
  mov: { view: "video", type: "video/mp4" },
  webm: { view: "video", type: "video/webm" },
  ogv: { view: "video", type: "video/ogg" },
};

const ARCHIVES = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"]);

/** How the viewer shows a file, chosen from its name; the server says only whether it is an image, text or other bytes. */
export type FileView = "markdown" | "json" | "table" | "code" | "text" | "pdf" | "audio" | "video" | "archive" | "other";

export interface FileFormat {
  view: FileView;
  /** The extension in capitals for the file card, or "" when the name has none. */
  label: string;
  /** highlight.js language for code. */
  language?: string;
  /** CSV or TSV separator. */
  delimiter?: string;
  /** Media type for a file the browser plays or shows itself. */
  type?: string;
}

/** A name's format: what decides the card's icon and label and the viewer's way of showing it. */
export function fileFormat(name: string): FileFormat {
  const base = name.trim().split(/[\\/]/).pop()!.toLowerCase();
  const dot = base.lastIndexOf(".");
  // A name like Dockerfile or Makefile is its own type.
  const extension = dot > 0 ? base.slice(dot + 1) : base in CODE ? base : "";
  const label = dot > 0 ? extension.toUpperCase().slice(0, 8) : "";
  if (["md", "markdown", "mdx"].includes(extension)) return { view: "markdown", label };
  if (["json", "jsonl", "ndjson", "geojson", "webmanifest"].includes(extension)) return { view: "json", label };
  if (extension === "csv") return { view: "table", label, delimiter: "," };
  if (extension === "tsv") return { view: "table", label, delimiter: "\t" };
  if (CODE[extension]) return { view: "code", label, language: CODE[extension] };
  if (MEDIA[extension]) return { ...MEDIA[extension], label };
  if (ARCHIVES.has(extension)) return { view: "archive", label };
  return { view: ["txt", "log", "text", "out", ""].includes(extension) ? "text" : "other", label };
}
