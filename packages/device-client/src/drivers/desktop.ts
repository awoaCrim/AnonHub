import { McpDesktopDriver, type ComputerAction } from "@yesimbot/computer-driver";
import { z } from "zod/v4";

import { localDesktopEndpoint } from "../config.js";
import type { DeviceDriver } from "../driver.js";

const coordinate = z.number().finite().min(0).max(16383),
  keys = z.array(z.string().min(1).max(64)).max(12);

const point = { x: coordinate, y: coordinate },
  modifiers = { keys: keys.nullable().optional() };

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ...point, ...modifiers, button: z.enum(["left", "right", "wheel", "back", "forward"]) }).strict(),
  z.object({ type: z.literal("double_click"), ...point, ...modifiers }).strict(),
  z.object({ type: z.literal("move"), ...point, ...modifiers }).strict(),
  z.object({ type: z.literal("drag"), path: z.array(z.object(point).strict()).min(1).max(128), ...modifiers }).strict(),
  z
    .object({
      type: z.literal("scroll"),
      ...point,
      ...modifiers,
      scrollX: z.number().finite().min(-1_000_000).max(1_000_000),
      scrollY: z.number().finite().min(-1_000_000).max(1_000_000),
    })
    .strict(),
  z.object({ type: z.literal("keypress"), keys: keys.min(1) }).strict(),
  z.object({ type: z.literal("type"), text: z.string().min(1).max(4000) }).strict(),
  z.object({ type: z.literal("screenshot") }).strict(),
  z.object({ type: z.literal("wait") }).strict(),
]);

// An empty initial batch means capture the desktop before deciding any action.
const desktopInputSchema = z.object({ actions: z.array(actionSchema).max(32) }).strict();

export class LocalDesktopDriver implements DeviceDriver {
  readonly capability = "computer.desktop" as const;
  private readonly driver: McpDesktopDriver;
  private busy = false;
  private stopped = false;
  constructor(endpoint: string) {
    localDesktopEndpoint(endpoint);
    this.driver = new McpDesktopDriver({ endpoint });
  }
  readonly methods: DeviceDriver["methods"] = {
    execute: {
      contexts: ["direct", "group"],
      execute: async (invocation, signal) => {
        const input = desktopInputSchema.safeParse(invocation.input);
        if (!input.success) return { status: "rejected", code: "invalid_desktop_input" };
        if (this.stopped || this.busy || signal.aborted) return { status: "rejected", code: "desktop_unavailable" };
        this.busy = true;
        try {
          const image = await this.driver.execute(input.data.actions as ComputerAction[], signal);
          return { status: "succeeded", output: { data: Buffer.from(image.bytes).toString("base64"), mediaType: image.mediaType } };
        } finally {
          this.busy = false;
        }
      },
    },
  };
  async close(): Promise<void> {
    this.stopped = true;
    await this.driver.close();
  }
}

// Exported here: it is built from the local schemas above it.
export { desktopInputSchema };
