import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Explicit pinned runtime packaging. Never installs anything on the build host. */
export async function packageWindowsNode(output, version, arch = "x64") {
  if (!/^v(?:22|24|26)\.\d+\.\d+$/.test(version) || !["x64", "arm64"].includes(arch)) throw Error("invalid_windows_node_version");
  const base = `https://nodejs.org/dist/${version}/`,
    name = `win-${arch}/node.exe`;
  const sums = (await download(base + "SHASUMS256.txt", 128 * 1024)).toString("utf8");
  const entry = sums.split("\n").find((line) => line.trim().split(/\s+/)[1] === name);
  const expected = entry?.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected ?? "")) throw Error("node_checksum_missing");
  const bytes = await download(base + name, 160 * 1024 * 1024);
  if (createHash("sha256").update(bytes).digest("hex") !== expected || bytes.subarray(0, 2).toString() !== "MZ") throw Error("node_checksum_mismatch");
  const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`;
  const license = await download(licenseUrl, 1024 * 1024);
  await writeFile(join(output, "node.exe"), bytes);
  await writeFile(join(output, "NODE_LICENSE.txt"), license);
  await writeFile(
    join(output, "node-runtime.json"),
    JSON.stringify({ version, platform: "win32", arch, source: base + name, sha256: expected, licenseSource: licenseUrl }, null, 2) + "\n",
  );
}
async function download(url, limit) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw Error("official_runtime_download_failed");
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw Error("runtime_download_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
