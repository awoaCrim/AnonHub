import { beforeEach, expect, it, vi } from "vitest";

const api = vi.fn(async () => ({ archived: true }));
const confirm = vi.fn(async () => true);
const toast = vi.fn();
vi.mock("../web/src/lib/api", async (original) => ({ ...(await original<object>()), api }));
vi.mock("../web/src/lib/dialog", () => ({ confirmDialog: confirm }));
vi.mock("../web/src/lib/toast", () => ({ toast }));

const { ApiError } = await import("../web/src/lib/api");
const { archiveConversation } = await import("../web/src/lib/archive-conversation");

const target = { channel: "own-channel", session: "old.jsonl", label: "好友" };
const open = () => ({ channel: "own-channel", session: "old.jsonl" });

beforeEach(() => {
  api.mockClear();
  confirm.mockClear();
  toast.mockClear();
});

it("archives the exact session once the owner confirms, even though the menu that asked is gone", async () => {
  expect(await archiveConversation(target, open)).toBe(true);
  expect(api).toHaveBeenCalledExactlyOnceWith("/yesimbot/api/v1/conversations/archive", { channel: "own-channel", session: "old.jsonl" });
  expect(toast).toHaveBeenCalledWith("已开始新会话，旧记录已归档。");
});

it("submits once for a double click", async () => {
  await Promise.all([archiveConversation(target, open), archiveConversation(target, open)]);
  expect(confirm).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledOnce();
});

it("does not submit after cancel or when another session is open by the time the owner answers", async () => {
  confirm.mockResolvedValueOnce(false);
  expect(await archiveConversation(target, open)).toBe(false);
  expect(await archiveConversation(target, () => ({ channel: "own-channel", session: "new.jsonl" }))).toBe(false);
  expect(await archiveConversation(target, () => undefined)).toBe(false);
  expect(api).not.toHaveBeenCalled();
});

it("reports a conflict without claiming success", async () => {
  api.mockRejectedValueOnce(new ApiError(409, "conversation_changed"));
  expect(await archiveConversation(target, open)).toBe(false);
  expect(toast).toHaveBeenCalledWith("当前会话已变化，请等待列表更新后重试。", "danger");
});
