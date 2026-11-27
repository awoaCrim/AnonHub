import { reactive, ref } from "vue";

export type Change = readonly [path: readonly string[], value: unknown];

/** One config editor, as `createConfigFieldsEditor` returns it. */
export interface AutosaveTarget {
  readonly dirty: { readonly value: boolean };
  set(path: readonly string[], value: unknown): void;
  save(): Promise<boolean>;
  discard(): Promise<unknown>;
}

/**
 * Change-saves-at-once for settings cards (user, 2026-11-21: 改了就生效, and it must feel instant over a ~1s link).
 * A change shows at once; while a save is in flight, later changes wait and then go out together as one save (one
 * 已保存 toast, one 撤销 for all of them, one reload of the plugin). A failed save rereads the server copy, so the
 * card never shows a value that was not kept.
 */
export function createAutosave(options: {
  /** The saved value of a path. */
  read(path: readonly string[]): unknown;
  /** The editor that owns a path. Changes saved together share one editor. */
  target(path: readonly string[]): AutosaveTarget;
  disposed(): boolean;
  notify(text: string, undo?: () => void): void;
}) {
  const key = (path: readonly string[]) => path.join("\u0000");
  /** Changes not handed to an editor yet, shown in place of the saved values. */
  const pending = reactive(new Map<string, Change>());
  const replaced = new Map<string, Change>();
  const labels = new Set<string>();
  const saving = ref(false);
  let undoing = false,
    final = false;

  /** The value a card shows: a waiting change, otherwise the saved value. */
  function value(path: readonly string[]): unknown {
    const waiting = pending.get(key(path));
    return waiting ? waiting[1] : options.read(path);
  }

  /**
   * Shows `changes` at once and saves them. `irreversible` changes (a new secret: the browser never holds the old one)
   * offer no 撤销 for the save they go out in.
   */
  async function commit(label: string, changes: readonly Change[], { undo = false, irreversible = false } = {}): Promise<void> {
    if (options.disposed() || !changes.length) return;
    for (const [path, next] of changes) {
      const id = key(path);
      if (!replaced.has(id)) replaced.set(id, [path, value(path)]);
      pending.set(id, [path, next]);
    }
    labels.add(label);
    undoing ||= undo;
    final ||= irreversible;
    if (saving.value) return;
    saving.value = true;
    try {
      while (pending.size && !options.disposed()) {
        const batch = [...pending.values()];
        const before = [...replaced.values()];
        const text = [...labels].join("、");
        const wasUndo = undoing,
          reversible = !final;
        replaced.clear();
        labels.clear();
        undoing = final = false;
        const owner = options.target(batch[0]![0]);
        for (const [path, next] of batch) owner.set(path, next);
        pending.clear();
        if (!owner.dirty.value) continue;
        if (!(await owner.save())) {
          if (!options.disposed()) await owner.discard();
          continue;
        }
        if (!options.disposed())
          options.notify(wasUndo ? `已撤销：${text}` : `已保存：${text}`, wasUndo || !reversible ? undefined : () => void commit(text, before, { undo: true }));
      }
    } finally {
      saving.value = false;
    }
  }

  return { saving, value, commit };
}
