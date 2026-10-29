/** Preserve custom proxy paths; fill the missing version on the official root. */
export function anthropicBaseUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/$/, "");
  return /^https:\/\/api\.anthropic\.com$/i.test(base) ? `${base}/v1` : base;
}
