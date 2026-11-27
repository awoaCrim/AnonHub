import { createHmac } from "node:crypto";

import { expect, it } from "vitest";

import { sign, signedParams, workshopParams } from "../src/heybox/signing.js";

it("matches the official website vectors used by xiaoheihe-cli", () => {
  const nonce = "0123456789ABCDEF0123456789ABCDEF";
  expect(sign("/account/get_qrcode_url/", 1700000000, nonce)).toBe("UV77P62");
  expect(sign("bbs/app/api/link/post/", 1700000000, nonce)).toBe("YT27P47");
});

it("builds signed query parameters and the write signature", () => {
  const params = signedParams("/bbs/app/feeds", 1700000000, "N");
  expect(params).toEqual({ hkey: sign("/bbs/app/feeds", 1700000000, "N"), _time: "1700000000", nonce: "N" });
  expect(signedParams("/x").nonce).toMatch(/^[0-9A-F]{32}$/);
  const salt = "Z7mFG4tQp9Ws2LxB8H";
  expect(workshopParams(params)._rnd).toBe("15:" + createHmac("sha256", salt).update(`${salt}N1700000000:N`).digest("hex"));
});
