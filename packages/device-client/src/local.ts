import {
  DEVICE_FEATURES,
  deviceRecordSchema,
  uuid,
  type DeviceInvocation,
  type DeviceRecord,
  type DeviceTransport,
  type DeviceView,
  type OperationResult,
  type ToolPolicy,
} from "@yesimbot/contracts";
import { bindDeviceDirectory, DeviceProcessLease, OperationStore } from "@yesimbot/device-store";

import type { DeviceDriver } from "./driver.js";
import { DeviceExecutor } from "./executor.js";

export interface LocalDeviceOptions {
  directory: string;
  record: DeviceRecord;
  policy: ToolPolicy;
  drivers: readonly DeviceDriver[];
  /** Project directories opened to file tools, reported like a connected client's. */
  projectRoots?: readonly string[];
}

/** In-process transport: no network round trip, with the same durable effect ledger. */
export class LocalDeviceTransport implements DeviceTransport {
  private closed = false;
  private closing?: Promise<void>;
  private constructor(
    private readonly options: LocalDeviceOptions,
    private readonly executor: DeviceExecutor,
    private readonly lease: DeviceProcessLease,
  ) {}

  static async open(input: LocalDeviceOptions): Promise<LocalDeviceTransport> {
    const record = deviceRecordSchema.parse(input.record);
    if (record.revokedAt !== undefined) throw new Error("local_device_revoked");
    const options = { ...input, record };
    if (
      options.drivers.length !== record.capabilities.length ||
      options.drivers.some((driver) => !record.capabilities.includes(driver.capability)) ||
      new Set(options.drivers.map((driver) => driver.capability)).size !== options.drivers.length
    )
      throw new Error("local_device_capability_mismatch");
    await bindDeviceDirectory(options.directory, record);
    const lease = await DeviceProcessLease.acquire(options.directory);
    let store: OperationStore | undefined;
    try {
      store = await OperationStore.open(options.directory);
      return new LocalDeviceTransport(options, new DeviceExecutor(record, options.drivers, store, options.policy), lease);
    } catch (error) {
      store?.close();
      lease.close();
      throw error;
    }
  }

  async list(): Promise<DeviceView[]> {
    return [
      {
        ...this.options.record,
        online: !this.closed,
        health: Object.fromEntries(this.options.drivers.map((driver) => [driver.capability, !this.closed && (driver.healthy?.() ?? true)])),
        // In-process: the executor is always this version.
        features: DEVICE_FEATURES.filter((feature) => feature !== "desktop-stream"),
        ...(this.options.projectRoots?.length ? { projectRoots: [...this.options.projectRoots] } : {}),
      },
    ];
  }
  async pair(): Promise<never> {
    throw new Error("local_device_does_not_require_pairing");
  }
  async revoke(deviceId: string): Promise<void> {
    this.assertDevice(deviceId);
    // Revocation must be persisted by the local instance configuration, not silently lost on restart.
    throw new Error("disable_local_device_in_instance_settings");
  }
  async invoke(deviceId: string, invocation: DeviceInvocation, signal?: AbortSignal): Promise<OperationResult> {
    this.assertDevice(deviceId);
    if (this.closed || signal?.aborted) return { status: "rejected", code: "local_device_unavailable" };
    const cancel = () => this.executor.cancel(invocation.operationId);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      // execute registers the controller synchronously before its first await.
      const result = this.executor.execute(invocation);
      if (signal?.aborted) cancel();
      return await result;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  async status(deviceId: string, operationId: string): Promise<OperationResult> {
    this.assertDevice(deviceId);
    uuid.parse(operationId);
    if (this.closed) throw new Error("local_device_closed");
    return this.executor.status(operationId);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      try {
        await this.executor.close();
      } finally {
        this.lease.close();
      }
    })());
  }
  private assertDevice(id: string): void {
    uuid.parse(id);
    if (id !== this.options.record.deviceId) throw new Error("device_denied");
  }
}

/** Explicit routing only; a local failure never falls back to another machine. */
export class RoutedDeviceTransport implements DeviceTransport {
  constructor(
    private readonly localId: string,
    private readonly local: DeviceTransport,
    private readonly remote?: DeviceTransport,
  ) {
    uuid.parse(localId);
  }
  private route(id: string): DeviceTransport {
    uuid.parse(id);
    if (id === this.localId) return this.local;
    if (!this.remote) throw new Error("device_denied");
    return this.remote;
  }
  async list(): Promise<DeviceView[]> {
    const local = await this.local.list();
    const remote = await this.remote?.list();
    if (remote?.some((device) => device.deviceId === this.localId && device.online)) throw new Error("device_active_in_two_locations");
    return [...local, ...(remote ?? []).filter((device) => device.deviceId !== this.localId)];
  }
  pair() {
    if (!this.remote) return this.local.pair();
    return this.remote.pair();
  }
  revoke(id: string) {
    return this.route(id).revoke(id);
  }
  invoke(id: string, invocation: DeviceInvocation, signal?: AbortSignal) {
    return this.route(id).invoke(id, invocation, signal);
  }
  status(id: string, operationId: string, signal?: AbortSignal) {
    return this.route(id).status(id, operationId, signal);
  }
}
