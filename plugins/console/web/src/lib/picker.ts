/**
 * One choice in the site's own dropdowns (PickerMenu, SuggestInput). The browser's select and datalist
 * popups are drawn by the system and ignore the theme, so the WebUI never uses them.
 */
export interface PickerOption<T = string> {
  value: T;
  label: string;
  /** Quiet text on the right, e.g. what 跟随设置 currently resolves to. */
  note?: string;
  /** A thin line above this option. */
  divider?: boolean;
  disabled?: boolean;
}

/** The next choosable option from `from`, stepping by `step` and wrapping; -1 when none can be chosen. */
export function stepOption(options: readonly PickerOption<unknown>[], from: number, step: number): number {
  for (let n = 1; n <= options.length; n++) {
    const index = (((from + step * n) % options.length) + options.length) % options.length;
    if (!options[index]!.disabled) return index;
  }
  return -1;
}
