import { expect, it, vi } from "vitest";

import { installCharacters } from "../src/webui/characters.js";
import type { HttpContext } from "../src/webui/plugins.js";

it("guards every character route before reading files or config", async () => {
  const routes = new Map<string, (http: HttpContext) => Promise<void>>();
  const store = {
    resolve: vi.fn(() => {
      throw new Error("must not read");
    }),
  };
  let session: { role: string } | undefined;
  let sameOrigin = true;
  installCharacters(
    {
      server: {
        get: (path: string, fn: (http: HttpContext) => Promise<void>) => routes.set("GET " + path, fn),
        post: (path: string, fn: (http: HttpContext) => Promise<void>) => routes.set("POST " + path, fn),
      },
    } as never,
    { sessionFromCookie: () => session, sameOrigin: () => sameOrigin } as never,
    store as never,
  );
  expect(routes.size).toBe(7);
  for (const route of routes.values()) {
    const http = { set: vi.fn(), get: (name: string) => (name === "origin" ? "https://test" : ""), query: { path: "role" }, status: 200, body: undefined };
    session = undefined;
    await route(http as unknown as HttpContext);
    expect(http.status).toBe(401);
    session = { role: "member" };
    await route(http as unknown as HttpContext);
    expect(http.status).toBe(403);
    session = { role: "owner" };
    sameOrigin = false;
    await route(http as unknown as HttpContext);
    expect(http.status).toBe(403);
    sameOrigin = true;
  }
  expect(store.resolve).not.toHaveBeenCalled();
});
