import type { ConversationKind, DeviceCapability, DeviceInvocation, OperationResult } from "@yesimbot/contracts";

/** The abort reason a method sees when its invocation deadline passed, as opposed to a cancellation or shutdown. */
export const DEADLINE_REASON = "device_deadline";

export interface DeviceMethod {
  readonly contexts: readonly ConversationKind[];
  /**
   * The local policy grant that covers this method when it is not its own name: `computer.shell.start` and
   * `computer.shell.job` only run, read and stop commands, so the `computer.shell.exec` grant covers them.
   */
  readonly grant?: string;
  /** Throwing means the effect is uncertain. Return failed/rejected only when non-delivery is known. */
  execute(invocation: DeviceInvocation, signal: AbortSignal): Promise<OperationResult>;
}

export interface DeviceDriver {
  readonly capability: DeviceCapability;
  readonly methods: Readonly<Record<string, DeviceMethod>>;
  healthy?(): boolean;
  close?(): Promise<void>;
}
