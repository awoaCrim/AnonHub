import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";

import PickerMenu from "../web/src/components/PickerMenu.vue";
import SuggestInput from "../web/src/components/SuggestInput.vue";
import { stepOption } from "../web/src/lib/picker";

const source = fileURLToPath(new URL("../web/src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
const render = (component: unknown, props: Record<string, unknown>) => renderToString(createSSRApp({ render: () => h(component as never, props) }));

describe("the site's own dropdowns", () => {
  it("leaves no browser select or datalist popup anywhere in the WebUI", () => {
    const native = files(source)
      .filter((file) => file.endsWith(".vue"))
      .filter((file) => /<(select|datalist)\b/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(source.length + 1));
    expect(native).toEqual([]);
  });

  it("steps over disabled choices and wraps around", () => {
    const options = [
      { value: "a", label: "A" },
      { value: "b", label: "B", disabled: true },
      { value: "c", label: "C" },
    ];
    expect(stepOption(options, 0, 1)).toBe(2);
    expect(stepOption(options, 2, 1)).toBe(0);
    expect(stepOption(options, 0, -1)).toBe(2);
    expect(stepOption(options, -1, 1)).toBe(0);
    expect(stepOption([{ value: "x", label: "X", disabled: true }], -1, 1)).toBe(-1);
  });

  it("shows the chosen label in a field, the placeholder when nothing matches, and stays closed until pressed", async () => {
    const options = [
      { value: undefined, label: "使用默认值" },
      { value: "chat", label: "Chat Completions" },
    ];
    const chosen = await render(PickerMenu, { field: true, modelValue: "chat", options });
    expect(chosen).toMatch(/<span class="value truncate"[^>]*>Chat Completions<\/span>/);
    expect(chosen).toContain('aria-expanded="false"');
    expect(chosen).not.toContain('role="listbox"');
    // `undefined` is a choice of its own, not "nothing chosen".
    expect(await render(PickerMenu, { field: true, modelValue: undefined, options })).toMatch(/class="value truncate"[^>]*>使用默认值</);
    const unknown = await render(PickerMenu, { field: true, modelValue: "gone", options, placeholder: "默认：chat" });
    expect(unknown).toMatch(/<span class="[^"]*\bplaceholder\b[^"]*"[^>]*>默认：chat<\/span>/);
  });

  it("stops a form on an empty required choice and passes the label to the trigger", async () => {
    const html = await render(PickerMenu, { field: true, required: true, id: "computer", modelValue: "", options: [{ value: "", label: "未选择" }] });
    expect(html).toMatch(/<button[^>]*id="computer"/);
    expect(html).toMatch(/<input[^>]*class="validate[^"]*"[^>]*required[^>]*value=""/);
    expect(await render(PickerMenu, { field: true, disabled: true, modelValue: "", options: [] })).toMatch(/<button[^>]*disabled/);
  });

  it("keeps a suggesting input a plain field with its own attributes until it is used", async () => {
    const html = await render(SuggestInput, {
      modelValue: "gpt",
      options: [{ value: "gpt-5", label: "gpt-5" }],
      label: "检测到的模型",
      class: "control mono-input",
      placeholder: "模型 ID",
      required: true,
    });
    expect(html).toMatch(/<input[^>]*class="[^"]*\bmono-input\b[^"]*"[^>]*>/);
    expect(html).toMatch(/role="combobox"/);
    expect(html).toMatch(/placeholder="模型 ID"/);
    expect(html).toMatch(/value="gpt"/);
    expect(html).not.toContain('role="listbox"');
  });
});
