/** OSC 52 clipboard writes from a program. Reading is refused, so nothing can leave the PC. */
const maxDecodedBytes = 1024 * 1024;
const maxEncodedLength = Math.ceil(maxDecodedBytes / 3) * 4;

/** The text to copy, or null when the sequence should be ignored. */
export function parseOsc52(value: string): string | null {
  const at = value.indexOf(';');
  if (at < 0) return null;
  const targets = value.slice(0, at);
  const data = value.slice(at + 1);
  if ((targets && !targets.includes('c')) || !data || data === '?') return null;
  if (data.length > maxEncodedLength) return null;
  try {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    if (bytes.length > maxDecodedBytes) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
