#!/usr/bin/env node
// Publishes the phone app on the site (user, 2026-11-26: 「左下角图标再加个安装app，app需要一个增量更新」): the release
// APK under /downloads with its hash in the name (cached for good), and android.json (never cached), which the
// console's 安装 App and the app's own update check (apps/android Updater.kt) read. The APK goes up first, then the
// manifest is switched in one rename, so no one is ever pointed at a file that is not there yet.
//
//   ~/.local/opt/android-build/build.sh assembleRelease
//   node scripts/publish-android.mjs                                   # writes .release-local/android/downloads
//   node scripts/publish-android.mjs --upload ssh1:/opt/yesimbot-preview/data/koishi/downloads
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    apk: { type: "string", default: "apps/android/app/build/outputs/apk/release/app-release.apk" },
    out: { type: "string", default: ".release-local/android/downloads" },
    upload: { type: "string" },
  },
});
const apkPath = resolve(values.apk);
const bytes = await readFile(apkPath);
const metadata = JSON.parse(await readFile(join(dirname(apkPath), "output-metadata.json"), "utf8"));
const build = metadata.elements?.[0];
if (metadata.variantName !== "release" || !Number.isSafeInteger(build?.versionCode) || typeof build?.versionName !== "string")
  throw new Error("not a release build: run ~/.local/opt/android-build/build.sh assembleRelease");
if (!/^[0-9]+(\.[0-9]+){0,3}$/.test(build.versionName)) throw new Error(`unexpected versionName ${build.versionName}`);
// A v2+ signature lives in the APK Signing Block; an unsigned release (no key on this machine) cannot update anyone.
if (!bytes.includes(Buffer.from("APK Sig Block 42"))) throw new Error("the APK is not signed (no ~/.config/yesimbot/android-release.properties?)");

const sha256 = createHash("sha256").update(bytes).digest("hex");
const name = `anonhub-android-${build.versionName}-${sha256.slice(0, 12)}.apk`;
const manifest = { version: 1, versionCode: build.versionCode, versionName: build.versionName, url: `/downloads/${name}`, size: bytes.length, sha256 };
const out = resolve(values.out);
await mkdir(out, { recursive: true });
await writeFile(join(out, name), bytes);
await writeFile(join(out, "android.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${name} (${bytes.length} bytes, versionCode ${build.versionCode}) and android.json in ${out}`);

if (values.upload) {
  const [host, dir] = values.upload.split(/:(.*)/s);
  if (!host || !dir?.startsWith("/")) throw new Error("--upload is <ssh host>:<absolute directory>");
  const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
  run("scp", ["-q", join(out, name), `${host}:${dir}/${name}`]);
  run("scp", ["-q", join(out, "android.json"), `${host}:${dir}/.android.json.next`]);
  run("ssh", [host, `chmod 644 '${dir}/${name}' '${dir}/.android.json.next' && mv -f '${dir}/.android.json.next' '${dir}/android.json'`]);
  console.log(`published to ${host}:${dir}`);
}
