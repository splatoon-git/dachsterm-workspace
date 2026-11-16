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

/**
 * What the status bar says after a program replaced the clipboard. A write is never silent, so a
 * server cannot swap in a command between the user's copy and paste without the user seeing it.
 */
export function osc52Notice(text: string) {
  const chars = [...text].length;
  // Any line break runs the text when it is pasted at a prompt, a trailing one included.
  const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return breaks > 0
    ? `프로그램이 클립보드를 바꿨습니다(${chars}자, 줄바꿈 ${breaks}개). 붙여넣기 전에 내용을 확인하세요.`
    : `프로그램이 클립보드를 바꿨습니다(${chars}자).`;
}
