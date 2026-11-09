/** Remembers a small convenience. A full or blocked store only forgets it. */
export function saveSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The setting still applies for this run; only the next start loses it.
  }
}
