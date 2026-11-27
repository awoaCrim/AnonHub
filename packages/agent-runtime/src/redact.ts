/**
 * Removes credentials from diagnostic text before a model, a user or a log sees it: values of
 * secret-looking environment variables, bearer/basic credentials, well-known key prefixes,
 * `key=value` style secrets, and URL credentials, queries and fragments.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 6 && /key|token|secret|pass|credential|cookie/i.test(name)) {
      for (const value of [secret, encodeURIComponent(secret)]) result = result.split(value).join("[redacted]");
    }
  }
  return result
    .replace(/\b(?:bearer|basic)\s+\S+/gi, "[redacted]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AIza|xox[abpr]-|tvly-)[\w-]+/g, "[redacted]")
    .replace(/((?:authorization|api[_-]?key|token|password|secret|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    });
}
