import { describe, expect, it } from "vitest";

import { runMaintenance } from "../src/maintainer.js";

describe("MemoryMaintainer", () => {
  it("exports runMaintenance as a public function", () => {
    expect(typeof runMaintenance).toBe("function");
  });
});

describe("memory standard (after Muse)", () => {
  it("keeps understanding of people and lessons learned, and leaves work progress, tool status, to-dos and reference material out", async () => {
    const { MEMORY_STANDARD } = await import("../src/maintainer.js");
    expect(MEMORY_STANDARD).toContain("对人的理解");
    // Owner, 2026-11-17: 「踩过的坑也可以进行记录」 — a reusable lesson, unlike a passing tool status.
    expect(MEMORY_STANDARD).toContain("踩过的坑：做事时发现行不通的做法、原因，以及后来有效的做法");
    for (const excluded of ["工作进度、排查过程", "工具、系统或 bot 自身功能一时的状态与修复情况", "待办和任务本身", "配置、地址、账号设置、文件内容等资料"])
      expect(MEMORY_STANDARD).toContain(excluded);
    expect(MEMORY_STANDARD).toContain("什么都不写");
    expect(MEMORY_STANDARD).not.toContain("给过的帮助、表过的态度");
  });
});
