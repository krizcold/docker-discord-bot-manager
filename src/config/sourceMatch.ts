/**
 * Match a source-keyed registry record (template modifiers, install manifests)
 * against a repo URL: exact `url` or substring `urlContains`, case-insensitive.
 * Keeps registries keyed by data (the source URL) with no bot names in logic.
 */
export interface SourceMatch {
  url?: string;
  urlContains?: string;
}

export function matchesSource(match: SourceMatch, url: string): boolean {
  const u = (url || '').toLowerCase();
  if (match.url) return u === match.url.toLowerCase();
  if (match.urlContains) return !!u && u.includes(match.urlContains.toLowerCase());
  return false;
}
