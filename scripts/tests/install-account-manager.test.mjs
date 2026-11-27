import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const helper = new URL("../install-account-manager.sh", import.meta.url);
test("installer help is read-only and describes private activation requirements", () => {
  const result = execFileSync("bash", [helper.pathname, "--help"], { encoding: "utf8" });
  for (const value of ["--config", "--owner-state", "--activate-owner-config", "Node >=22", "No app or QQ restart"]) assert.ok(result.includes(value));
  execFileSync("bash", ["-n", helper.pathname]);
});
test("installer rejects unknown or missing arguments without mutation", () => {
  for (const args of [
    ["--unknown"],
    ["--config"],
    ...["--computer-image", "--computer-cpus", "--computer-memory", "--computer-disk"].map((flag) => [flag, "removed"]),
  ]) {
    const result = spawnSync("bash", [helper.pathname, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes("Usage:"));
  }
});

test("installer rejects legacy computer creation config before invoking host tools or writing owner state", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yb-installer-retired-computer-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = root + "/bin",
    trace = root + "/host-commands",
    config = root + "/config.json",
    owner = root + "/owner";
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.writeFileSync(
    config,
    JSON.stringify({
      image: "yesimbot:tested",
      rootDir: root + "/members",
      tokenFile: root + "/token",
      publicOrigin: "https://bot.example",
      computer: { image: "yesimbot-computer:old" },
    }),
    { mode: 0o600 },
  );
  const script = (name, source) => fs.writeFileSync(bin + "/" + name, "#!/bin/sh\n" + source + "\n", { mode: 0o700 });
  script("id", 'test "$1" = -u && echo 0');
  script("uname", 'case "$1" in -s) echo Linux;; -m) echo x86_64;; *) exit 99;; esac');
  // Every possible host mutation stops at a recorded fixture boundary.
  for (const name of ["docker", "systemctl", "iptables", "install", "chmod", "mv"]) script(name, 'printf "%s\\n" "$0 $*" >> "$YESIMBOT_TEST_TRACE"; exit 97');
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  // Root ownership is the only simulated filesystem property; the installer's real validator reads the fixture.
  fs.writeFileSync(
    bin + "/python3",
    `#!${python}
import os, sys
from pathlib import Path
from unittest.mock import patch
source = sys.stdin.read()
sys.argv = sys.argv[1:]
original_stat = Path.stat
def root_owned_stat(self, *args, **kwargs):
    result = original_stat(self, *args, **kwargs)
    if self == Path(sys.argv[1]):
        values = list(result)
        values[4] = 0
        return os.stat_result(values)
    return result
with patch.object(Path, 'stat', root_owned_stat):
    exec(compile(source, '<installer-config-validation>', 'exec'))
`,
    { mode: 0o700 },
  );
  const result = spawnSync("bash", [helper.pathname, "--config", config, "--owner-state", owner], {
    encoding: "utf8",
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, YESIMBOT_TEST_TRACE: trace },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /computer.*(?:retired|removed|unsupported)|(?:retired|removed|unsupported).*computer/i);
  assert.ok(!fs.existsSync(trace));
  assert.ok(!fs.existsSync(owner));
  assert.ok(!fs.existsSync(root + "/members"));
  assert.ok(!fs.existsSync(root + "/token"));
});
