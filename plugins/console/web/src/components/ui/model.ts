/** What native `v-model` would have stored for this input event, honouring `.trim` and `.number`. */
export function readModel(event: Event, modifiers: { trim?: boolean; number?: boolean } | undefined, numeric = false): string | number {
  let value: string | number = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  if (modifiers?.trim) value = value.trim();
  if (modifiers?.number || numeric) {
    const parsed = Number.parseFloat(value);
    if (!Number.isNaN(parsed)) value = parsed;
  }
  return value;
}
