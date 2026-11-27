import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEntry } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { Conversation } from "../src/conversations/index.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("conversation sessions", () => {
  it("lists the active session and switches to a persisted session", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-session-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "hello" }));
    const first = (await conversation.list()).find((item) => item.isActive)!;

    await conversation.archive(true);
    const second = (await conversation.list()).find((item) => item.isActive)!;
    expect(second.filename).not.toBe(first.filename);
    expect((await conversation.status()).active?.filename).toBe(second.filename);

    await conversation.switch(first.filename);
    expect((await conversation.status()).active?.filename).toBe(first.filename);
    expect(await conversation.storage.read()).toHaveLength(1);
    expect((await conversation.storage.read())[0]).toMatchObject({ type: "message", data: expect.objectContaining({ content: "hello" }) });
  });

  it("rejects invalid session identifiers without changing active storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-session-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    const active = (await conversation.status()).active?.filename;
    await expect(conversation.switch("../messages.jsonl")).rejects.toThrow("conversation_session_invalid");
    expect((await conversation.status()).active?.filename).toBe(active);
  });
});
