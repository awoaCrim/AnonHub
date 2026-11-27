/** One account the system trusts to have the bot use sensitive tools (Core `admins`). */
export interface AdminEntry {
  platform: string;
  userId: string;
  [key: string]: unknown;
}

/** Core `admins` as saved; anything that is not a well-formed entry is dropped from the view but never rewritten by `with*`. */
export function readAdmins(value: unknown): AdminEntry[] {
  return Array.isArray(value) ? (structuredClone(value) as AdminEntry[]) : [];
}

const isEntry = (item: unknown): item is AdminEntry =>
  !!item && typeof item === "object" && typeof (item as AdminEntry).platform === "string" && typeof (item as AdminEntry).userId === "string";

/** This platform's account IDs, in saved order. */
export function platformAdminIds(list: unknown[], platform: string): string[] {
  return list
    .filter(isEntry)
    .filter((item) => item.platform === platform)
    .map((item) => item.userId);
}

/** A QQ number is digits; other platforms take any ID without spaces. Returns the cleaned ID or an error message. */
export function checkAdminId(platform: string, input: string, existing: string[]): { id: string } | { error: string } {
  const id = input.trim();
  if (!id) return { error: "请填写账号。" };
  if (/\s/.test(id)) return { error: "账号里不能有空格。" };
  if (id.length > 128) return { error: "账号太长。" };
  if (platform === "onebot" && !/^\d{5,12}$/.test(id)) return { error: "QQ 号只能是 5 到 12 位数字。" };
  if (existing.includes(id)) return { error: "这个账号已经在名单里了。" };
  return { id };
}

/** Adds to the latest saved list (no-op when already there); other platforms' entries are kept as they are. */
export function withAdmin(list: unknown[], platform: string, id: string): unknown[] {
  return list.some((item) => isEntry(item) && item.platform === platform && item.userId === id) ? list : [...list, { platform, userId: id }];
}

export function withoutAdmin(list: unknown[], platform: string, id: string): unknown[] {
  return list.filter((item) => !(isEntry(item) && item.platform === platform && item.userId === id));
}
