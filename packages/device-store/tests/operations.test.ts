import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { EXPIRED_OPERATION_RESULT, fingerprintValue, OPERATION_RESULT_RETENTION_MS, OperationStore } from "../src/operations.js";

// User, 2026-11-20: 「操作日志也允许清理」 (the gateway's ledger had reached 8 GB, almost all of it screenshots).
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "yib-operations-"));
  directories.push(path);
  return path;
}

const screenshot = (size: number) => ({ status: "succeeded", output: { image: "A".repeat(size) } });

it("keeps only the status of old succeeded results, and still never runs a replay again", async () => {
  const store = await OperationStore.open(await directory());
  try {
    const input = { method: "computer.desktop.ui", input: { action: "screenshot" } };
    store.claim("old-shot", input);
    store.finish("old-shot", screenshot(200_000));
    store.claim("old-small", input);
    store.finish("old-small", { status: "succeeded", output: { exitCode: 0 } });
    store.claim("old-refused", input);
    store.finish("old-refused", { status: "rejected", code: "policy_denied" });
    store.claim("old-running", input);
    expect(store.maintain(Date.now() + OPERATION_RESULT_RETENTION_MS - 60_000)).toBe(0);
    expect(store.get("old-shot")?.result).toEqual(screenshot(200_000));

    expect(store.maintain(Date.now() + OPERATION_RESULT_RETENTION_MS + 60_000)).toBe(1);
    expect(store.get("old-shot")?.result).toEqual(EXPIRED_OPERATION_RESULT);
    expect(store.get("old-small")?.result).toEqual({ status: "succeeded", output: { exitCode: 0 } });
    expect(store.get("old-refused")?.result).toEqual({ status: "rejected", code: "policy_denied" });
    expect(store.get("old-running")?.result).toBeUndefined();
    // The tombstone and its fingerprint stay: the same call is answered from the ledger, a different one still conflicts.
    expect(store.claim("old-shot", input)).toEqual({ created: false, operation: { fingerprint: expect.any(String), result: EXPIRED_OPERATION_RESULT } });
    expect(() => store.claim("old-shot", { ...input, input: { action: "click" } })).toThrow("operation_id_conflict");
  } finally {
    store.close();
  }
});

it("gives the space back once much of the file is free", async () => {
  const path = await directory();
  const store = await OperationStore.open(path);
  try {
    for (let index = 0; index < 90; index++) {
      store.claim(`shot-${index}`, { index });
      store.finish(`shot-${index}`, screenshot(1024 * 1024));
    }
    store.maintain(Date.now() - 1);
    const before = (await stat(join(path, "operations.sqlite"))).size;
    expect(before).toBeGreaterThan(80 * 1024 * 1024);
    expect(store.maintain(Date.now() + OPERATION_RESULT_RETENTION_MS + 60_000)).toBe(90);
    expect((await stat(join(path, "operations.sqlite"))).size).toBeLessThan(2 * 1024 * 1024);
    expect(store.get("shot-89")?.result).toEqual(EXPIRED_OPERATION_RESULT);
  } finally {
    store.close();
  }
}, 60_000);

it("keeps the stored fingerprints of the original canonical-JSON hash", () => {
  // Values computed by the code before 4.11; the ledger and resource bindings compare against them.
  expect(
    fingerprintValue({
      method: "computer.desktop.ui",
      input: { action: "screenshot", z: [3, { b: 1, a: null }], "10": "x", "2": "y", 中文: "值", skip: undefined },
    }),
  ).toBe("19d37b04a607411bc8b2621f7a0e75dd27f2ef8b04b300c7d20608b4d57fc74d");
  expect(fingerprintValue({ tenantId: "t", conversation: { platform: "onebot", kind: "group", parentId: "1", id: "2" }, actors: [] })).toBe(
    "41de2ce902152a31f8a037ba60e0a563d4f4e993fa62f4345135fabe8d3023dd",
  );
  expect(fingerprintValue(["a", 1.5, true, null])).toBe("62cbf3964e2481368bdda388aad8546995fc3b79a72a623b9a7cb6f0cd020736");
});

it("opens a ledger created with a schema version and keeps its rows", async () => {
  const path = await directory();
  const { DatabaseSync } = await import("node:sqlite");
  const old = new DatabaseSync(join(path, "operations.sqlite"));
  old.exec("CREATE TABLE operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT, created INTEGER NOT NULL); PRAGMA user_version=1;");
  old.prepare("INSERT INTO operations VALUES (?, ?, NULL, ?)").run("kept", fingerprintValue({ a: 1 }), Date.now());
  old.close();
  const store = await OperationStore.open(path);
  try {
    expect(store.claim("kept", { a: 1 }).created).toBe(false);
  } finally {
    store.close();
  }
});
