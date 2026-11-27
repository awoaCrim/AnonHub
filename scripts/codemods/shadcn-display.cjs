// One-off codemod: legacy .badge/.callout elements and checkbox/switch inputs become shadcn-vue components.
// Usage: node scripts/codemods/shadcn-display.cjs <file.vue>... (rewrites in place, prints what it left alone)
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("@vue/compiler-sfc");

const UI = path.resolve(__dirname, "../../plugins/console/web/src/components/ui");
const BADGE_TONES = { ok: "ok", warn: "warn", danger: "danger", accent: "accent" };
const ALERT_TONES = { warn: "warn", danger: "destructive", ok: "ok" };

const staticAttr = (node, name) => node.props.find((p) => p.type === 6 && p.name === name);
const directive = (node, name, arg) => node.props.find((p) => p.type === 7 && p.name === name && (arg === undefined || p.arg?.content === arg));

/** `$event` from a native checkbox change, rewritten to the boolean a shadcn control emits. */
function checkedHandler(expression) {
  const out = expression
    .replace(/\(\s*\$event\.target\s+as\s+HTMLInputElement\s*\)\.checked/g, "$event")
    .replace(/\$event\.target\.checked/g, "$event")
    .replace(/\bchecked\(\$event\)/g, "$event");
  // A handler that still receives the DOM event (or only got it passed along) is rewritten by hand.
  return out.includes("$event.target") || (out === expression && expression.includes("$event")) ? undefined : out;
}

function transform(file) {
  const src = fs.readFileSync(file, "utf8");
  const { descriptor } = parse(src);
  if (!descriptor.template?.ast) return { file, changed: 0 };
  const edits = [];
  const used = new Set();
  const left = [];
  const retag = (node, name, attrEdits) => {
    const start = node.loc.start.offset;
    edits.push([start + 1, start + 1 + node.tag.length, name]);
    for (const e of attrEdits) edits.push(e);
    if (!node.isSelfClosing) {
      // End tags may be split across lines (`</span\n>`) by the formatter.
      const close = new RegExp(`</${node.tag}\\s*>$`).exec(node.loc.source);
      if (close) {
        const at = node.loc.end.offset - close[0].length + 2;
        edits.push([at, at + node.tag.length, name]);
      }
    }
  };
  const asProp = (node, fallback) => (node.tag === fallback ? "" : ` as="${node.tag}"`);
  const visit = (node, parent) => {
    const cls = staticAttr(node, "class");
    const tokens = cls?.value?.content.split(/\s+/).filter(Boolean) ?? [];
    if (tokens.includes("badge") && ["span", "small", "strong", "em", "div", "b"].includes(node.tag)) {
      const tone = tokens.find((t) => BADGE_TONES[t]);
      const rest = tokens.filter((t) => t !== "badge" && t !== tone);
      retag(node, "Badge", [
        [
          cls.loc.start.offset,
          cls.loc.end.offset,
          `variant="${tone ? BADGE_TONES[tone] : "secondary"}"${asProp(node, "div")}${rest.length ? ` class="${rest.join(" ")}"` : ""}`,
        ],
      ]);
      used.add("Badge");
    } else if (tokens.includes("callout") && ["p", "div", "section", "aside"].includes(node.tag)) {
      const tone = tokens.find((t) => ALERT_TONES[t]);
      const rest = tokens.filter((t) => t !== "callout" && t !== tone);
      const variant = tone ? ` variant="${ALERT_TONES[tone]}"` : "";
      retag(node, "Alert", [
        [cls.loc.start.offset, cls.loc.end.offset, `${variant.trim()}${asProp(node, "div")}${rest.length ? ` class="${rest.join(" ")}"` : ""}`.trim()],
      ]);
      used.add("Alert");
    } else if (node.tag === "input" && staticAttr(node, "type")?.value?.content === "checkbox") {
      const isSwitch = staticAttr(node, "role")?.value?.content === "switch";
      const model = directive(node, "model");
      const checked = directive(node, "bind", "checked");
      const change = directive(node, "on", "change");
      const value = directive(node, "bind", "value") ?? staticAttr(node, "value");
      if (value) return void left.push(`checkbox with a value (array model) at ${node.loc.start.line}`);
      const handler = change && checkedHandler(change.exp.content);
      if (change && !handler) return void left.push(`checkbox @change="${change.exp.content}" at ${node.loc.start.line}`);
      const name = isSwitch ? "Switch" : "Checkbox";
      const attrEdits = [[staticAttr(node, "type").loc.start.offset, staticAttr(node, "type").loc.end.offset, ""]];
      if (isSwitch) attrEdits.push([staticAttr(node, "role").loc.start.offset, staticAttr(node, "role").loc.end.offset, ""]);
      if (checked) attrEdits.push([checked.loc.start.offset, checked.loc.end.offset, `:model-value="${checked.exp.content}"`]);
      if (change) attrEdits.push([change.loc.start.offset, change.loc.end.offset, `@update:model-value="${handler}"`]);
      if (!model && !checked) left.push(`checkbox without a bound state at ${node.loc.start.line}`);
      // The input becomes a self-closing component.
      const start = node.loc.start.offset;
      edits.push([start + 1, start + 1 + node.tag.length, name]);
      for (const e of attrEdits) edits.push(e);
      const source = node.loc.source;
      if (!source.endsWith("/>")) edits.push([node.loc.end.offset - 1, node.loc.end.offset, " />"]);
      used.add(name);
      // A switch's drawn track and the label's switch class go with the native input.
      if (isSwitch && parent) {
        const track = parent.children.find((c) => c.type === 1 && staticAttr(c, "class")?.value?.content === "track");
        if (track) edits.push([track.loc.start.offset, track.loc.end.offset, ""]);
        const pcls = staticAttr(parent, "class");
        const ptokens = pcls?.value?.content.split(/\s+/).filter(Boolean) ?? [];
        if (ptokens.includes("switch")) {
          const rest = ptokens.filter((t) => t !== "switch");
          edits.push([
            pcls.loc.start.offset,
            pcls.loc.end.offset,
            `class="${["inline-flex items-center gap-2.5 text-[13px] font-medium", ...rest].join(" ")}"`,
          ]);
        }
      }
    }
  };
  const walk = (node, parent) => {
    if (node.type === 1) visit(node, parent);
    for (const child of node.children ?? []) walk(child, node.type === 1 ? node : parent);
    for (const branch of node.branches ?? []) walk(branch, parent);
  };
  walk(descriptor.template.ast);
  if (!edits.length) return { file, changed: 0, left };
  // Overlapping edits (a track removed inside a label being rewritten) apply from the end of the file backwards.
  edits.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let out = src;
  for (const [s, e, text] of edits) out = out.slice(0, s) + text + out.slice(e);
  out = out.replace(/<(Switch|Checkbox)((?:\s+[^\s>]+(?:="[^"]*")?)*)\s*\/>/g, (m, tag, attrs) => `<${tag} ${attrs.trim().replace(/\s+/g, " ")} />`);
  const rel = (dir) => path.relative(path.dirname(file), path.join(UI, dir)).replace(/^(?!\.)/, "./");
  const lines = [];
  for (const [name, dir] of [
    ["Badge", "badge"],
    ["Alert", "alert"],
    ["Switch", "switch"],
    ["Checkbox", "checkbox"],
  ]) {
    if (!used.has(name)) continue;
    const already = new RegExp(`import \\{([^}]*)\\} from "${rel(dir).replace(/[.]/g, "\\.")}";`);
    const match = out.match(already);
    if (
      match &&
      match[1]
        .split(",")
        .map((s) => s.trim())
        .includes(name)
    )
      continue;
    if (match)
      out = out.replace(
        already,
        `import { ${[
          ...match[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          name,
        ].join(", ")} } from "${rel(dir)}";`,
      );
    else lines.push(`import { ${name} } from "${rel(dir)}";`);
  }
  const setup = out.match(/<script[^>]*\bsetup\b[^>]*>\n/) ?? out.match(/<script[^>]*>\n/);
  if (lines.length) {
    if (!setup) out += `\n<script setup lang="ts">\n${lines.join("\n")}\n</script>\n`;
    else out = out.slice(0, setup.index + setup[0].length) + lines.join("\n") + "\n" + out.slice(setup.index + setup[0].length);
  }
  fs.writeFileSync(file, out);
  return { file, changed: edits.length, used: [...used], left };
}

for (const file of process.argv.slice(2)) {
  const r = transform(file);
  if (r.changed || r.left?.length) console.log(path.relative(process.cwd(), r.file), r.changed, r.used ?? "", r.left?.length ? r.left : "");
}
