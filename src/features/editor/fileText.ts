// Facts about a text file's contents, shown in the status bar and used by its views.

export type LineEnding = 'LF' | 'CRLF' | '혼합' | '없음';
export type TextFacts = { eol: LineEnding; indent: string };

const SAMPLE_LINES = 2000;

export function lineEnding(text: string): LineEnding {
  let lf = 0;
  let crlf = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    if (at > 0 && text[at - 1] === '\r') crlf++;
    else lf++;
  }
  if (!lf && !crlf) return '없음';
  if (lf && crlf) return '혼합';
  return crlf ? 'CRLF' : 'LF';
}

/** Tabs when more lines start with a tab; otherwise the most common step between indent levels. */
export function indentation(text: string): string {
  const lines = text.split('\n', SAMPLE_LINES);
  let tabs = 0;
  let spaces = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line[0] === '\t') {
      tabs++;
      continue;
    }
    const width = line.length - line.trimStart().length;
    if (width && line[0] === ' ') spaces++;
    const step = Math.abs(width - previous);
    if (step) steps.set(step, (steps.get(step) ?? 0) + 1);
    previous = width;
  }
  if (tabs > spaces) return '탭';
  if (!spaces) return '없음';
  let best = 0;
  let count = 0;
  for (const [step, seen] of steps) {
    if (seen > count || (seen === count && step < best)) {
      best = step;
      count = seen;
    }
  }
  return `공백 ${best}`;
}

export const textFacts = (text: string): TextFacts => ({
  eol: lineEnding(text),
  indent: indentation(text),
});

/**
 * Re-indents JSON by moving text, not by parsing and printing, so a long number or a repeated key
 * stays exactly as the file has it. Null when the text is not valid JSON.
 */
export function prettyJson(text: string, width = 2): string | null {
  try {
    JSON.parse(text);
  } catch {
    // Not an error to report: the view explains that this text cannot be tidied.
    return null;
  }
  let out = '';
  let depth = 0;
  let inString = false;
  const newline = () => '\n' + ' '.repeat(depth * width);
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') out += text[++i];
      else if (char === '"') inString = false;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') continue;
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '{' || char === '[') {
      const close = char === '{' ? '}' : ']';
      let next = i + 1;
      while (' \t\r\n'.includes(text[next])) next++;
      if (text[next] === close) {
        out += char + close;
        i = next;
      } else {
        depth++;
        out += char + newline();
      }
    } else if (char === '}' || char === ']') {
      depth--;
      out += newline() + char;
    } else if (char === ',') {
      out += char + newline();
    } else if (char === ':') {
      out += ': ';
    } else {
      out += char;
    }
  }
  return out;
}
