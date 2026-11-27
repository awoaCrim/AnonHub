import {
  authorizeTool,
  authorizeToolCapability,
  deviceToolCapability,
  deviceInvocationSchema,
  isScreenViewRead,
  MAX_DEVICE_FRAME_BYTES,
  deviceInputLimit,
  operationResultSchema,
  type DeviceCredential,
  type DeviceInvocation,
  type OperationResult,
  type ToolPolicy,
} from "@yesimbot/contracts";
import { OperationStore } from "@yesimbot/device-store";
import { type Clock, systemClock } from "@yesimbot/foundation";

import { DEADLINE_REASON, type DeviceDriver, type DeviceMethod } from "./driver.js";

export class DeviceExecutor {
  private readonly drivers = new Map<string, DeviceDriver>();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<OperationResult> }>();
  private stopped = false;

  constructor(
    private readonly credential: Pick<DeviceCredential, "tenantId" | "deviceId">,
    drivers: readonly DeviceDriver[],
    private readonly store: OperationStore,
    private readonly policy: ToolPolicy,
    private readonly clock: Clock = systemClock(),
  ) {
    for (const driver of drivers) {
      if (this.drivers.has(driver.capability)) throw new Error("duplicate_device_driver");
      this.drivers.set(driver.capability, driver);
    }
  }

  async execute(input: DeviceInvocation): Promise<OperationResult> {
    const invocation = deviceInvocationSchema.parse(input);
    if (this.stopped || invocation.conversation.tenantId !== this.credential.tenantId) return rejected("device_denied");
    if (Buffer.byteLength(JSON.stringify(invocation)) > deviceInputLimit(invocation)) return rejected("input_too_large");
    const driver = this.drivers.get(invocation.capability),
      method = driver?.methods[invocation.method];
    if (
      !method ||
      !authorizeToolCapability(
        { conversation: invocation.conversation },
        deviceToolCapability(invocation.capability, invocation.method, invocation.conversation.platform),
      ).allowed ||
      !authorizeTool(
        { conversation: invocation.conversation, actors: invocation.actors },
        {
          name: `${invocation.capability}.${method.grant ?? invocation.method}`,
          pluginId: invocation.capability,
          contexts: [...method.contexts],
        },
        this.policy,
      ).allowed
    )
      return rejected("policy_denied");
    if (isScreenViewRead(invocation)) return this.view(invocation, method);
    let claim;
    try {
      claim = this.store.claim(invocation.operationId, operationIdentity(invocation));
    } catch {
      return rejected("operation_id_conflict");
    }
    if (!claim.created)
      return claim.operation.result === undefined ? { status: "unknown", code: "operation_incomplete" } : operationResultSchema.parse(claim.operation.result);
    if (invocation.expiresAt <= this.clock.now() || invocation.expiresAt > this.clock.now() + 10 * 60_000) {
      const result = rejected("invalid_deadline");
      this.store.finish(invocation.operationId, result);
      return result;
    }
    if (this.active.size >= 32) {
      const result = rejected("device_busy");
      this.store.finish(invocation.operationId, result);
      return result;
    }
    // Claim has committed before any native effect. An exception or crash keeps the tombstone unknown.
    return this.run(invocation, method, true);
  }

  private run(invocation: DeviceInvocation, method: DeviceMethod, journaled: boolean): Promise<OperationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(DEADLINE_REASON), Math.max(1, invocation.expiresAt - this.clock.now()));
    timer.unref();
    const promise = Promise.resolve()
      .then(async (): Promise<OperationResult> => {
        if (controller.signal.aborted) return rejected("cancelled_before_execution");
        const result = operationResultSchema.parse(await method.execute(invocation, controller.signal));
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_DEVICE_FRAME_BYTES - 1024) return { status: "unknown", code: "result_too_large" };
        if (journaled && result.status !== "unknown") this.store.finish(invocation.operationId, result);
        return result;
      })
      .catch((): OperationResult => ({ status: "unknown", code: "execution_interrupted" }))
      .finally(() => {
        clearTimeout(timer);
        this.active.delete(invocation.operationId);
      });
    this.active.set(invocation.operationId, { controller, promise });
    return promise;
  }

  /** A screen-view read has no effect to deduplicate; it is never journaled (a screenshot per capture
   * would otherwise be kept forever). Deadline, concurrency, cancellation and size limits still apply. */
  private view(invocation: DeviceInvocation, method: DeviceMethod): Promise<OperationResult> {
    const id = invocation.operationId;
    if (this.active.has(id) || this.store.get(id)) return Promise.resolve(rejected("operation_id_conflict"));
    if (invocation.expiresAt <= this.clock.now() || invocation.expiresAt > this.clock.now() + 10 * 60_000) return Promise.resolve(rejected("invalid_deadline"));
    if (this.active.size >= 32) return Promise.resolve(rejected("device_busy"));
    return this.run(invocation, method, false);
  }

  status(operationId: string): OperationResult {
    const record = this.store.get(operationId);
    return record?.result === undefined
      ? { status: "unknown", code: record ? "operation_incomplete" : "operation_not_seen" }
      : operationResultSchema.parse(record.result);
  }
  /** Something is running for the bot on this computer right now. */
  get busy(): boolean {
    return this.active.size > 0;
  }
  cancel(operationId: string): void {
    this.active.get(operationId)?.controller.abort("cancelled");
  }
  cancelAll(): void {
    for (const active of this.active.values()) active.controller.abort("cancelled");
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.cancelAll();
    await Promise.allSettled([...this.drivers.values()].map((driver) => driver.close?.()));
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    this.store.close();
  }
}

function rejected(code: string): OperationResult {
  return { status: "rejected", code };
}

function operationIdentity({ expiresAt: _deadline, ...operation }: DeviceInvocation) {
  return operation;
}
