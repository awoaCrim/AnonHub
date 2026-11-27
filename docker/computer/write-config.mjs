// Writes the device client's config on the computer's first start; later starts keep what is there.
// Everything is allowed on the client side: this computer belongs to one bot, and who may use it is
// decided by that bot's own reply list (groups and direct chats alike).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const state = process.argv[2];
const gateway = process.env.YESIMBOT_DEVICE_GATEWAY;
if (!state || !gateway) throw new Error("usage: write-config.mjs <state dir> (YESIMBOT_DEVICE_GATEWAY set)");
const file = join(state, "config.json");
if (existsSync(file)) {
  // This is the managed cloud computer's loopback service, including existing persisted configs.
  const existing = JSON.parse(readFileSync(file, "utf8"));
  if (existing.version !== 1 || !existing.capabilities) throw new Error("invalid_existing_config");
  if (!existing.capabilities.remoteDesktop) {
    existing.capabilities.remoteDesktop = { port: 5900 };
    const temporary = file + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(existing, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  }
  process.exit(0);
}
const all = { enabled: true, tools: ["*"] };
const local = process.env.YESIMBOT_DEVICE_LOCAL_GATEWAY;
const config = {
  version: 1,
  gateway,
  ...(local ? { localGateway: local } : {}),
  workspaceRoot: "/home/bot/workspaces",
  policy: { version: 1, direct: all, group: all, actors: [] },
  capabilities: {
    files: true,
    shell: true,
    // Files and commands start in the same per-conversation folder.
    shellConversationDirectory: true,
    // agent-desktop, the copy shipped with the client; this screen is the bot's own, so real input is fine.
    agentDesktop: { physicalInput: true },
    remoteDesktop: { port: 5900 },
    browser: { endpoint: "http://127.0.0.1:9222/" },
  },
};
mkdirSync(state, { recursive: true, mode: 0o700 });
writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
