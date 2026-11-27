import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { partsFromElements } from "@yesimbot/contracts/parts";
import { afterEach, expect, it, vi } from "vitest";

import { ChatConversations, MAX_REACTIONS } from "../src/webui/chat-conversations.js";
import { reactionEmoji } from "../src/webui/chat-reactions.js";
import { chatChoices, projectChatParts } from "../src/webui/web-chat.js";
import { ApiError } from "../web/src/lib/api";
import { voiceError } from "../web/src/lib/voice-input";
import { createWebChat } from "../web/src/state/web-chat";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

it("accepts exactly one emoji as a reaction", () => {
  for (const emoji of ["👍", "❤️", "👨‍👩‍👧", "🇨🇳", " 😂 "]) expect(reactionEmoji(emoji)).toBe(emoji.trim());
  for (const value of ["", "ok", "好", "👍👍", "👍 好", 1, undefined]) expect(reactionEmoji(value)).toBeUndefined();
});

it("keeps choices out of the message text, and only a few short distinct ones", () => {
  const projected = projectChatParts(
    partsFromElements([
      { type: "text", attrs: { content: "要发吗？" }, children: [] },
      { type: "web-choices", attrs: { options: ["发", "等等", "发", "", "x".repeat(41), 3, "a", "b", "c"] }, children: [] },
    ]),
  );
  expect(projected).toMatchObject({ text: "要发吗？", attachments: [], choices: ["发", "等等", "a", "b"] });
  expect(chatChoices("发")).toEqual([]);
});

it("keeps one reaction per message, the newest ones only, and drops damaged ones when reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-chat-reactions-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "web-chat.json");
  const store = new ChatConversations(file);
  await store.load();
  await store.react("", "m1", "👍");
  await store.react("", "m1", "❤️");
  for (let index = 0; index < MAX_REACTIONS + 5; index++) await store.react("", `n${index}`, "😂");
  await expect(store.react("missing", "m1", "👍")).rejects.toThrow("conversation_not_found");
  const saved = JSON.parse(await readFile(file, "utf8"));
  expect(Object.keys(saved.conversations[0].reactions)).toHaveLength(MAX_REACTIONS);
  expect(saved.conversations[0].reactions.m1).toBeUndefined();
  saved.conversations[0].reactions = { ok: "👍", bad: 5, ["x".repeat(200)]: "👍" };
  await writeFile(file, JSON.stringify(saved));
  const reread = new ChatConversations(file);
  await reread.load();
  expect(reread.get("")?.reactions).toEqual({ ok: "👍" });
});

it("explains voice input failures in plain words and stays quiet when nothing was said", () => {
  expect(voiceError("no-speech")).toBe("");
  expect(voiceError("aborted")).toBe("");
  expect(voiceError("not-allowed")).toContain("麦克风");
  expect(voiceError("network")).toContain("语音识别服务");
  expect(voiceError("something-else")).toBeTruthy();
});

it("asks the server to stop the open conversation's reply and explains a failure", async () => {
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (path === "/yesimbot/api/v1/chat/stop") {
      if ((body as { conversation: string }).conversation === "0000abcd") throw new ApiError(503, "runtime_not_ready");
      return { stopped: true };
    }
    throw Error("unexpected");
  });
  const chat = createWebChat(request as never);
  expect(await chat.stop()).toBe("");
  expect(request).not.toHaveBeenCalled();
  chat.accept({ conversation: { platform: "web", channel: "c", session: "s", id: "" }, messages: [], typing: true });
  expect(await chat.stop()).toBe("");
  expect(request).toHaveBeenCalledWith("/yesimbot/api/v1/chat/stop", { conversation: "" });
  chat.accept({ conversation: { platform: "web", channel: "c", session: "s", id: "0000abcd" }, messages: [], typing: true });
  expect(await chat.stop()).toBe("没能停下，请稍后再试。");
  expect(chat.state.stopping).toBe(false);
});
