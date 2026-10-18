export function matchesPattern(url: string, pattern: string): boolean {
  if (pattern === '<all_urls>') {
    return /^(https?|file):\/\//.test(url);
  }

  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  return new RegExp(`^${escaped}$`).test(url);
}