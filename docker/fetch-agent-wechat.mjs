// Downloads the pinned agent-wechat daemon (`wx`) and its license notices into the given directory.
// Every file is checked against its SHA-256 before it is written; a mismatch fails the image build.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// v3.0.0-beta.3 (owner decision 2026-11-23): the first release that opens stickers from Tencent's vweixinf CDN, where
// most custom stickers live. v3 is a major only for the call protocol; the /v1 message, media and send API is unchanged.
const VERSION = "v3.0.0-beta.3";
const RELEASE = `https://github.com/thisnick/agent-wechat/releases/download/${VERSION}`;
const FILES = [
  { name: "wx", mode: 0o755, url: `${RELEASE}/wx-${VERSION}-linux-x64-gnu`, sha256: "17361ff4265e71618f69bde0bc59cb5be80967a39364d115f197e37f4ede26f3" },
  {
    name: "THIRD-PARTY-NOTICES.txt",
    mode: 0o644,
    url: `${RELEASE}/wx-${VERSION}-THIRD-PARTY-NOTICES.txt`,
    sha256: "2c2b8ae50533dc8f7c86a4c930a1f31d806e53aa905cf13e2f5d7ee0fa1c1331",
  },
  {
    name: "LICENSE",
    mode: 0o644,
    url: `https://raw.githubusercontent.com/thisnick/agent-wechat/${VERSION}/LICENSE`,
    sha256: "d4d971acb3cac94865aad4787ab934038df90a304854b41f506ae1187350b574",
  },
];

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error("Usage: node fetch-agent-wechat.mjs /absolute/output/directory");
// The pinned NapCat base image is amd64 only, and so is this binary.
if (process.arch !== "x64") throw new Error(`agent-wechat is pinned for linux x64, not ${process.arch}.`);
fs.mkdirSync(output, { recursive: true });
for (const file of FILES) {
  const response = await fetch(file.url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Cannot download ${file.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== file.sha256) throw new Error(`Checksum mismatch for ${file.name}: ${digest}`);
  fs.writeFileSync(path.join(output, file.name), bytes, { mode: file.mode });
}
fs.writeFileSync(path.join(output, "VERSION"), `${VERSION}\n`, { mode: 0o644 });
