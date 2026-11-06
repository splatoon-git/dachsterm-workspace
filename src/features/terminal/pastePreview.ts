export type PasteSegment =
  { kind: 'text'; text: string } | { kind: 'lineBreak' } | { kind: 'hidden'; label: string };

export type PastePreview = {
  segments: PasteSegment[];
  lineBreaks: number;
  hiddenCharacters: number;
  /** Characters beyond the preview limit. They are still sent when the user confirms. */
  omitted: number;
};

const previewLimit = 20_000;

/** A short name for a character that would otherwise be invisible, or null for ordinary text. */
function hiddenLabel(character: string) {
  const code = character.codePointAt(0)!;
  if (code === 0) return 'NUL';
  if (code === 0x1b) return 'ESC';
  if (code === 0x7f) return 'DEL';
  if (code < 32 && code !== 9) return `^${String.fromCharCode(code + 64)}`;
  // C1 controls, plus zero-width and bidi format characters. These can make the
  // preview read differently from the bytes that the terminal actually receives.
  const invisible =
    (code >= 0x80 && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff;
  return invisible ? `U+${code.toString(16).toUpperCase().padStart(4, '0')}` : null;
}

/** Describes clipboard text for the paste confirmation. Counts always cover the whole text. */
export function describePaste(text: string): PastePreview {
  const segments: PasteSegment[] = [];
  let literal = '';
  let shown = 0;
  let omitted = 0;
  let lineBreaks = 0;
  let hiddenCharacters = 0;
  let previous = '';
  const flush = () => {
    if (literal) segments.push({ kind: 'text', text: literal });
    literal = '';
  };
  for (const character of text) {
    const crlf = previous === '\r' && character === '\n';
    previous = character;
    if (crlf) continue;
    const lineBreak = character === '\n' || character === '\r';
    const label = lineBreak ? null : hiddenLabel(character);
    if (lineBreak) lineBreaks++;
    else if (label) hiddenCharacters++;
    if (shown >= previewLimit) {
      omitted++;
      continue;
    }
    shown++;
    if (lineBreak || label) {
      flush();
      segments.push(label ? { kind: 'hidden', label } : { kind: 'lineBreak' });
    } else literal += character;
  }
  flush();
  return { segments, lineBreaks, hiddenCharacters, omitted };
}
