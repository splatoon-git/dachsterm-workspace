import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';
import type { TerminalSession, SessionState } from '../../../src/features/terminal/session';
import type { Library } from '../../../src/features/terminal/snippets';
declare global {
  interface Window {
    __sent: unknown[];
    __invalidate: () => void;
    __clipboard: string;
    __copyFail: boolean;
    __guide: (program: 'cat' | null) => void;
    __alternate: (on: boolean) => void;
  }
}
window.__sent = [];
window.__copyFail = false;
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: async (text: string) => {
      if (window.__copyFail) throw Error('denied');
      window.__clipboard = text;
    },
  },
});
let library: Library = JSON.parse(
  localStorage.getItem('fixture.snippets') ?? '{"revision":0,"items":[]}',
);
Object.defineProperty(window, 'isTauri', { value: true });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    invoke: async (
      command: string,
      args: { revision: number; items: Library['items']; targets: { id: string }[] },
    ) => {
      if (command === 'snippet_list') return library;
      if (command === 'snippet_save') {
        if (args.revision !== library.revision) throw '다른 창에서 변경되었습니다.';
        library = { revision: library.revision + 1, items: args.items };
        localStorage.setItem('fixture.snippets', JSON.stringify(library));
        return library;
      }
      if (command === 'snippet_send') {
        window.__sent.push(args);
        return args.targets.map((t) => ({ id: t.id, error: null }));
      }
      throw Error(command);
    },
  },
});
const { blankProfile } = await import('../../../src/lib/ipc');
const { CommandPanel } = await import('../../../src/features/terminal/CommandPanel');
const { ProgramGuide } = await import('../../../src/features/terminal/CommandGuide');
const { PaneView } = await import('../../../src/features/terminal/paneView');
const states: SessionState[] = [
  { status: 'connected', message: '', hostKey: null, guideProgram: null },
];
const buffer = {
  active: { type: 'normal' },
  changed: new Set<() => void>(),
  onBufferChange(fn: () => void) {
    buffer.changed.add(fn);
    return { dispose: () => buffer.changed.delete(fn) };
  },
};
window.__alternate = (on) => {
  buffer.active = { type: on ? 'alternate' : 'normal' };
  buffer.changed.forEach((fn) => fn());
};
const listeners = new Set<() => void>();
window.__guide = (program) => {
  states[0] = { ...states[0], guideProgram: program, guideRun: (states[0].guideRun ?? 0) + 1 };
  listeners.forEach((fn) => fn());
};
const first = {
  tabId: 'one',
  connectionId: 'id-one',
  profile: { ...blankProfile(), name: '테스트 SSH', host: 'example.test', username: 'test' },
  terminal: { modes: { bracketedPasteMode: true }, buffer },
  view: new PaneView(),
  snapshot: () => states[0],
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
} as unknown as TerminalSession;
const second = {
  ...first,
  tabId: 'two',
  connectionId: 'id-two',
  profile: { ...first.profile, name: '테스트 로컬' },
  localTarget: { id: 'powershell', name: 'PowerShell', kind: 'shell' },
} as unknown as TerminalSession;
const excluded = {
  ...first,
  tabId: 'pod',
  profile: { ...first.profile, name: '파드 탭' },
  podTerminal: {},
} as unknown as TerminalSession;
window.__invalidate = () => {
  first.connectionId = 'new-id';
};
applyTheme(getCurrentTheme());
function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>명령 열기</button>
      {/* The app opens the full guide from the tab menu. */}
      <button onClick={() => first.view.set({ guide: true })}>조작표 전체 보기</button>
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: 24 }}>
        <ProgramGuide session={first} />
      </div>
      {open && (
        <CommandPanel
          sessions={[first, second, excluded]}
          active="one"
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
