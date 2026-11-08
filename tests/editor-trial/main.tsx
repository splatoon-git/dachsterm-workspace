// Editor trial screen. It replaces the app's page in a separate build so the wrapper runs under the
// real WebView and CSP while no trial code ships. `scripts/test-editor-native.mjs` drives it through
// `window.__editorTrial`; a person uses the toolbar, which is the only way in on macOS.
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CodeEditor, DiffEditor } from '../../src/features/editor/CodeEditor';
import type { EditorHandle, DiffLayout } from '../../src/features/editor/editorTypes';
import { applyTheme } from '../../src/themes/adapters/css';
import { themes } from '../../src/themes/registry';
import { selectTheme } from '../../src/themes/store';
import { useTheme } from '../../src/themes/useTheme';
import './trial.css';

type View =
  | { kind: 'none' }
  | { kind: 'code'; value: string; language: string }
  | { kind: 'diff'; original: string; modified: string; language: string; layout: DiffLayout };

type Trial = {
  show(view: View): void;
  setTheme(id: string): void;
  themes: string[];
  handle: EditorHandle | null;
  /** The text at each save, in order. */
  saves: string[];
  /** Filled before any editor loads, so a worker that fails to start is recorded. */
  workers: { url: string; errors: string[] }[];
  cspViolations: string[];
};

declare global {
  interface Window {
    __editorTrial: Trial;
  }
}

const workers: Trial['workers'] = [];
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    const entry = { url: String(url), errors: [] as string[] };
    workers.push(entry);
    this.addEventListener('error', (event) => entry.errors.push(event.message || 'load failed'));
  }
};
const cspViolations: string[] = [];
document.addEventListener('securitypolicyviolation', (event) =>
  cspViolations.push(`${event.effectiveDirective} ${event.blockedURI}`),
);

const sampleCode = `// 한글 주석과 Korean comment
const answer: number = 42;
function greet(name: string) {
  return \`안녕하세요 \${name}\`;
}
`;
const bigFile = () =>
  Array.from(
    { length: 100_000 },
    (_, index) => `const line${index + 1} = ${index}; // 한글 주석 ${index + 1}`,
  ).join('\n');
const diffBefore = `첫 줄은 그대로\n둘째 줄을 바꿉니다\n셋째 줄은 그대로\n`;
const diffAfter = `첫 줄은 그대로\n둘째 줄이 바뀌었습니다\n셋째 줄은 그대로\n넷째 줄을 더했습니다\n`;

const presets: Record<string, () => View> = {
  '빈 문서(입력 확인)': () => ({ kind: 'code', value: '', language: 'plaintext' }),
  TypeScript: () => ({ kind: 'code', value: sampleCode, language: 'typescript' }),
  '10만 줄': () => ({ kind: 'code', value: bigFile(), language: 'typescript' }),
  'diff 좌우': () => ({
    kind: 'diff',
    original: diffBefore,
    modified: diffAfter,
    language: 'plaintext',
    layout: 'split',
  }),
  'diff 한 줄': () => ({
    kind: 'diff',
    original: diffBefore,
    modified: diffAfter,
    language: 'plaintext',
    layout: 'inline',
  }),
};

const trial: Trial = {
  show: () => {},
  setTheme: (id) => void selectTheme(id),
  themes: themes.map((theme) => theme.id),
  handle: null,
  saves: [],
  workers,
  cspViolations,
};
window.__editorTrial = trial;

function Trial() {
  const theme = useTheme();
  const [state, setState] = useState<{ view: View; key: number }>({
    view: presets['빈 문서(입력 확인)'](),
    key: 0,
  });
  const [saveCount, setSaveCount] = useState(0);
  useEffect(() => {
    trial.show = (view) => {
      trial.handle = null;
      setState((current) => ({ view, key: current.key + 1 }));
    };
  }, []);
  const callbacks = useMemo(
    () => ({
      onReady: (handle: EditorHandle) => {
        trial.handle = handle;
        handle.focus();
      },
      onSave: () => {
        trial.saves.push(trial.handle?.getValue() ?? '');
        setSaveCount(trial.saves.length);
      },
    }),
    [],
  );
  const { view, key } = state;
  return (
    <div className="trial">
      <div className="trial-bar">
        <label>
          화면{' '}
          <select onChange={(event) => trial.show(presets[event.target.value]())}>
            {Object.keys(presets).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          테마{' '}
          <select value={theme.id} onChange={(event) => trial.setTheme(event.target.value)}>
            {themes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <span>저장 {saveCount}회</span>
      </div>
      <main>
        {view.kind === 'code' ? (
          <CodeEditor
            key={key}
            value={view.value}
            language={view.language}
            ariaLabel="시험 편집기"
            {...callbacks}
          />
        ) : null}
        {view.kind === 'diff' ? (
          <DiffEditor
            key={key}
            original={view.original}
            modified={view.modified}
            language={view.language}
            layout={view.layout}
            ariaLabel="시험 diff"
            {...callbacks}
          />
        ) : null}
      </main>
    </div>
  );
}

applyTheme(themes[0]);
createRoot(document.getElementById('root')!).render(<Trial />);
