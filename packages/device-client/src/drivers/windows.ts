import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod/v4";

import type { DeviceDriver } from "../driver.js";
import { desktopInputSchema } from "./desktop.js";

const inspectSchema = z.object({ window: z.number().int().optional(), limit: z.number().int().min(1).max(300).default(150) }).strict();
const controlSchema = z
  .object({
    snapshot: z.string().uuid(),
    ref: z.string().regex(/^e\d+$/),
    action: z.enum(["invoke", "focus", "setValue", "select", "expand", "collapse"]),
    text: z.string().max(16000).optional(),
  })
  .strict();

/** Persistent worker in the logged-in Windows session. All RPC arguments are JSON, never shell source. */
export class WindowsDesktopDriver implements DeviceDriver {
  readonly capability = "computer.desktop" as const;
  private child?: ChildProcessWithoutNullStreams;
  private busy = false;
  private stopped = false;
  private available = false;
  private pending?: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
  constructor(private readonly script: string) {
    if (!isAbsolute(script)) throw new Error("absolute_windows_worker_path_required");
  }
  healthy() {
    return !this.stopped && this.available;
  }
  readonly methods: DeviceDriver["methods"] = Object.fromEntries(
    [
      ["execute", desktopInputSchema],
      ["inspect", inspectSchema],
      ["control", controlSchema],
    ].map(([method, schema]) => [
      method,
      {
        contexts: ["direct", "group"],
        execute: async (invocation, signal) => {
          const parsed = (schema as z.ZodType).safeParse(invocation.input);
          if (!parsed.success) return { status: "rejected", code: "invalid_desktop_input" };
          if (this.stopped || this.busy || signal.aborted) return { status: "rejected", code: "desktop_unavailable" };
          this.busy = true;
          try {
            const output = await this.request(String(method), parsed.data, signal);
            this.available = true;
            return { status: "succeeded", output };
          } finally {
            this.busy = false;
          }
        },
      },
    ]),
  );
  async probe(signal: AbortSignal): Promise<void> {
    await this.request("inspect", { limit: 1 }, signal);
    this.available = true;
  }
  private start() {
    if (this.child) return this.child;
    if (process.platform !== "win32") throw new Error("windows_desktop_required");
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File", this.script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const fail = () => {
      if (this.child !== child) return;
      this.available = false;
      this.child = undefined;
      this.pending?.reject(new Error("windows_worker_interrupted"));
      this.pending = undefined;
    };
    child.on("error", fail);
    child.on("exit", fail);
    // Do not print desktop text or native exception details into application logs.
    child.stderr.resume();
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.length > 18 * 1024 * 1024) {
        child.kill();
        return;
      }
      try {
        const message = JSON.parse(line);
        if (!this.pending || message.id !== this.pending.id) return;
        const pending = this.pending;
        this.pending = undefined;
        if (message.ok === true) pending.resolve(message.output);
        else {
          this.available = false;
          pending.reject(new Error(/^[a-z_]+$/.test(message.error) ? message.error : "desktop_action_failed"));
        }
      } catch {
        child.kill();
      }
    });
    return child;
  }
  private async request(method: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.pending) throw new Error("desktop_busy");
    signal.throwIfAborted();
    const child = this.start(),
      id = randomUUID();
    const abort = () => {
      child.kill();
      this.pending?.reject(new Error("desktop_interrupted"));
      this.pending = undefined;
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { id, resolve, reject };
        child.stdin.write(JSON.stringify({ id, method, input }) + "\n", (error) => {
          if (error) {
            abort();
            reject(error);
          }
        });
        if (signal.aborted) abort();
      });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async close() {
    this.stopped = true;
    this.child?.kill();
    this.pending?.reject(new Error("desktop_closed"));
    this.pending = undefined;
  }
}
