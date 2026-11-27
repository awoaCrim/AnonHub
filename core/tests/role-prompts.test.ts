import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Agents } from "../src/agents/index.js";
import { buildCoreSystemPrompt, DEFAULT_PERSONA } from "../src/runtimes/prompt.js";

const roots: string[] = [];
const scope = { type: "direct", platform: "test", channelId: "user", selfId: "bot" } as const;
const card = {
  characterDefinition: "CARD_DEFINITION_SENTINEL",
  roleInstructions: "CARD_INSTRUCTION_SENTINEL\n<example_dialogues>EXAMPLE_SENTINEL</example_dialogues>",
};
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function root() {
  const path = await mkdtemp(join(tmpdir(), "yesimbot-role-prompt-"));
  roots.push(path);
  return path;
}

describe("unified main-Agent role ownership", () => {
  it.each([
    { name: "default", profile: undefined, identity: DEFAULT_PERSONA, hasCard: false },
    { name: "card-only", profile: card, identity: undefined, hasCard: true },
    { name: "empty profile", profile: { characterDefinition: "  ", roleInstructions: "\n" }, identity: DEFAULT_PERSONA, hasCard: false },
  ])("assembles $name before interaction and capabilities", async ({ profile, identity, hasCard }) => {
    const blocks = await buildCoreSystemPrompt({ channel: scope, selfId: "bot", roleProfile: profile });
    const all = blocks.map((block) => String(block.content)).join("\n");
    const roleBlock = blocks.find((block) => String(block.content).startsWith("# 角色\n"));
    const roleText = String(roleBlock?.content);
    expect(roleBlock).toBeDefined();
    expect(blocks.filter((block) => String(block.content).startsWith("# 角色\n"))).toHaveLength(1);
    const order = ["# 运行契约", "# 角色", "# 互动策略", "# 能力与证据边界"];
    const offsets = order.map((value) => all.indexOf(value));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(String(blocks.at(-1)?.content)).toMatch(/^<runtime_context>/);
    if (identity) expect(roleText).toContain("<persona>\n" + identity + "\n</persona>");
    else expect(all).not.toContain("Athena");
    expect(all.split("CARD_DEFINITION_SENTINEL")).toHaveLength(hasCard ? 2 : 1);
    if (hasCard) {
      for (const marker of ["CARD_DEFINITION_SENTINEL", "CARD_INSTRUCTION_SENTINEL", "EXAMPLE_SENTINEL"]) {
        expect(blocks.filter((block) => String(block.content).includes(marker))).toEqual([roleBlock]);
      }
      expect(roleText.indexOf("CARD_DEFINITION_SENTINEL")).toBeLessThan(roleText.indexOf("CARD_INSTRUCTION_SENTINEL"));
      expect(all.indexOf("EXAMPLE_SENTINEL")).toBeLessThan(all.indexOf("# 互动策略"));
      expect(roleText).toContain("<character_card>\n主角色材料");
    }
  });

  it("never reads PERSONA.md or AGENTS.md, and leaves existing files alone", async () => {
    const basePath = await root();
    await writeFile(join(basePath, "PERSONA.md"), "CUSTOM_PERSONA_SENTINEL");
    await writeFile(join(basePath, "AGENTS.md"), "AGENTS_SENTINEL");
    for (const roleProfile of [undefined, card]) {
      const all = JSON.stringify(await buildCoreSystemPrompt({ channel: scope, selfId: "bot", roleProfile }));
      expect(all).not.toContain("CUSTOM_PERSONA_SENTINEL");
      expect(all).not.toContain("AGENTS_SENTINEL");
    }
    expect(await readFile(join(basePath, "PERSONA.md"), "utf8")).toBe("CUSTOM_PERSONA_SENTINEL");
  });

  it("resolves in registration order, ignores empty providers, and rejects competing identities", async () => {
    const agents = new Agents();
    const empty = vi.fn(() => ({ characterDefinition: "  " }));
    const first = vi.fn(() => card);
    agents.use({ roleProfile: { resolve: empty }, setup: () => null });
    agents.use({ roleProfile: { resolve: first }, setup: () => null });
    await expect(agents.resolveRoleProfile(scope)).resolves.toEqual(card);
    expect(empty).toHaveBeenCalledBefore(first);
    const dispose = agents.use({ roleProfile: { resolve: () => ({ roleInstructions: "SECOND" }) }, setup: () => null });
    await expect(agents.resolveRoleProfile(scope)).rejects.toThrow("agent_role_conflict");
    dispose();
    await expect(agents.resolveRoleProfile(scope)).resolves.toEqual(card);
  });

  it("marks only opted-in providers as managed, not unrelated channel plugins", async () => {
    const agents = new Agents();
    const roleSetup = vi.fn(() => null);
    const otherSetup = vi.fn(() => null);
    agents.use({ roleProfile: { resolve: () => ({}) }, setup: roleSetup });
    agents.use({ setup: otherSetup });
    await agents.setup(scope, {} as never, { imageProjection: new EphemeralImageProjectionStore(), rolePromptsManaged: true });
    expect(roleSetup.mock.calls[0]?.[2]).toMatchObject({ rolePromptsManaged: true });
    expect(otherSetup.mock.calls[0]?.[2]).toMatchObject({ rolePromptsManaged: false });
  });
});
