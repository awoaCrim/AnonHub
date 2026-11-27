const SECRET_NAME = /key|token|secret|pass|credential|cookie|authorization/i;
const KEY_PREFIXES = /\b(?:sk-|gh[pousr]_|github_pat_|AIza|xox[abpr]-|tvly-)[\w-]{6,}/g;

const KEY_VALUE =
  /((?:["']?(?:password|passwd|secret|token|api[-_]?key|access[-_]?key|credential|authorization|cookie|private[-_]?key)["']?)\s*[:=]\s*)(?!(?:Bearer|Basic)\s)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&}\]]+)/gi;

const AUTH_SCHEME = /\b(Bearer|Basic)\s+[^\s,;"']+/gi;
const URL_TEXT = /https?:\/\/[^\s<>"']+/gi;
const MIN_SECRET_LENGTH = 6;
const registered = new Set<string>();
let cached: { key: string; pattern?: RegExp } | undefined;

/**
 * Removes credentials from text before a model, a user or a log sees it.
 *
 * Removed: registered secrets (from config), values of secret-named environment variables (each also JSON-escaped and
 * URI-encoded), bearer/basic credentials, well-known key prefixes, `key=value` secrets, and URL credentials, queries
 * and fragments.
 */
export function redact(text: string): string {
  const pattern = knownSecrets();
  const result = pattern ? text.replace(pattern, "[redacted]") : text;
  return result
    .replace(AUTH_SCHEME, "$1 [redacted]")
    .replace(KEY_PREFIXES, "[redacted]")
    .replace(KEY_VALUE, "$1[redacted]")
    .replace(URL_TEXT, (raw) => safeURL(raw) || "[redacted URL]");
}

/** Secrets loaded from config, so `redact` removes them even when they look like ordinary text. */
export function registerSecret(value: string): void {
  if (value.length >= MIN_SECRET_LENGTH) registered.add(value);
}

/** A URL without credentials, query or fragment; empty when the text is not a URL. */
export function safeURL(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function knownSecrets(): RegExp | undefined {
  const values = new Set(registered);
  for (const [name, value] of Object.entries(process.env)) if (value && value.length >= MIN_SECRET_LENGTH && SECRET_NAME.test(name)) values.add(value);
  const key = [...values].sort().join("\0");
  if (cached?.key === key) return cached.pattern;
  const variants = new Set<string>();
  for (const value of values) {
    variants.add(value);
    variants.add(JSON.stringify(value).slice(1, -1));
    try {
      variants.add(encodeURIComponent(value));
    } catch {
      // A lone surrogate still matches literally.
    }
  }
  // One pass, longest first, so a short secret cannot match inside an inserted marker.
  const source = [...variants]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  cached = { key, pattern: source ? new RegExp(source, "g") : undefined };
  return cached.pattern;
}
