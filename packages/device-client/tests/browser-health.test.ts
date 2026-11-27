import { createServer } from "node:http";

import { afterEach, expect, it } from "vitest";

import { LocalBrowserDriver } from "../src/drivers/browser.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

it("finds a browser that starts after the client", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/json/list" ? "[]" : "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const driver = new LocalBrowserDriver(`http://127.0.0.1:${port}/`);
  expect(driver.healthy()).toBe(false); // starts a background look
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(driver.healthy()).toBe(true);
});
