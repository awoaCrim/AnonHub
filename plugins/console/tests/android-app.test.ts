import { expect, it } from "vitest";

import { androidRelease, installPlace, qrSvg } from "../web/src/lib/android-app.js";

const RELEASE = {
  version: 1,
  versionCode: 4,
  versionName: "1.3",
  url: "/downloads/anonhub-android-1.3-0123456789ab.apk",
  size: 271274,
  sha256: "a".repeat(64),
};

// User, 2026-11-26: 「左下角图标再加个安装app，app需要一个增量更新」.
it("offers only a same-site APK with a version, a size and a SHA-256", () => {
  expect(androidRelease(RELEASE)).toEqual({ versionCode: 4, versionName: "1.3", url: RELEASE.url, size: 271274, sha256: RELEASE.sha256 });
  for (const broken of [
    { version: 2 },
    { versionCode: 0 },
    { versionName: "1.3-beta" },
    { url: "https://elsewhere.example/app.apk" },
    { url: "/downloads/../app.apk" },
    { url: "/downloads/app.zip" },
    { size: 0 },
    { sha256: "A".repeat(64) },
  ])
    expect(androidRelease({ ...RELEASE, ...broken })).toBeUndefined();
});

it("offers 安装 App on a computer and an Android phone, never inside the app or on an iPhone", () => {
  expect(installPlace("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0")).toBe("computer");
  expect(installPlace("Mozilla/5.0 (Linux; Android 16; V2417A) Chrome/140.0 Mobile")).toBe("android");
  expect(installPlace("Mozilla/5.0 (Linux; Android 16; V2417A; wv) Chrome/140.0 Mobile YesImBotApp/1.3")).toBeUndefined();
  expect(installPlace("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/604.1")).toBeUndefined();
  // iPadOS reports itself as a Mac with touch.
  expect(installPlace("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 5, "MacIntel")).toBeUndefined();
  expect(installPlace("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 0, "MacIntel")).toBe("computer");
});

it("draws the download as a dark-on-clear QR code", async () => {
  const svg = await qrSvg("https://site.example/downloads/anonhub-android-1.3-0123456789ab.apk");
  expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  expect(svg).toContain('stroke="#181818"');
  expect(svg).not.toContain("<script");
});
