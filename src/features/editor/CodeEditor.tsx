// The editor's boundary for the rest of the app: everything outside this folder imports from here.
// The component itself is loaded on first use, as the games are.
import { lazy, Suspense } from 'react';
import type { CodeEditorProps, DiffEditorProps } from './editorTypes';
import './editor.css';

const loadEditors = () => import('./MonacoEditors');
const MonacoCodeEditor = lazy(async () => ({
  default: (await loadEditors()).MonacoCodeEditor,
}));
const MonacoDiffEditor = lazy(async () => ({
  default: (await loadEditors()).MonacoDiffEditor,
}));

const loading = (
  <div className="editor-loading" role="status">
    편집기를 불러오는 중…
  </div>
);

export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={loading}>
      <MonacoCodeEditor {...props} />
    </Suspense>
  );
}

export function DiffEditor(props: DiffEditorProps) {
  return (
    <Suspense fallback={loading}>
      <MonacoDiffEditor {...props} />
    </Suspense>
  );
}
