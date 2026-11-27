const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// The supervisor (host.mjs) starts this in the instance's app directory: the host (apps/server) with that directory as
// its state. Instances set up before leave-koishi stage 8 keep their settings in koishi.yml, which the host never reads.
const state = process.cwd();
if (!fs.existsSync(path.join(state, "config")) && fs.existsSync(path.join(state, "koishi.yml"))) {
  console.error("This instance's settings are still in koishi.yml, which this version no longer reads; set the instance up again.");
  process.exit(64);
}
const main = path.join(__dirname, "apps", "server", "dist", "main.js");
process.argv = [process.argv[0], main, "--state", state];
// Windows delivers no SIGTERM to a child; the supervisor asks over IPC instead.
process.on("message", (message) => {
  if (message?.type === "exit") process.emit("SIGTERM");
});
import(pathToFileURL(main).href).catch((error) => {
  console.error(error);
  process.exit(1);
});
