import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { OneBotSocket, type OneBotEvent } from "../src/protocol.js";

/** The socket NapCat dialed, as the connector's endpoint gets it; `sent` holds what we wrote. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
  ping() {}
  answer(echo: unknown, reply: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify({ ...reply, echo })), false);
  }
}

function open(timeoutMs = 1000) {
  const socket = new FakeSocket();
  const events: OneBotEvent[] = [];
  const onClose = vi.fn();
  const connection = new OneBotSocket(socket as never, { timeoutMs, onEvent: (event) => events.push(event), onClose });
  return { socket, connection, events, onClose };
}

describe("one OneBot 11 connection", () => {
  it("matches answers to actions by echo and passes everything else on as events", async () => {
    const { socket, connection, events } = open();
    const first = connection.call<{ user_id: number }>("get_login_info");
    const second = connection.request("send_private_msg", { user_id: 1, message: [] });
    expect(socket.sent.map(({ action, echo }) => [action, echo])).toEqual([
      ["get_login_info", "1"],
      ["send_private_msg", "2"],
    ]);
    socket.answer("2", { status: "failed", retcode: 1200, data: null, message: "发送失败" });
    socket.answer("1", { status: "ok", retcode: 0, data: { user_id: 10001 } });
    socket.emit("message", Buffer.from(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat" })), false);
    expect(await first).toEqual({ user_id: 10001 });
    expect(await second).toMatchObject({ status: "failed", retcode: 1200 });
    expect(events).toEqual([{ post_type: "meta_event", meta_event_type: "heartbeat" }]);
  });

  it("turns a failed answer into onebot_action_failed with QQ's own words only in the detail", async () => {
    const { socket, connection } = open();
    const call = connection.call("set_group_ban", { group_id: 1 });
    socket.answer("1", { status: "failed", retcode: 102, data: null, wording: "权限不足" });
    await expect(call).rejects.toMatchObject({ code: "onebot_action_failed", detail: "set_group_ban: 102 权限不足" });
  });

  it("fails an action that gets no answer in time, and everything still waiting when the connection closes", async () => {
    vi.useFakeTimers();
    try {
      const { socket, connection, onClose } = open();
      const late = connection.call("get_msg", { message_id: 1 }, 100);
      const waiting = connection.call("get_msg", { message_id: 2 }, 10_000);
      const settled = Promise.allSettled([late, waiting]);
      await vi.advanceTimersByTimeAsync(100);
      socket.close();
      const [first, second] = await settled;
      expect(first).toMatchObject({ status: "rejected", reason: { code: "onebot_action_timeout" } });
      expect(second).toMatchObject({ status: "rejected", reason: { code: "onebot_disconnected" } });
      expect(onClose).toHaveBeenCalledOnce();
      await expect(connection.call("get_login_info")).rejects.toMatchObject({ code: "onebot_disconnected" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores what is not JSON and answers nobody asked for", () => {
    const { socket, events } = open();
    socket.emit("message", Buffer.from("not json"), false);
    socket.answer("99", { status: "ok", retcode: 0, data: null });
    expect(events).toEqual([]);
  });
});
