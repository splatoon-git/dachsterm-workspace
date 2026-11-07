import type { ILink, ILinkHandler, IBufferLine, Terminal } from '@xterm/xterm';
import { call, errorText } from '../../lib/ipc';

export type LinkTarget = 'open' | 'server' | 'blocked';

const urlPattern = /https?:\/\/[^\s<>"'`]+/gi;
const trailingPunctuation = /[.,;:!?)\]}]+$/;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

export function findUrls(text: string) {
  return Array.from(text.matchAll(urlPattern), (match) => {
    const url = match[0].replace(trailingPunctuation, '');
    return { url, start: match.index, end: match.index + url.length };
  });
}

/** A loopback address printed by a server means that server, not this PC. */
export function classifyLink(url: string, remote: boolean): LinkTarget {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return 'blocked';
    return remote && loopbackHosts.has(parsed.hostname) ? 'server' : 'open';
  } catch {
    return 'blocked';
  }
}

type LinkHost = {
  /** True for a tab running on another machine. */
  remote: () => boolean;
  notice: (message: string) => void;
};

/** One logical line as cells, so wide characters and soft wraps map back to screen positions. */
function logicalLine(terminal: Terminal, y: number) {
  const buffer = terminal.buffer.active;
  let first = y;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = '';
  const cells: { x: number; y: number }[] = [];
  let line: IBufferLine | undefined;
  for (let row = first; (line = buffer.getLine(row)); row++) {
    if (row > first && !line.isWrapped) break;
    for (let x = 0; x < line.length; x++) {
      const chars = line.getCell(x)?.getChars() || ' ';
      // One entry per UTF-16 unit, because match positions in `text` count those.
      for (let unit = 0; unit < chars.length; unit++) cells.push({ x: x + 1, y: row + 1 });
      text += chars;
    }
  }
  return { text, cells };
}

export function attachTerminalLinks(terminal: Terminal, host: LinkHost) {
  const activate = (event: MouseEvent, url: string) => {
    // A plain click belongs to the terminal or the program. Opening takes Ctrl or Cmd.
    if (!event.ctrlKey && !event.metaKey) return;
    const target = classifyLink(url, host.remote());
    if (target === 'server') host.notice('서버 내부 주소입니다. 터널을 연 뒤 내 PC 주소로 여세요.');
    else if (target === 'open')
      void call('url_open', { url }).catch((error) => host.notice(errorText(error)));
    else host.notice('이 링크는 열 수 없습니다.');
  };
  // OSC 8 text can differ from its target, so hovering always shows where it really goes.
  const hover = (_: MouseEvent, url: string) => {
    if (terminal.element) terminal.element.title = `${url}\nCtrl/Cmd+클릭으로 열기`;
  };
  const leave = () => {
    if (terminal.element) terminal.element.title = '';
  };
  const handler: ILinkHandler = { activate, hover, leave, allowNonHttpProtocols: false };
  terminal.options.linkHandler = handler;
  terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const { text, cells } = logicalLine(terminal, y - 1);
      const links: ILink[] = [];
      for (const { url, start, end } of findUrls(text)) {
        const from = cells[start];
        const to = cells[end - 1];
        if (!from || !to || y < from.y || y > to.y) continue;
        links.push({
          text: url,
          range: { start: from, end: to },
          activate,
          hover,
          leave,
          decorations: { pointerCursor: true, underline: true },
        });
      }
      callback(links.length ? links : undefined);
    },
  });
}
