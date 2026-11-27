import { describe, expect, it } from "vitest";

import { canonicalJson, contentHash, digestJson, hashSecret, newId, newSecret, safeEqual } from "../src/index.js";

describe("ids and secrets", () => {
  it("makes UUID v4 IDs and base64url secrets", () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSecret(16)).toHaveLength(22);
    expect(newSecret(24, { encoding: "hex" })).toMatch(/^[a-f0-9]{48}$/);
    expect(() => newSecret(8)).toThrow(RangeError);
    expect(hashSecret("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("safeEqual checks type, format and length before comparing", () => {
    const token = newSecret();
    expect(safeEqual(token, token, { format: /^[A-Za-z0-9_-]+$/, length: 43 })).toBe(true);
    expect(safeEqual(token, token + "x")).toBe(false);
    expect(safeEqual(token, token, { length: 42 })).toBe(false);
    expect(safeEqual("a b", "a b", { format: /^\S+$/ })).toBe(false);
    expect(safeEqual(undefined, undefined)).toBe(false);
    expect(safeEqual("", "")).toBe(false);
    expect(safeEqual(123, 123)).toBe(false);
    const global = /^[a-z]+$/g;
    expect(safeEqual("abc", "abc", { format: global })).toBe(true);
    expect(safeEqual("abc", "abc", { format: global })).toBe(true);
  });

  it("hashes content to at least 64 bits and JSON with sorted keys", () => {
    expect(contentHash("abc")).toHaveLength(64);
    expect(contentHash(new TextEncoder().encode("abc"), { hexLength: 16 })).toBe("ba7816bf8f01cfea");
    expect(() => contentHash("abc", { hexLength: 10 })).toThrow(RangeError);
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(digestJson({ a: 1, b: 2 })).toBe(digestJson({ b: 2, a: 1 }));
    expect(digestJson({ a: 1 })).not.toBe(digestJson({ a: 2 }));
  });
});
