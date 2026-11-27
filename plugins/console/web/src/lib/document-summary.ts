/** Reading previews only. Editors and writes always keep the original document content. */
export function documentPreview(content: string): string {
  return content
    .split(/\r?\n/)
    .filter(
      (line) => !/^\s*(?:[-*]\s*)?(?:来源|证据|更新时间|创建时间|source|evidence|compartment|entry[ _-]?id|memory[ _-]?id|channel[ _-]?id)\s*[:：]/i.test(line),
    )
    .map((line) =>
      line
        .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/, "")
        .replace(/\*\*|__|`/g, "")
        .trim(),
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
export function documentTitle(content: string): string {
  const first =
    content
      .split(/\r?\n/)
      .map(documentPreview)
      .find(Boolean)
      ?.trim()
      .split(/[。！？]/)[0]
      ?.trim() || "未命名记忆";
  return first.length > 28 ? `${first.slice(0, 28)}…` : first;
}
