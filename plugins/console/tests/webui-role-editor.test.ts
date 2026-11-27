import { blankRoleCardText } from "@yesimbot/contracts/role-cards";
import { expect, it, vi } from "vitest";

import type { CardsSnapshot } from "../src/shared/character-cards";
import { api, ApiError } from "../web/src/lib/api";
import { cardPictureUrl, createRoleEditor } from "../web/src/state/role-editor";

function harness() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const fields = (name: string) => blankRoleCardText(name);
  let snapshot: CardsSnapshot = {
    revision: "r1",
    active: "a",
    cards: [
      { id: "a", name: "Alice", pictures: {} },
      { id: "b", name: "Bob", pictures: {} },
    ],
    selected: { id: "a", etag: "a1", fields: fields("Alice"), pictures: {} },
  };
  let failure: Error | undefined;
  const request = vi.fn(async (url: string, body?: Record<string, unknown>) => {
    if (failure) throw failure;
    if (!body) {
      const id = new URL(url, "https://local").searchParams.get("id") ?? snapshot.active;
      return structuredClone({ ...snapshot, selected: { id, etag: id === "a" ? "a1" : "b1", fields: fields(id === "a" ? "Alice" : "Bob"), pictures: {} } });
    }
    if (body.revision !== snapshot.revision) throw new ApiError(409, "config_changed");
    if (url.endsWith("/save")) {
      if (body.etag !== (body.id === "a" ? "a1" : "b1")) throw new ApiError(409, "card_changed");
      snapshot = {
        ...snapshot,
        revision: "r2",
        selected: { id: body.id as string, etag: "a2", fields: body.fields as ReturnType<typeof fields>, pictures: {} },
      };
    }
    if (url.endsWith("/switch"))
      snapshot = {
        ...snapshot,
        revision: "r2",
        active: body.id as string,
        selected: { id: body.id as string, etag: "b1", fields: fields("Bob"), pictures: {} },
      };
    if (url.endsWith("/enabled")) return { path: "~role" };
    return JSON.parse(JSON.stringify(snapshot));
  });
  const open = (writer = "test") => createRoleEditor(request as typeof api);
  return {
    values,
    request,
    open,
    fail: (error?: Error) => {
      failure = error;
    },
  };
}
it("reads the selected card and sends its etag plus explicit cleared fields", async () => {
  const h = harness(),
    view = h.open();
  await view.load("role");
  expect(view.state.value.name).toBe("Alice");
  view.edit({ ...view.state.value, name: "", rules: "" });
  expect(await view.save()).toBe(true);
  expect(h.request).toHaveBeenLastCalledWith(
    "/yesimbot/api/v1/characters/save",
    expect.objectContaining({ revision: "r1", etag: "a1", id: "a", fields: expect.objectContaining({ name: "", rules: "" }) }),
  );
  expect(h.values.size).toBe(0);
});
it("loads saved cards when reopened without restoring edits", async () => {
  const h = harness(),
    view = h.open();
  await view.load("role");
  view.edit({ ...view.state.value, name: "Alice 草稿" });
  await view.load("role", "b");
  expect(view.state.value.name).toBe("Bob");
  view.edit({ ...view.state.value, name: "Bob 草稿" });
  await view.load("role", "a");
  expect(view.state.value.name).toBe("Alice");
  expect(h.values.size).toBe(0);
});
it("keeps the original draft and etag after a conflict", async () => {
  const h = harness(),
    view = h.open();
  await view.load("role");
  view.edit({ ...view.state.value, name: "草稿" });
  h.fail(new ApiError(409, "card_changed"));
  expect(await view.save()).toBe(false);
  expect(view.state.value.name).toBe("草稿");
  expect(view.state.etag).toBe("a1");
  expect(h.values.size).toBe(0);
  expect(view.state.error).toContain("当前输入仍保留在页面中");
});
it("switches with one request and does not save or discard another card's draft", async () => {
  const h = harness(),
    view = h.open();
  await view.load("role");
  view.edit({ ...view.state.value, name: "草稿" });
  expect(await view.switchCard("b")).toBe(true);
  expect(view.state.snapshot?.active).toBe("b");
  expect(h.values.size).toBe(0);
  expect(h.request).toHaveBeenLastCalledWith("/yesimbot/api/v1/characters/switch", { path: "role", revision: "r1", id: "b" });
});
it("explicit reload discards only the selected card's draft", async () => {
  const h = harness(),
    view = h.open();
  await view.load("role");
  view.edit({ ...view.state.value, name: "草稿" });
  await view.load("role", "a");
  expect(view.state.value.name).toBe("Alice");
  expect(h.values.size).toBe(0);
});
it("late responses cannot replace another plugin's view", async () => {
  const h = harness(),
    view = h.open();
  let finish!: (value: unknown) => void;
  h.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
  );
  const old = view.load("role");
  await view.load("");
  finish({ revision: "old", active: "a", cards: [] });
  await old;
  expect(view.state.path).toBe("");
  expect(view.state.snapshot).toBeUndefined();
});

it("does not restore unsaved edits after a page reload", async () => {
  const h = harness(),
    first = h.open("before-reload");
  await first.load("role");
  first.edit({ ...first.state.value, name: "旧草稿" });
  first.dispose();
  const second = h.open("after-reload");
  await second.load("role");
  expect(second.state.value.name).toBe("Alice");
  await second.load("role", "a");
  await second.load("role", "a");
  expect(second.state.value.name).toBe("Alice");
  expect(second.dirty.value).toBe(false);
  expect(h.values.size).toBe(0);
});

it("does not restore unsaved new cards after reload", async () => {
  const h = harness(),
    first = h.open("old");
  await first.load("role");
  first.create();
  first.edit({ ...first.state.value, name: "新建草稿" });
  first.dispose();
  const second = h.open("new");
  await second.load("role");
  second.create();
  expect(second.state.value.name).toBe("");
  expect(await second.save()).toBe(true);
  expect(h.values.size).toBe(0);
  second.create();
  expect(second.state.value.name).toBe("");
});
it("reports whether turning roleplay on or off was saved", async () => {
  const h = harness(),
    view = h.open();
  expect(await view.setEnabled(false)).toBe(false);
  await view.load("role");
  expect(await view.setEnabled(false)).toBe(true);
  expect(view.state.path).toBe("~role");
  h.fail(new ApiError(409, "config_changed"));
  expect(await view.setEnabled(true)).toBe(false);
  expect(view.state.error).toBeTruthy();
});

it("stores a picture without dropping unsaved text, and the later save uses the new etag", async () => {
  let etag = "a1",
    revision = "r1",
    identity = "";
  const pictures: Record<string, string> = {};
  const snapshot = (): CardsSnapshot => ({
    revision,
    active: "a",
    cards: [{ id: "a", name: "Alice", pictures: { ...pictures }, etag }],
    selected: { id: "a", etag, fields: { ...blankRoleCardText("Alice"), identity }, pictures: { ...pictures } },
  });
  const request = vi.fn(async (url: string, body?: Record<string, unknown>, _options?: { method?: string; rawBody?: Blob }) => {
    if (url.includes("/characters/picture")) {
      const query = new URL(url, "https://local").searchParams;
      if (query.get("etag") !== etag || query.get("revision") !== revision) throw new ApiError(409, "card_changed");
      if (query.get("remove")) delete pictures[query.get("key")!];
      else pictures[query.get("key")!] = `${query.get("key")}-0123456789abcdef.jpg`;
      [etag, revision] = [etag + "p", revision + "p"];
    } else if (url.endsWith("/save")) {
      if (body?.etag !== etag || body?.revision !== revision) throw new ApiError(409, "card_changed");
      identity = (body.fields as { identity: string }).identity;
      [etag, revision] = [etag + "s", revision + "s"];
    }
    return snapshot();
  });
  const view = createRoleEditor(request as unknown as typeof api);
  await view.load("role");
  view.edit({ ...view.state.value, identity: "草稿" });
  expect(await view.setPicture("turnaround", new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }))).toBe(true);
  const [url, body, options] = request.mock.lastCall!;
  expect(url).toBe("/yesimbot/api/v1/characters/picture?path=role&revision=r1&id=a&etag=a1&key=turnaround");
  expect(body).toBeUndefined();
  expect(options).toMatchObject({ method: "POST", rawBody: expect.any(Blob) });
  expect(view.state.value.identity).toBe("草稿");
  expect(view.dirty.value).toBe(true);
  expect(view.state.etag).toBe("a1p");
  expect(cardPictureUrl("role", view.state.snapshot!.cards[0]!, "turnaround")).toBe(
    "/yesimbot/api/v1/characters/picture?path=role&id=a&key=turnaround&v=turnaround-0123456789abcdef.jpg",
  );
  expect(cardPictureUrl("role", view.state.snapshot!.cards[0]!)).toBeUndefined();
  expect(await view.save()).toBe(true);
  expect(identity).toBe("草稿");
  expect(await view.setPicture("turnaround", null)).toBe(true);
  expect(request.mock.lastCall![0]).toContain("&key=turnaround&remove=1");
});
