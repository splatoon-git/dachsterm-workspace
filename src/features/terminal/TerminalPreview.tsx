import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  terminalColorOptions,
  terminalFontFamily,
  terminalTheme,
} from '../../themes/adapters/xterm';
import type { ThemeDefinition } from '../../themes/contract';
export function TerminalPreview({ theme }: { theme: ThemeDefinition }) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Terminal | null>(null);
  useEffect(() => {
    const terminal = new Terminal({
      ...terminalColorOptions(theme),
      fontFamily: terminalFontFamily(theme),
      fontSize: 13,
      cursorBlink: false,
      disableStdin: true,
      scrollback: 500,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current!);
    instance.current = terminal;
    terminal.writeln('DachsTerm · 터미널 미리보기');
    terminal.writeln('한글 / UTF-8  •  아직 서버에 연결되지 않았습니다.\r\n');
    for (const [code, label] of [
      [32, 'SUCCESS'],
      [34, 'INFO'],
      [33, 'WARNING'],
      [31, 'ERROR'],
    ] as const)
      terminal.writeln(`\x1b[${code}m● ${label}\x1b[0m  ANSI 색상 미리보기`);
    terminal.writeln('\r\n  16 ANSI colors');
    terminal.writeln(
      Array.from({ length: 16 }, (_, i) => `\x1b[${i < 8 ? 30 + i : 90 + i - 8}m Aa \x1b[0m`).join(
        '',
      ),
    );
    const observer = new ResizeObserver(() => {
      if (host.current?.clientWidth) fit.fit();
    });
    observer.observe(host.current!);
    return () => {
      observer.disconnect();
      terminal.dispose();
      instance.current = null;
    };
    // Instance lifetime is separate from theme updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (instance.current) {
      instance.current.options.theme = terminalTheme(theme);
      instance.current.options.fontFamily = terminalFontFamily(theme);
    }
  }, [theme]);
  return (
    <div className="terminal-preview" ref={host} aria-label="연결되지 않은 터미널 색상 미리보기" />
  );
}
