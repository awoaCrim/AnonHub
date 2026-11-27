// One-off codemod: native buttons/inputs/textareas/selects styled by the legacy classes become shadcn-vue
// components. Usage: node scripts/codemods/shadcn-controls.cjs <file.vue>... (rewrites in place, prints a report)
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("@vue/compiler-sfc");

const UI = path.resolve(__dirname, "../../plugins/console/web/src/components/ui");
const TEXT_TYPES = new Set([undefined, "text", "search", "password", "email", "url", "number", "tel"]);

function staticAttr(node, name) {
  return node.props.find((p) => p.type === 6 && p.name === name);
}

function has(node, test) {
  return node.props.some(test);
}

function buttonProps(tokens) {
  const t = new Set(tokens);
  let variant = "outline";
  if (t.has("primary")) variant = "default";
  else if (t.has("ghost")) variant = "ghost";
  else if (t.has("danger")) variant = "danger";
  const extra = [];
  if (t.has("ghost") && (t.has("danger") || t.has("danger-text"))) extra.push("text-destructive hover:text-destructive");
  let size = "default";
  if (t.has("icon") && t.has("sm")) size = "icon-sm";
  else if (t.has("icon")) size = "icon";
  else if (t.has("sm")) size = "sm";
  else if (t.has("big")) size = "lg";
  const rest = tokens.filter((x) => !["btn", "primary", "ghost", "danger", "danger-text", "sm", "icon", "big"].includes(x));
  return { variant, size, cls: [...rest, ...extra].join(" ") };
}

function transform(file) {
  const src = fs.readFileSync(file, "utf8");
  const { descriptor } = parse(src);
  if (!descriptor.template?.ast) return { file, changed: 0 };
  const edits = [];
  const used = new Set();
  const skipped = [];
  const walk = (node) => {
    if (node.type === 1) visit(node);
    for (const child of node.children ?? []) walk(child);
  };
  const replaceTag = (node, name, attrEdits) => {
    const start = node.loc.start.offset;
    edits.push([start + 1, start + 1 + node.tag.length, name]);
    for (const e of attrEdits) edits.push(e);
    if (!node.isSelfClosing) {
      const source = node.loc.source;
      const close = `</${node.tag}>`;
      if (source.endsWith(close)) {
        const end = node.loc.end.offset;
        edits.push([end - close.length + 2, end - 1, name]);
      }
    }
  };
  const visit = (node) => {
    const cls = staticAttr(node, "class");
    const tokens = cls?.value?.content.split(/\s+/).filter(Boolean) ?? [];
    const hasRef = has(node, (p) => p.type === 6 && p.name === "ref") || has(node, (p) => p.type === 7 && p.name === "bind" && p.arg?.content === "ref");
    if (tokens.includes("btn") && ["button", "a", "RouterLink", "router-link", "label", "component"].includes(node.tag)) {
      const { variant, size, cls: rest } = buttonProps(tokens);
      const attrs = `variant="${variant}"${size !== "default" ? ` size="${size}"` : ""}${rest ? ` class="${rest}"` : ""}`;
      if (node.tag === "button" && !hasRef) {
        replaceTag(node, "Button", [[cls.loc.start.offset, cls.loc.end.offset, attrs]]);
        used.add("Button");
      } else {
        // Links, labels and dynamic components keep their element; they wear the button's classes.
        const binding = `:class="buttonVariants({ variant: '${variant}'${size !== "default" ? `, size: '${size}'` : ""} })"`;
        edits.push([cls.loc.start.offset, cls.loc.end.offset, `${rest ? `class="${rest}" ` : ""}${binding}`]);
        if (has(node, (p) => p.type === 7 && p.name === "bind" && p.arg?.content === "class"))
          skipped.push(`${node.tag} with :class and btn at ${node.loc.start.line}`);
        used.add("buttonVariants");
      }
      return;
    }
    const type = staticAttr(node, "type")?.value?.content;
    const dynamicType = has(node, (p) => p.type === 7 && p.name === "bind" && p.arg?.content === "type");
    const legacy = tokens.filter((x) => x !== "control" && x !== "input");
    const classEdit = cls ? [[cls.loc.start.offset, cls.loc.end.offset, legacy.length ? `class="${legacy.join(" ")}"` : ""]] : [];
    if (node.tag === "input" && (tokens.includes("control") || tokens.includes("input")) && (TEXT_TYPES.has(type) || dynamicType)) {
      if (hasRef) return void skipped.push(`input with ref at ${node.loc.start.line}`);
      replaceTag(node, "Input", classEdit);
      used.add("Input");
    } else if (node.tag === "textarea" && (tokens.includes("control") || tokens.includes("input"))) {
      if (hasRef) return void skipped.push(`textarea with ref at ${node.loc.start.line}`);
      replaceTag(node, "Textarea", classEdit);
      used.add("Textarea");
    } else if (node.tag === "select" && (tokens.includes("control") || tokens.includes("input"))) {
      if (hasRef) return void skipped.push(`select with ref at ${node.loc.start.line}`);
      replaceTag(node, "NativeSelect", classEdit);
      used.add("NativeSelect");
    }
  };
  walk(descriptor.template.ast);
  if (!edits.length) return { file, changed: 0, skipped };
  edits.sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [s, e, text] of edits) out = out.slice(0, s) + text + out.slice(e);
  // Imports go into <script setup>.
  const rel = (dir) => path.relative(path.dirname(file), path.join(UI, dir)).replace(/^(?!\.)/, "./");
  const lines = [];
  const button = ["Button", "buttonVariants"].filter((n) => used.has(n));
  if (button.length) lines.push(`import { ${button.join(", ")} } from "${rel("button")}";`);
  if (used.has("Input")) lines.push(`import { Input } from "${rel("input")}";`);
  if (used.has("Textarea")) lines.push(`import { Textarea } from "${rel("textarea")}";`);
  if (used.has("NativeSelect")) lines.push(`import { NativeSelect } from "${rel("native-select")}";`);
  const setup = out.match(/<script[^>]*\bsetup\b[^>]*>\n/) ?? out.match(/<script[^>]*>\n/);
  if (!setup) out += `\n<script setup lang="ts">\n${lines.join("\n")}\n</script>\n`;
  else {
    const at = setup.index + setup[0].length;
    out = out.slice(0, at) + lines.join("\n") + "\n" + out.slice(at);
  }
  fs.writeFileSync(file, out);
  return { file, changed: edits.length, used: [...used], skipped };
}

for (const file of process.argv.slice(2)) {
  const r = transform(file);
  if (r.changed || r.skipped?.length) console.log(path.relative(process.cwd(), r.file), r.changed, r.used ?? "", r.skipped?.length ? r.skipped : "");
}
