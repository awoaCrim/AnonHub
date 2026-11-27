import { mkdir, open, readFile, link, unlink, lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  BROWSER_VIEW_READ,
  browserControlInputSchema,
  conversationSchema,
  deviceInvocationSchema,
  SCREEN_VIEW_PLATFORM,
  SCREEN_VIEW_READS,
  uuid,
  type ActorIdentity,
  type ControlAction,
  type ConversationIdentity,
  type DeviceInvocation,
  type DeviceView,
  type OperationResult,
  type DeviceTransport,
  type DesktopReceiver,
  type DesktopTunnel,
} from "@yesimbot/contracts";
import { AppError, defineErrors, newId, systemClock, type Clock } from "@yesimbot/foundation";

import type { ChannelContext } from "./channels/context.js";
import { ComputerActivity } from "./computer-activity.js";

/** The runtime's identity on disk and its device connection. */
export const DEVICE_ERRORS = defineErrors({
  identity_file_invalid: { model: "运行身份文件不安全或已损坏。", user: "运行身份文件不安全或已损坏。", status: 500 },
  identity_invalid: { model: "运行身份文件的格式无法识别。", user: "运行身份文件的格式无法识别。", status: 500 },
  identity_tenant_mismatch: { model: "数据目录属于另一个账号运行时。", user: "数据目录属于另一个账号运行时。", status: 500 },
  device_resolver_duplicate: { model: "设备选择重复登记。", user: "设备选择重复登记。", status: 500 },
  device_transport_duplicate: { model: "设备连接重复登记。", user: "设备连接重复登记。", status: 500 },
  device_connection_unavailable: { model: "设备连接不可用。", user: "设备连接不可用。", status: 503, retryable: true },
});

/** Viewer capture deadline; a bot desktop call waits at most this long for a capture already in flight. */
const VIEWER_DEADLINE_MS = 10_000;

/** How long a reader waits for a concurrent identity creator to drop its temporary name (40 × 25 ms). */
const IDENTITY_LINK_RETRIES = 40;

const IDENTITY_LINK_RETRY_MS = 25;

/** What the owner's screen view shows: the desktop, or the tab of the bot's own browser. */
export type ScreenSource = "desktop" | "browser";

/** The bound computer the bot switched to itself, in force until the owner chooses again. */
export interface WorkspaceComputerSwitch {
  deviceId: string;
  switchedAt: number;
}

/** Owned by the workspace plugin, alongside its resolver. */
export interface WorkspaceSwitchControl {
  current(): WorkspaceComputerSwitch | undefined;
  /** The owner's choice: drop the bot's switch so the configured computer applies again. */
  clear(): Promise<void>;
}

/** A runtime account is distinct from each bot, conversation, participant and paired computer. */
export class RuntimeIdentity {
  private identity?: Promise<string>;
  constructor(
    private readonly directory: string,
    private readonly configuredTenant?: string,
  ) {}
  tenantId(): Promise<string> {
    return (this.identity ??= this.load());
  }
  async conversation(scope: ChannelContext): Promise<ConversationIdentity> {
    return conversationSchema.parse({
      tenantId: await this.tenantId(),
      botId: scope.selfId,
      platform: scope.platform,
      kind: scope.type === "direct" ? "direct" : "group",
      conversationId: scope.channelId,
      ...(scope.type === "channel" ? { parentId: scope.guildId } : {}),
    });
  }
  private async load(): Promise<string> {
    const configured = this.configuredTenant ? uuid.parse(this.configuredTenant) : undefined;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "runtime-identity.json");
    const temporary = join(this.directory, `.runtime-identity-${newId()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, tenantId: configured ?? newId() }) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
    // A concurrent creator's `link` leaves the file with two names until it removes its temporary
    // name, so a second link count is waited out briefly; a lasting hard link is still rejected.
    let metadata = await lstat(path);
    for (let attempt = 0; metadata.nlink === 2 && attempt < IDENTITY_LINK_RETRIES; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, IDENTITY_LINK_RETRY_MS));
      metadata = await lstat(path);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 4096)
      throw new AppError(DEVICE_ERRORS.identity_file_invalid, { effect: "none" });
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.version !== 1) throw new AppError(DEVICE_ERRORS.identity_invalid, { effect: "none" });
    const tenant = uuid.parse(value.tenantId);
    if (configured && tenant !== configured) throw new AppError(DEVICE_ERRORS.identity_tenant_mismatch, { effect: "none" });
    return tenant;
  }
}

/** Core-owned interface. Plugins never import a device connection plugin or each other's internals. */
export class Devices {
  readonly activity: ComputerActivity;
  private transport?: DeviceTransport;
  private workspaceResolver?: (scope: ChannelContext) => string | undefined;
  private workspaceSwitchControl?: WorkspaceSwitchControl;
  /** Workspace plugin owns device selection; consoles cannot pick an arbitrary paired device. */
  useWorkspaceResolver(resolver: (scope: ChannelContext) => string | undefined, control?: WorkspaceSwitchControl): () => void {
    if (this.workspaceResolver) throw new AppError(DEVICE_ERRORS.device_resolver_duplicate, { effect: "none" });
    this.workspaceResolver = resolver;
    this.workspaceSwitchControl = control;
    return () => {
      if (this.workspaceResolver !== resolver) return;
      this.workspaceResolver = undefined;
      this.workspaceSwitchControl = undefined;
    };
  }
  /** The computer a conversation uses now, read at call time: the bot may have switched it. */
  workspaceDevice(scope: ChannelContext): string | undefined {
    return this.workspaceResolver?.(scope);
  }
  /** The bot's own computer switch in force, if any. */
  workspaceSwitch(): WorkspaceComputerSwitch | undefined {
    return this.workspaceSwitchControl?.current();
  }
  async clearWorkspaceSwitch(): Promise<void> {
    await this.workspaceSwitchControl?.clear();
  }

  /** Device desktop drivers reject overlapping calls (`desktop_unavailable`). Per device, track the bot's
   * in-flight desktop calls and the viewer's capture so that watching the screen never fails a bot action. */
  private readonly desktopCalls = new Map<string, number>();
  private readonly viewerCaptures = new Map<string, Promise<OperationResult>>();
  /** The capture method that last worked on each device, tried first next time (an agent-desktop computer has only `ui`). */
  private readonly screenMethods = new Map<string, keyof typeof SCREEN_VIEW_READS>();
  constructor(
    private readonly identity: RuntimeIdentity,
    private readonly clock: Clock = systemClock(),
  ) {
    this.activity = new ComputerActivity(clock);
  }
  use(transport: DeviceTransport): () => void {
    if (this.transport) throw new AppError(DEVICE_ERRORS.device_transport_duplicate, { effect: "none" });
    this.transport = transport;
    return () => {
      if (this.transport === transport) {
        for (const lease of this.manualLeases.values()) lease.desktop?.();
        this.transport = undefined;
      }
    };
  }
  get available(): boolean {
    return this.transport !== undefined;
  }
  async list(): Promise<DeviceView[]> {
    const tenantId = await this.identity.tenantId();
    return (await this.require().list()).filter((device) => device.tenantId === tenantId);
  }
  pair(): Promise<{ code: string; expiresAt: number }> {
    return this.require().pair();
  }
  revoke(deviceId: string): Promise<void> {
    uuid.parse(deviceId);
    return this.require().revoke(deviceId);
  }
  async invoke(deviceId: string, input: Omit<DeviceInvocation, "conversation"> & { scope: ChannelContext }, signal?: AbortSignal): Promise<OperationResult> {
    uuid.parse(deviceId);
    if (this.manualLease(deviceId)) return { status: "rejected", code: "computer_user_controlled" };
    const pending = this.botInvoke(deviceId, input, signal);
    const calls = this.activeBotCalls.get(deviceId) ?? new Set<Promise<OperationResult>>();
    this.activeBotCalls.set(deviceId, calls);
    calls.add(pending);
    try {
      return await pending;
    } finally {
      calls.delete(pending);
      if (!calls.size) this.activeBotCalls.delete(deviceId);
    }
  }
  private async botInvoke(
    deviceId: string,
    input: Omit<DeviceInvocation, "conversation"> & { scope: ChannelContext },
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    uuid.parse(deviceId);
    if (input.capability !== "computer.desktop") return this.dispatch(deviceId, input, signal);
    this.desktopCalls.set(deviceId, (this.desktopCalls.get(deviceId) ?? 0) + 1);
    try {
      // A capture that already started is short: let it finish instead of colliding with it.
      await settled(this.viewerCaptures.get(deviceId), signal, VIEWER_DEADLINE_MS);
      return await this.dispatch(deviceId, input, signal);
    } finally {
      const calls = this.desktopCalls.get(deviceId)! - 1;
      if (calls) this.desktopCalls.set(deviceId, calls);
      else this.desktopCalls.delete(deviceId);
    }
  }
  private readonly activeBotCalls = new Map<string, Set<Promise<OperationResult>>>();
  /** `source`: what the owner took over — the desktop, or the bot browser's tab (which leaves the desktop alone). */
  private readonly manualLeases = new Map<string, { token: string; until: number; busy: boolean; source: ScreenSource; desktop?: () => void }>();
  private manualLease(deviceId: string) {
    const lease = this.manualLeases.get(deviceId);
    if (lease && lease.until <= this.clock.now()) lease.desktop?.();
    if (lease && (lease.until > this.clock.now() || lease.busy)) return lease;
    this.manualLeases.delete(deviceId);
    return undefined;
  }
  /** Includes acquisition and unsettled manual input. A released lease never resumes a task by itself. */
  isUserControlled(deviceId: string): boolean {
    return !!this.manualLease(deviceId);
  }
  /**
   * An exclusive, expiring human lease of the whole device: the bot does nothing on it, desktop or browser, until
   * it is released. Existing bot operations must finish before granting control. `browser` takes over the bot
   * browser's tab instead of the desktop.
   */
  async acquireControl(deviceId: string, source: ScreenSource = "desktop"): Promise<string> {
    uuid.parse(deviceId);
    if (this.manualLease(deviceId)) throw Error("computer_control_busy");
    const device = (await this.list()).find((d) => d.deviceId === deviceId && !d.revokedAt);
    const usable =
      source === "browser"
        ? device?.capabilities.includes("computer.browser") && device.features?.includes("browser-control")
        : device?.capabilities.includes("computer.desktop");
    if (!device?.online || !usable) throw Error("computer_control_unavailable");
    if (this.manualLease(deviceId)) throw Error("computer_control_busy");
    const lease = { token: newId(), until: this.clock.now() + 30_000, busy: true, source };
    this.manualLeases.set(deviceId, lease);
    try {
      const active = [...(this.activeBotCalls.get(deviceId) ?? [])];
      await settled(Promise.allSettled(active), AbortSignal.timeout(15_000), 15_000);
      if (this.activeBotCalls.get(deviceId)?.size) throw Error("computer_control_busy");
      lease.until = this.clock.now() + 30_000;
      return lease.token;
    } catch (error) {
      this.manualLeases.delete(deviceId);
      throw error;
    } finally {
      lease.busy = false;
    }
  }
  renewControl(deviceId: string, token: string): boolean {
    const lease = this.manualLease(deviceId);
    if (!lease || lease.token !== token || lease.until <= this.clock.now()) return false;
    lease.until = this.clock.now() + 30_000;
    return true;
  }
  releaseControl(deviceId: string, token: string): void {
    const lease = this.manualLeases.get(deviceId);
    if (lease?.token !== token) return;
    lease.until = 0;
    lease.desktop?.();
    // A submitted input must finish before the bot is allowed back in.
    if (lease.busy) lease.until = 0;
    else this.manualLeases.delete(deviceId);
  }
  /** One full-duplex remote desktop per lease; Core keeps bot execution excluded until it closes. */
  async openControlDesktop(deviceId: string, token: string, receiver: DesktopReceiver, signal: AbortSignal): Promise<DesktopTunnel> {
    const lease = this.manualLease(deviceId);
    if (!lease || lease.token !== token || lease.until <= this.clock.now()) throw Error("computer_control_expired");
    if (lease.busy) throw Error("computer_control_busy");
    const transport = this.require();
    if (!transport.openDesktop || lease.source !== "desktop") throw Error("computer_control_unavailable");
    lease.busy = true;
    let tunnel: DesktopTunnel | undefined;
    let ended = false;
    let opening = true;
    const controller = new AbortController();
    const unlock = () => {
      lease.desktop = undefined;
      lease.busy = false;
      if (this.manualLeases.get(deviceId) === lease) this.manualLeases.delete(deviceId);
    };
    const close = () => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      signal.removeEventListener("abort", close);
      controller.abort();
      tunnel?.close();
      // A disconnected desktop needs a new explicit takeover, never an automatic input replay.
      lease.until = 0;
      if (!opening) unlock();
      receiver.close();
    };
    const timer = setInterval(() => {
      if (lease.until <= this.clock.now()) close();
    }, 1000);
    timer.unref();
    lease.desktop = close;
    signal.addEventListener("abort", close, { once: true });
    try {
      signal.throwIfAborted();
      await settled(this.viewerCaptures.get(deviceId), signal, VIEWER_DEADLINE_MS);
      const device = (await this.list()).find((item) => item.deviceId === deviceId && !item.revokedAt);
      if (
        !device?.online ||
        device.health?.["computer.desktop"] === false ||
        !device.capabilities.includes("computer.desktop") ||
        !device.features?.includes("desktop-stream")
      )
        throw Error("computer_control_unavailable");
      if (ended || lease.until <= this.clock.now()) throw Error("computer_control_expired");
      tunnel = await transport.openDesktop(
        deviceId,
        deviceInvocationSchema.parse({
          operationId: newId(),
          capability: "computer.desktop",
          method: "remote",
          input: {},
          conversation: { tenantId: await this.identity.tenantId(), platform: "yesimbot-viewer", botId: "webui", kind: "direct", conversationId: "control" },
          actors: [],
          expiresAt: this.clock.now() + 10_000,
        }),
        {
          data: (bytes) => {
            if (!ended) receiver.data(bytes);
          },
          close,
        },
        controller.signal,
      );
      if (ended) {
        tunnel.close();
        throw Error("computer_control_expired");
      }
      return {
        close,
        send: (bytes) => {
          if (signal.aborted || lease.until <= this.clock.now()) return close();
          if (!ended) tunnel!.send(bytes);
        },
      };
    } catch (error) {
      close();
      throw error;
    } finally {
      opening = false;
      if (ended) unlock();
    }
  }
  /** Console-only input. Local device policy still applies; unknown effects are never replayed. */
  async controlInput(deviceId: string, token: string, input: { tool: string; args: Record<string, unknown> }, signal: AbortSignal): Promise<OperationResult> {
    const lease = this.manualLease(deviceId);
    if (!lease || lease.token !== token || lease.until <= this.clock.now()) throw Error("computer_control_expired");
    if (lease.busy) throw Error("computer_control_busy");
    if (lease.source !== "desktop") throw Error("computer_control_unavailable");
    lease.busy = true;
    this.desktopCalls.set(deviceId, (this.desktopCalls.get(deviceId) ?? 0) + 1);
    try {
      await settled(this.viewerCaptures.get(deviceId), signal, VIEWER_DEADLINE_MS);
      signal.throwIfAborted();
      const tenantId = await this.identity.tenantId();
      return await this.require().invoke(
        deviceId,
        deviceInvocationSchema.parse({
          operationId: newId(),
          capability: "computer.desktop",
          method: "ui",
          input,
          conversation: { tenantId, platform: "yesimbot-viewer", botId: "webui", kind: "direct", conversationId: "control" },
          actors: [],
          expiresAt: this.clock.now() + 10_000,
        }),
        signal,
      );
    } finally {
      lease.busy = false;
      const calls = this.desktopCalls.get(deviceId)! - 1;
      if (calls) this.desktopCalls.set(deviceId, calls);
      else this.desktopCalls.delete(deviceId);
    }
  }
  /**
   * Console-only input to the bot browser's tab under a `browser` lease (`isBrowserControl`). It goes to the
   * browser on its own screen, so it never waits for desktop work; unknown effects are never replayed.
   */
  async controlBrowser(deviceId: string, token: string, action: ControlAction, signal: AbortSignal): Promise<OperationResult> {
    const lease = this.manualLease(deviceId);
    if (!lease || lease.token !== token || lease.until <= this.clock.now()) throw Error("computer_control_expired");
    if (lease.busy) throw Error("computer_control_busy");
    if (lease.source !== "browser") throw Error("computer_control_unavailable");
    lease.busy = true;
    try {
      signal.throwIfAborted();
      const tenantId = await this.identity.tenantId();
      return await this.require().invoke(
        deviceId,
        deviceInvocationSchema.parse({
          operationId: newId(),
          capability: "computer.browser",
          method: "execute",
          input: browserControlInputSchema.parse({ action: "control", input: action }),
          conversation: { tenantId, platform: SCREEN_VIEW_PLATFORM, botId: "webui", kind: "direct", conversationId: "control" },
          actors: [],
          expiresAt: this.clock.now() + 10_000,
        }),
        signal,
      );
    } finally {
      lease.busy = false;
    }
  }
  /** Owner-only WebUI viewer. No channel/runtime/history is created and no model tool exposes this method.
   * The reserved transport scope still goes through the client's ordinary local tool policy. Viewing
   * yields to the bot: while one of its desktop calls is in flight the capture is refused as busy.
   * `browser` shows the bot browser's tab; the device reads it on a connection of its own, so it never waits for or blocks the bot.
   */
  async captureScreen(deviceId: string, signal: AbortSignal, source: ScreenSource = "desktop"): Promise<OperationResult> {
    uuid.parse(deviceId);
    signal.throwIfAborted();
    if (source === "browser") return this.captureBrowser(deviceId, signal);
    if (this.desktopCalls.has(deviceId) || this.viewerCaptures.has(deviceId)) return { status: "rejected", code: "desktop_unavailable" };
    const capture = this.capture(deviceId, signal);
    this.viewerCaptures.set(deviceId, capture);
    try {
      return await capture;
    } finally {
      if (this.viewerCaptures.get(deviceId) === capture) this.viewerCaptures.delete(deviceId);
    }
  }
  status(deviceId: string, operationId: string, signal?: AbortSignal): Promise<OperationResult> {
    uuid.parse(deviceId);
    uuid.parse(operationId);
    return this.require().status(deviceId, operationId, signal);
  }
  private async dispatch(deviceId: string, input: Omit<DeviceInvocation, "conversation"> & { scope: ChannelContext }, signal?: AbortSignal) {
    const { scope, ...operation } = input;
    const invocation = deviceInvocationSchema.parse({ ...operation, conversation: await this.identity.conversation(scope) });
    return this.require().invoke(deviceId, invocation, signal);
  }
  private readonly browserCaptures = new Set<string>();
  private async captureBrowser(deviceId: string, signal: AbortSignal): Promise<OperationResult> {
    if (this.browserCaptures.has(deviceId)) return { status: "rejected", code: "browser_unavailable" };
    this.browserCaptures.add(deviceId);
    try {
      const conversation = {
        tenantId: await this.identity.tenantId(),
        platform: SCREEN_VIEW_PLATFORM,
        botId: "webui",
        kind: "direct" as const,
        conversationId: "screen",
      };
      signal.throwIfAborted();
      // The exact read `isScreenViewRead` keeps out of the gateway and client journals.
      return await this.require().invoke(
        deviceId,
        deviceInvocationSchema.parse({
          operationId: newId(),
          capability: "computer.browser",
          method: "execute",
          input: structuredClone(BROWSER_VIEW_READ),
          conversation,
          actors: [],
          expiresAt: this.clock.now() + VIEWER_DEADLINE_MS,
        }),
        signal,
      );
    } finally {
      this.browserCaptures.delete(deviceId);
    }
  }
  private async capture(deviceId: string, signal: AbortSignal): Promise<OperationResult> {
    const tenantId = await this.identity.tenantId();
    signal.throwIfAborted();
    const conversation = { tenantId, platform: SCREEN_VIEW_PLATFORM, botId: "webui", kind: "direct" as const, conversationId: "screen" };
    // Only these exact reads skip the gateway and client journals (`isScreenViewRead`).
    const attempt = (method: keyof typeof SCREEN_VIEW_READS) => {
      signal.throwIfAborted();
      return this.require().invoke(
        deviceId,
        deviceInvocationSchema.parse({
          operationId: newId(),
          capability: "computer.desktop",
          method,
          input: structuredClone(SCREEN_VIEW_READS[method]),
          conversation,
          actors: [],
          expiresAt: this.clock.now() + VIEWER_DEADLINE_MS,
        }),
        signal,
      );
    };
    // agent-desktop drivers expose only `ui`. Each attempt is independently permission checked locally;
    // never retry an unknown/failed capture or fall back to another device.
    const first = this.screenMethods.get(deviceId) ?? "ui",
      second = first === "execute" ? "ui" : "execute";
    const result = await attempt(first);
    if (result.status === "succeeded") this.screenMethods.set(deviceId, first);
    if (result.status !== "rejected" || result.code !== "policy_denied") return result;
    // A bot desktop call that started meanwhile is waiting for this capture; do not extend it.
    if (this.desktopCalls.has(deviceId)) return { status: "rejected", code: "desktop_unavailable" };
    const retried = await attempt(second);
    if (retried.status === "succeeded") this.screenMethods.set(deviceId, second);
    else if (retried.status === "rejected" && retried.code === "policy_denied") this.screenMethods.delete(deviceId);
    return retried;
  }
  private require(): DeviceTransport {
    if (!this.transport) throw new AppError(DEVICE_ERRORS.device_connection_unavailable, { effect: "none" });
    return this.transport;
  }
}

/** Resolves once `promise` settles, `signal` aborts or `ms` elapse. Never rejects. */
function settled(promise: Promise<unknown> | undefined, signal: AbortSignal | undefined, ms: number): Promise<void> {
  if (!promise || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const release = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", release);
      resolve();
    };
    const timer = setTimeout(release, ms);
    timer.unref?.();
    signal?.addEventListener("abort", release, { once: true });
    promise.then(release, release);
  });
}

export type { DeviceTransport } from "@yesimbot/contracts";

export type { ActorIdentity, ConversationIdentity, DeviceInvocation, DeviceView, OperationResult };
