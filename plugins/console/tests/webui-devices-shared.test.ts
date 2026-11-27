import { afterEach, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("../web/src/lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));

afterEach(() => {
  api.mockReset();
  vi.useRealTimers();
  vi.resetModules();
});

it("delegates picker reads to the account-scoped API cache and explicitly refreshes on demand", async () => {
  const { loadDevices } = await import("../web/src/lib/devices");
  api.mockRejectedValueOnce(new Error("offline"));
  await expect(loadDevices()).rejects.toThrow("offline");
  api.mockResolvedValue({ available: true, devices: [] });
  await loadDevices();
  expect(api).toHaveBeenLastCalledWith("/yesimbot/api/v1/devices", undefined, { fresh: false });
  await loadDevices(true);
  expect(api).toHaveBeenLastCalledWith("/yesimbot/api/v1/devices", undefined, { fresh: true });
});

it("separates file storage from computers", async () => {
  const { isComputerDevice, isWorkspaceDevice } = await import("../web/src/lib/devices");
  const files = { capabilities: ["workspace.files"] } as never;
  const computer = { capabilities: ["computer.shell"] } as never;
  expect(isComputerDevice(files)).toBe(false);
  expect(isWorkspaceDevice(files)).toBe(true);
  expect(isComputerDevice(computer)).toBe(true);
  expect(isWorkspaceDevice(computer)).toBe(true);
});
