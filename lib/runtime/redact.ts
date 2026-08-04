/**
 * Redact secret values from text before it reaches the browser.
 *
 * Every non-empty secret is replaced with `***`. Empty/whitespace secrets are
 * dropped so an unset credential can never blank out unrelated output (a naive
 * `split("")` would insert `***` between every character).
 */
export function makeRedactor(
  secrets: readonly (string | undefined | null)[],
): (text: string) => string {
  const active = secrets.filter((s): s is string => Boolean(s && s.length > 0));
  if (active.length === 0) return (text) => text;
  return (text) => active.reduce((acc, secret) => acc.split(secret).join("***"), text);
}
