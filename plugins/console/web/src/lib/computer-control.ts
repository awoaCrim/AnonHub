import { onBeforeUnmount, ref, watch, type Ref } from "vue";

/**
 * The owner's takeover of one computer. `source` decides at takeover what is controlled: the desktop, or the bot
 * browser's tab (`source` of the lease, fixed until it is handed back).
 */
export function useComputerControl(
  device: Ref<string | undefined>,
  paused: Ref<boolean>,
  ready: () => boolean = () => true,
  source: () => "desktop" | "browser" = () => "desktop",
) {
  const token = ref("");
  const controlled = ref<"desktop" | "browser">("desktop");
  const busy = ref(false);
  const error = ref("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let pending = Promise.resolve();
  let queued = 0;
  let tail: { action: unknown; started: boolean; epoch: number; done: Promise<void> } | undefined;
  const textOf = (action: unknown) => {
    if (!action || typeof action !== "object") return;
    const value = action as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? value.text : undefined;
  };
  const messages: Record<string, string> = {
    computer_control_busy: "电脑仍在执行操作或已被接管，请稍后重试。",
    computer_control_expired: "接管已结束，请重新接管。",
    computer_control_unavailable: "这台电脑暂时无法接管。",
    computer_input_unconfirmed: "操作结果未确认，请查看画面后再操作；不会自动重复输入。",
  };
  async function request(id: string, op: string, lease?: string, action?: unknown, target?: "desktop" | "browser") {
    const response = await fetch("/yesimbot/api/v1/devices/control", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: id, op, ...(lease ? { token: lease } : {}), ...(action ? { action } : {}), ...(target ? { source: target } : {}) }),
      signal: AbortSignal.timeout(25_000),
    });
    const body = await response.json();
    if (!response.ok) throw Error(messages[body.message] ?? "电脑连接失败，请重试。");
    return body;
  }

  function release(id = device.value) {
    generation++;
    clearTimeout(timer);
    const lease = token.value;
    token.value = "";
    busy.value = false;
    if (id && lease)
      void fetch("/yesimbot/api/v1/devices/control", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: id, op: "release", token: lease }),
      }).catch(() => {});
  }

  function heartbeat(id: string, lease: string, epoch: number) {
    timer = setTimeout(async () => {
      try {
        await request(id, "renew", lease);
        if (generation === epoch) heartbeat(id, lease, epoch);
      } catch (cause) {
        if (generation === epoch) {
          error.value = (cause as Error).message;
          release(id);
        }
      }
    }, 10_000);
  }

  async function toggle() {
    if (token.value) return release();
    const id = device.value;
    if (!id || busy.value) return;
    const epoch = ++generation;
    busy.value = true;
    error.value = "";
    try {
      const target = source();
      const result = await request(id, "acquire", undefined, undefined, target === "browser" ? target : undefined);
      if (epoch !== generation) {
        await request(id, "release", result.token);
        return;
      }
      controlled.value = target;
      token.value = result.token;
      paused.value = false;
      heartbeat(id, result.token, epoch);
    } catch (cause) {
      if (epoch === generation) error.value = (cause as Error).message;
    } finally {
      if (epoch === generation) busy.value = false;
    }
  }

  function send(action: unknown): Promise<void> {
    if (!token.value || !device.value) return Promise.resolve();
    if (!ready() && !queued) {
      error.value = "画面尚未恢复，请等待更新后操作。";
      return Promise.resolve();
    }
    const addition = textOf(action),
      previous = textOf(tail?.action);
    // Fast typing is one paste where possible, but never merge across a click or a key.
    if (tail && !tail.started && tail.epoch === generation && addition !== undefined && previous !== undefined && previous.length + addition.length <= 4000) {
      tail.action = { type: "text", text: previous + addition };
      return tail.done;
    }
    if (queued >= 64) {
      error.value = "输入过快，已停止接管；请确认电脑状态后再操作。";
      release();
      return Promise.resolve();
    }
    const epoch = generation,
      id = device.value,
      lease = token.value;
    queued++;
    busy.value = true;
    const entry = { action, started: false, epoch, done: Promise.resolve() };
    tail = entry;
    pending = pending
      .then(async () => {
        entry.started = true;
        if (epoch !== generation) return;
        error.value = "";
        try {
          await request(id, "input", lease, entry.action);
        } catch (cause) {
          if (epoch === generation) {
            error.value = (cause as Error).message;
            // Discard remaining gestures: their targets may have changed after this failure.
            release(id);
          }
        }
      })
      .finally(() => {
        queued--;
        if (epoch === generation) busy.value = queued > 0;
      });
    entry.done = pending;
    return pending;
  }

  function key(event: KeyboardEvent) {
    if (!token.value || event.isComposing) return;
    const keys: Record<string, string> = {
      Enter: "Return",
      Backspace: "BackSpace",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      ArrowUp: "Up",
      ArrowDown: "Down",
      PageUp: "Page_Up",
      PageDown: "Page_Down",
      Tab: event.shiftKey ? "shift+Tab" : "Tab",
      Escape: "Escape",
      Delete: "Delete",
      Home: "Home",
      End: "End",
    };
    const modifiers = [event.ctrlKey ? "ctrl" : "", event.metaKey ? "cmd" : "", event.altKey ? "alt" : "", event.shiftKey ? "shift" : ""].filter(Boolean);
    const name = keys[event.key]?.replace("shift+", "") ?? (/^F(?:[1-9]|1[0-2])$/.test(event.key) ? event.key : undefined);
    const shortcut = (event.ctrlKey || event.metaKey || event.altKey) && /^[a-z0-9]$/i.test(event.key) ? event.key.toLowerCase() : undefined;
    const combo = name || shortcut ? [...modifiers, name ?? shortcut].join("+") : undefined;
    if (!combo) return;
    event.preventDefault();
    event.stopPropagation();
    void send({ type: "key", key: combo });
  }
  watch(device, (_value, previous) => release(previous));
  watch(paused, (value) => {
    if (value) release();
  });
  onBeforeUnmount(() => release());
  return { token, controlled, busy, error, toggle, release, send, key };
}
