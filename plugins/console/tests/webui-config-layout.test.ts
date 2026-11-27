import { expect, it, vi } from "vitest";

import type { PluginSchemaNode as Schema } from "../src/shared/plugin-config";
import { ApiError } from "../web/src/lib/api";
import { draftStore, itemStore, type ConfigStore } from "../web/src/schema/config-store";
import { emptyValue, itemSummary, layout, parsePath, pathText, type Path } from "../web/src/schema/schema-model";
import { createAutosave } from "../web/src/state/autosave";
import { readPath } from "../web/src/state/config-fields";
import { createPluginSettings, rootFields } from "../web/src/state/settings-store";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// The search plugin's form as the server builds it: titled sections, a backend chosen by a sibling select, lists.
const search: Schema = {
  type: "intersect",
  list: [
    {
      type: "object",
      meta: { description: "搜索后端" },
      dict: {
        provider: {
          type: "union",
          meta: { description: "搜索服务\n说明", default: "tavily" },
          list: [
            { type: "const", value: "tavily", meta: { description: "Tavily" } },
            { type: "const", value: "searxng", meta: { description: "SearXNG" } },
          ],
        },
      },
    },
    {
      type: "union",
      meta: { description: "后端配置" },
      list: [
        {
          type: "object",
          dict: {
            provider: { type: "const", value: "tavily" },
            tavily: {
              type: "object",
              meta: { description: "Tavily 连接", default: {} },
              dict: {
                apiKey: { type: "string", meta: { description: "API Key\n说明", role: "secret" } },
                apiKeys: { type: "array", meta: { description: "备用 API Key\n说明", default: [] }, inner: { type: "string", meta: { role: "secret" } } },
              },
            },
          },
        },
        {
          type: "object",
          dict: {
            provider: { type: "const", value: "searxng", meta: { required: true } },
            searxng: { type: "object", meta: { description: "SearXNG 连接" }, dict: { endpoint: { type: "string", meta: { description: "实例地址\n说明" } } } },
          },
        },
      ],
    },
    {
      type: "object",
      meta: { description: "结果过滤" },
      dict: { blacklist: { type: "array", meta: { description: "屏蔽网址\n说明", default: [] }, inner: { type: "string" } } },
    },
  ],
};

const outline = (value: Record<string, unknown>) =>
  layout(search, [], (path) => readPath(value, path)).map((block) => ({
    title: block.title,
    rows: block.rows.map((row) => `${row.kind}:${row.title}`),
    collection: block.collection && `${block.collection.kind}:${block.collection.path.join(".")}`,
  }));

it("lays a schema out as groups of rows: named fields, a sibling-chosen shape, lists as groups of their own", () => {
  expect(outline({})).toEqual([
    { title: "搜索后端", rows: ["select:搜索服务"], collection: undefined },
    { title: "Tavily 连接", rows: ["secret:API Key"], collection: undefined },
    { title: "备用 API Key", rows: [], collection: "items:tavily.apiKeys" },
    { title: "屏蔽网址", rows: [], collection: "items:blacklist" },
  ]);
  // The select picks the shape; no second picker for it.
  expect(outline({ provider: "searxng" }).map((block) => block.title)).toEqual(["搜索后端", "SearXNG 连接", "屏蔽网址"]);
});

it("offers the shapes of a field as segments, hides a single-option select and edits what it cannot show as JSON", () => {
  const schema: Schema = {
    type: "object",
    dict: {
      env: {
        type: "union",
        meta: { description: "环境变量" },
        list: [
          { type: "dict", meta: { description: "逐项填写" }, inner: { type: "string" } },
          { type: "string", meta: { description: "整段文本\n每行一个", role: "textarea" } },
        ],
      },
      only: { type: "union", list: [{ type: "const", value: "a" }] },
      servers: { type: "dict", meta: { description: "服务器" }, inner: { type: "object", dict: { url: { type: "string" } } } },
      raw: { meta: { description: "原始值" } },
    },
  };
  const blocks = (value: Record<string, unknown>) => layout(schema, [], (path) => readPath(value, path));
  expect(blocks({}).map((block) => [block.title, block.rows.map((row) => row.kind), block.collection?.kind])).toEqual([
    ["", ["json"], undefined],
    ["环境变量", ["branch"], "pairs"],
    ["服务器", [], "entries"],
  ]);
  expect(blocks({ env: "A=1" })[1]!.rows.map((row) => `${row.kind}:${row.title}`)).toEqual(["branch:", "textarea:"]);
  // Without a schema the whole value is one JSON field.
  expect(layout(null, ["config"], () => undefined)[0]!.rows[0]).toMatchObject({ kind: "json", path: ["config"] });
});

it("starts a new item from the discriminators its shape fixes and summarizes it by kind and address", () => {
  const server: Schema = {
    type: "intersect",
    list: [
      {
        type: "object",
        dict: {
          type: {
            type: "union",
            list: [
              { type: "const", value: "stdio", meta: { description: "本地命令" } },
              { type: "const", value: "http", meta: { description: "HTTP（远程服务）" } },
            ],
          },
        },
      },
      {
        type: "union",
        list: [
          { type: "object", dict: { type: { type: "const", value: "stdio" }, command: { type: "string" } } },
          { type: "object", dict: { type: { type: "const", value: "http" }, url: { type: "string" } } },
        ],
      },
    ],
  };
  expect(emptyValue(server)).toEqual({ type: "stdio" });
  expect(itemSummary(server, { type: "http", url: "https://mcp.example" })).toBe("HTTP · https://mcp.example");
  expect(rootFields(search)).toEqual(["provider", "tavily", "searxng", "blacklist"]);
  expect(parsePath("a.b[0].c")).toEqual(["a", "b", "0", "c"]);
  expect(pathText(["a", "b", "0", "c"])).toBe("a.b[0].c");
});

it("saves a list item as the whole list and keeps a new item local until it is added", () => {
  const value: Record<string, unknown> = { rows: [{ name: "a", port: 1 }, { name: "b" }] };
  const commit = vi.fn();
  const parent: ConfigStore = {
    value: (path) => readPath(value, path),
    commit,
    error: (path) => (path.join(".") === "rows.1.port" ? "不能小于 1" : ""),
    fail: vi.fn(),
    disabled: false,
    dynamics: {},
  };
  const item = itemStore(parent, ["rows"], 1);
  expect(item.value(["name"])).toBe("b");
  expect(item.error(["port"])).toBe("不能小于 1");
  item.commit("端口", [[["port"], 8080]]);
  expect(commit).toHaveBeenCalledWith(
    "端口",
    [
      [
        ["rows"],
        [
          { name: "a", port: 1 },
          { name: "b", port: 8080 },
        ],
      ],
    ],
    { origins: [["rows", "1", "port"]] },
  );

  const draft = draftStore({ type: "object", dict: { command: { type: "string", meta: { required: true } } } }, {}, () => false);
  expect(draft.problems()).toHaveLength(1);
  draft.store.commit("命令", [[["command"], "npx"]]);
  expect(draft.draft).toEqual({ command: "npx" });
  expect(draft.problems()).toEqual([]);
});

it("offers no 撤销 for a save that carries an irreversible change", async () => {
  const value: Record<string, unknown> = {};
  const notify = vi.fn();
  const target = { dirty: { value: true }, set: (path: Path, next: unknown) => void (value[path[0]!] = next), save: vi.fn(async () => true), discard: vi.fn() };
  const autosave = createAutosave({ read: (path) => value[path[0]!], target: () => target, disposed: () => false, notify });
  await autosave.commit("API Key", [[["apiKey"], "new"]], { irreversible: true });
  expect(notify).toHaveBeenLastCalledWith("已保存：API Key", undefined);
  await autosave.commit("语言", [[["language"], "zh"]]);
  expect(notify).toHaveBeenLastCalledWith("已保存：语言", expect.any(Function));
});

function plugin(update: (body: Record<string, unknown>) => unknown) {
  let config: Record<string, unknown> = { dailyPostLimit: 1, unknown: { keep: true } };
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const request = vi.fn(async (path: string, body?: Record<string, unknown>) => {
    requests.push({ path, body });
    if (!body) return { revision: "r1", config: structuredClone(config) };
    const result = update(body);
    config = body.config as Record<string, unknown>;
    return result;
  });
  const notify = vi.fn();
  const snapshot = {
    schema: {
      type: "object",
      dict: {
        selfId: { type: "string", meta: { description: "绑定账号\n说明", required: true } },
        dailyPostLimit: { type: "number", meta: { description: "每日发帖上限\n说明", default: 1, max: 1000 } },
      },
    },
    dynamics: {},
    usage: "",
  } as const;
  const settings = createPluginSettings(snapshot as never, { writable: () => true, disposed: () => false, notify, request: request as never });
  return { settings, requests, notify };
}

it("saves a plugin field at once, keeps the fields it does not show and reads the config back", async () => {
  const h = plugin(() => ({ revision: "r2" }));
  await h.settings.editor.load("~yesimbot-xiaoheihe");
  h.settings.store.commit("每日发帖上限", [[["dailyPostLimit"], 3]]);
  await flush();
  const update = h.requests.find((item) => item.body);
  expect(update?.body).toEqual({ path: "~yesimbot-xiaoheihe", revision: "r1", config: { dailyPostLimit: 3, unknown: { keep: true } } });
  // Read back after the save, so secret markers and the revision are the server's.
  expect(h.requests.at(-1)).toMatchObject({ path: "/yesimbot/api/v1/plugins/config?path=~yesimbot-xiaoheihe" });
  expect(h.notify).toHaveBeenCalledWith("已保存：每日发帖上限", expect.any(Function));
});

it("puts a refused save's reason under the changed row and the field it is about, and shows the saved value again", async () => {
  const h = plugin(() => {
    throw new ApiError(400, "invalid_config", undefined, "selfId");
  });
  await h.settings.editor.load("~yesimbot-xiaoheihe");
  h.settings.store.commit("每日发帖上限", [[["dailyPostLimit"], 3]]);
  await flush();
  expect(h.settings.store.error(["selfId"])).toBe("请填写此项");
  expect(h.settings.store.error(["dailyPostLimit"])).toBe("「绑定账号」请填写此项");
  expect(h.settings.store.value(["dailyPostLimit"])).toBe(1);
  expect(h.settings.editor.state.error).toBe("");
  expect(h.settings.refusing()).toBe(true);
  expect(h.notify).not.toHaveBeenCalled();
});
