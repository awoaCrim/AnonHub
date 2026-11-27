import { randomUUID } from "node:crypto";

import type { AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { configureLogging, type LogRecord } from "@yesimbot/foundation";
import { beforeEach, expect, it, vi } from "vitest";

import type { GoogleManager } from "../src/connector.js";
import { googleError } from "../src/errors.js";
import { mailSchema, mailView, rawMail } from "../src/mail.js";
import { createGoogleTools } from "../src/tools.js";

const accountId = randomUUID();
const records: LogRecord[] = [];
beforeEach(() => {
  records.length = 0;
  configureLogging({ sink: (record) => records.push(record) });
});
const context = { runtime: { id: "runtime-a" }, turnId: "turn-a", toolCallId: "call-a", abortSignal: new AbortController().signal } as AgentToolExecuteContext;
const own = [{ id: accountId, email: "a@example.com", permissions: { gmail: "manage", calendar: "read" } }];
function tools(respond: (args: Parameters<GoogleManager["api"]>) => unknown = () => ({}), accounts: unknown[] = own) {
  const api = vi.fn(async (...args: Parameters<GoogleManager["api"]>) => respond(args));
  const snapshot = vi.fn(async () => ({ accounts }));
  const catalog = createGoogleTools({ api, snapshot } as unknown as GoogleManager);
  const run = (name: string, input: unknown, execution = context) => catalog.find((tool) => tool.name === name)!.execute(input, execution);
  return { api, catalog, run };
}

it("validates input before any request, including header injection and unknown fields", async () => {
  const { run, api } = tools();
  for (const input of [
    { accountId, action: "create", mail: { to: ["a@example.com"], subject: "Hello\r\nBcc: attacker@example.com", body: "x" } },
    { accountId, action: "create", mail: { to: ["a@example.com\r\nBcc: attacker@example.com"], subject: "Hi", body: "x" } },
    { accountId, action: "delete" },
    { accountId, action: "create", mail: { to: ["a@example.com"], subject: "Hi", body: "x", from: "spoof@example.com" } },
  ])
    await expect(run("gmail_draft", input)).resolves.toMatchObject({ ok: false, error: { code: "google_invalid_input" } });
  await expect(run("gmail_send", { accountId, draftId: "a", url: "https://evil.example" })).resolves.toMatchObject({
    ok: false,
    error: { code: "google_invalid_input" },
  });
  expect(api).not.toHaveBeenCalled();
});
it("creates an RFC822 UTF-8 draft and keeps sending in a separate tool", async () => {
  const { run, api } = tools();
  const mail = { to: ["friend@example.com"], subject: "你好，测试邮件", body: "第一行\n第二行" };
  await run("gmail_draft", { accountId, action: "create", mail });
  const [id, service, mode, path, options] = api.mock.calls[0];
  expect([id, service, mode, path, options.method]).toEqual([accountId, "gmail", "manage", "/drafts", "POST"]);
  const raw = Buffer.from(options.body.message.raw, "base64url").toString();
  expect(raw).toContain("To: friend@example.com\r\n");
  expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from(mail.subject).toString("base64")}?=`);
  const body = raw.split("\r\n\r\n")[1];
  expect(Buffer.from(body, "base64").toString()).toBe("第一行\r\n第二行");
  await run("gmail_send", { accountId, draftId: "draft-1" });
  expect(api.mock.calls[1][3]).toBe("/drafts/send");
  expect(api.mock.calls[1][4].body).toEqual({ id: "draft-1" });
  expect(api.mock.calls[0][4].operationId).not.toBe(api.mock.calls[1][4].operationId);
});
it("updates drafts using PUT and rejects effects without operation context", async () => {
  const { run, api } = tools();
  await run("gmail_draft", { accountId, action: "update", draftId: "d1", mail: { to: ["a@example.com"], subject: "s", body: "b" } });
  expect(api.mock.calls[0][4].method).toBe("PUT");
  await expect(run("gmail_send", { accountId, draftId: "d1" }, {} as never)).resolves.toMatchObject({
    ok: false,
    error: { code: "google_operation_id_required" },
  });
  expect(api).toHaveBeenCalledTimes(1);
});
it("returns search summaries within one tool and bounds metadata concurrency to four", async () => {
  let active = 0,
    maximum = 0;
  const { run } = tools(async ([, , , path]) => {
    if (path === "/messages") return { messages: Array.from({ length: 11 }, (_, i) => ({ id: `m${i}` })), nextPageToken: "next" };
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return {
      id: path.split("/").at(-1),
      payload: {
        headers: [
          { name: "Subject", value: "One" },
          { name: "From", value: "sender@example.com" },
        ],
      },
    };
  });
  const result = await run("gmail", { accountId, action: "search", query: "is:unread", limit: 11 });
  expect(result.messages).toHaveLength(11);
  expect(result.messages[0].subject).toBe("One");
  expect(result.nextPageToken).toBe("next");
  expect(maximum).toBe(4);
});
it("extracts mail text and attachment metadata without downloading attachments, and bounds large content", () => {
  const result = mailView(
    {
      id: "m1",
      payload: {
        parts: [
          { mimeType: "text/plain", body: { data: Buffer.from("x".repeat(90_000)).toString("base64url") } },
          { filename: "invoice.pdf", mimeType: "application/pdf", body: { attachmentId: "att-1", size: 12000 } },
        ],
      },
    },
    true,
  );
  expect(result.body).toHaveLength(48_000);
  expect(result.truncated).toBe(true);
  expect(result.attachments).toEqual([{ id: "att-1", name: "invoice.pdf", mimeType: "application/pdf", size: 12000 }]);
  const longSubject = "😀".repeat(100);
  const raw = Buffer.from(rawMail(mailSchema.parse({ to: ["a@example.com"], subject: longSubject, body: "x" }), "safe-id"), "base64url").toString();
  const encoded = raw.match(/=\?UTF-8\?B\?[^?]*\?=/g)!;
  expect(encoded.every((word) => word.length <= 75)).toBe(true);
  expect(encoded.map((word) => Buffer.from(word.slice(10, -2), "base64").toString()).join("")).toBe(longSubject);
});
it("uses valid calendar ranges and does not notify attendees unless requested", async () => {
  const { run, api } = tools();
  for (const event of [
    { summary: "x", start: { date: "2026-11-10" }, end: { date: "2026-11-09" } },
    { summary: "x", start: { date: "2026-02-31" }, end: { date: "2026-03-04" } },
    { summary: "x", start: { date: "2026-11-10" }, end: { dateTime: "2026-11-11T10:00:00Z" } },
  ])
    await expect(run("google_calendar_write", { accountId, action: "create", event })).resolves.toMatchObject({
      ok: false,
      error: { code: "google_invalid_input" },
    });
  await run("google_calendar_write", {
    accountId,
    action: "create",
    event: {
      summary: "Meeting",
      start: { dateTime: "2026-11-10T10:00:00+08:00" },
      end: { dateTime: "2026-11-10T11:00:00+08:00" },
      attendees: [{ email: "friend@example.com" }],
    },
  });
  expect(api.mock.calls[0][3]).toBe("/calendars/primary/events");
  expect(api.mock.calls[0][4].query.sendUpdates).toBe("none");
  expect(api.mock.calls[0][4].body.id).toMatch(/^[a-f0-9]{64}$/);
  await run("google_calendar_write", { accountId, action: "delete", eventId: "event-1", notifyAttendees: true });
  expect(api.mock.calls[1][4].query.sendUpdates).toBe("all");
});
it("reads calendar events only for a valid range or an explicit event ID", async () => {
  const { run, api } = tools();
  await expect(run("google_calendar", { accountId, action: "events" })).resolves.toMatchObject({ status: "rejected", code: "invalid_input" });
  await run("google_calendar", { accountId, action: "events", calendarId: "friend@example.com", eventId: "event-1" });
  expect(api.mock.calls[0][3]).toBe("/calendars/friend%40example.com/events/event-1");
});
it("exports Google docs as text and never tries to interpret a binary file as text", async () => {
  const { run, api } = tools(([, , , path]) =>
    path.endsWith("/export") ? "Document body" : { id: "f1", mimeType: "application/vnd.google-apps.document", name: "doc" },
  );
  expect((await run("google_drive", { accountId, action: "read", fileId: "f1", readText: true })).text).toBe("Document body");
  expect(api.mock.calls[1][4]).toMatchObject({ query: { mimeType: "text/plain" }, text: true });
  const binary = tools(() => ({ id: "f2", mimeType: "application/pdf" }));
  expect((await binary.run("google_drive", { accountId, action: "read", fileId: "f2", readText: true })).textUnavailable).toBe("binary_file");
  expect(binary.api).toHaveBeenCalledTimes(1);
});
it("creates text by multipart upload, and trashes files without permanently deleting or sharing them", async () => {
  const { run, api } = tools();
  await run("google_drive_write", { accountId, action: "create_text", name: "notes.txt", content: "Hello", addParent: "folder-1" });
  expect(api.mock.calls[0][4]).toMatchObject({
    method: "POST",
    query: { uploadType: "multipart" },
    multipart: { metadata: { name: "notes.txt", mimeType: "text/plain", parents: ["folder-1"] }, content: "Hello" },
  });
  await run("google_drive_write", { accountId, action: "trash", fileId: "f1" });
  expect(api.mock.calls[1][4]).toMatchObject({ method: "PATCH", body: { trashed: true } });
  await expect(
    run("google_drive_write", { accountId, action: "update", fileId: "f1", permissions: [{ role: "writer", type: "anyone" }] }),
  ).resolves.toMatchObject({ ok: false, error: { code: "google_invalid_input" } });
});
it("returns a failed call as the registered sentence with its code and effect, and logs the cause", async () => {
  const unknown = tools(() => {
    throw googleError("google_result_unknown", { cause: new Error("provider text with person@example.com") });
  });
  const result = await unknown.run("gmail_send", { accountId, draftId: "d1" });
  expect(result).toEqual({
    ok: false,
    error: { code: "google_result_unknown", message: "写入结果不确定，可能已经生效。先查询实际状态，不要自动重复写入。", retryable: false },
    effect: "unknown",
  });
  expect(JSON.stringify(result)).not.toContain("provider text");
  expect(records.find((record) => record.event === "tool.failed")).toMatchObject({ tool: "gmail_send", code: "google_result_unknown" });
  expect(JSON.stringify(records)).toContain("provider text");

  const foreign = tools(() => {
    throw new Error("raw upstream failure with a token");
  });
  await expect(foreign.run("gmail", { accountId, action: "labels" })).resolves.toMatchObject({
    ok: false,
    error: { code: "google_operation_failed", message: "Google 操作没有完成。" },
    effect: "none",
  });
  const aborted = new AbortController();
  aborted.abort();
  await expect(foreign.run("gmail", { accountId, action: "labels" }, { ...context, abortSignal: aborted.signal })).resolves.toMatchObject({
    ok: false,
    error: { code: "google_cancelled" },
  });
});
it("uses the only usable connection without an accountId, and lists the choices when there are several or none", async () => {
  const { run, api } = tools();
  await run("gmail", { action: "labels" });
  expect(api.mock.calls[0][0]).toBe(accountId);
  const other = { id: randomUUID(), email: "b@example.com", permissions: { gmail: "read" } };
  const several = tools(() => ({}), [...own, other]);
  await expect(several.run("gmail", { action: "labels" })).resolves.toMatchObject({
    status: "rejected",
    code: "google_account_required",
    accounts: [
      { accountId, email: "a@example.com" },
      { accountId: other.id, email: "b@example.com", permissions: { gmail: "read" } },
    ],
  });
  // Only one connection may manage mail, so a write needs no choice either.
  await several.run("gmail_send", { draftId: "d1" });
  expect(several.api.mock.calls[0][0]).toBe(accountId);
  expect(several.api).toHaveBeenCalledTimes(1);
  await expect(tools(() => ({}), []).run("gmail", { action: "labels" })).resolves.toMatchObject({ status: "rejected", code: "google_not_connected" });
  await expect(tools(() => ({}), own).run("google_drive", { action: "search" })).resolves.toMatchObject({
    status: "rejected",
    code: "google_no_usable_account",
  });
  await expect(run("gmail", { action: "read" })).resolves.toMatchObject({ status: "rejected", code: "invalid_input" });
});
