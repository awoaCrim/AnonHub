/** Failed-save drafts live only in this signed-in browser session, never in localStorage. */
let epoch = 0;
export const draftScope = () => epoch;
const drafts = new Map<string, unknown>();
export function retainDraft(key: string, value: unknown, scope = epoch) {
  if (scope !== epoch) return;
  if (drafts.size >= 20) drafts.delete(drafts.keys().next().value!);
  drafts.set(key, JSON.parse(JSON.stringify(value)));
}

export function takeDraft<T>(key: string): T | undefined {
  const value = drafts.get(key);
  drafts.delete(key);
  return value as T | undefined;
}

export function clearEditorDrafts() {
  epoch++;
  drafts.clear();
}
