// The only file that imports the editor component (eslint enforces this). Load it through
// `CodeEditor.tsx`, which keeps it out of the first screen's bundle.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import type { ThemeDefinition } from '../../themes/contract';
import { editorTheme } from '../../themes/adapters/editor';
import { getCurrentTheme, subscribeTheme } from '../../themes/store';
import type { CodeEditorProps, DiffEditorProps, EditorHandle } from './editorTypes';
import { getEditorView, setEditorView, subscribeEditorView, type EditorView } from './editorView';

window.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

function fontOptions(theme: ThemeDefinition) {
  return {
    fontFamily: theme.foundations.font.mono,
    fontSize: Number.parseFloat(theme.foundations.font.body),
  };
}

const sharedOptions: monaco.editor.IEditorOptions = {
  automaticLayout: true,
  scrollBeyondLastLine: false,
  // WKWebView has no EditContext, so this keeps one input path on both OSes. In WebView2 the
  // EditContext path also lost a character when a key arrived during composition (GE.4).
  editContext: false,
  // Full-width punctuation is ordinary text in Korean, Japanese and Chinese files. Invisible
  // characters stay highlighted, since those are what hide a change from a reader.
  unicodeHighlight: { ambiguousCharacters: false },
};

function viewOptions(view: EditorView): monaco.editor.IEditorOptions {
  return {
    renderWhitespace: view.whitespace ? 'all' : 'selection',
    wordWrap: view.wrap ? 'on' : 'off',
  };
}

/** In the editor's own right-click menu and command list, not as buttons on the screen. */
function addViewActions(editor: monaco.editor.IStandaloneCodeEditor) {
  editor.addAction({
    id: 'dachsterm.toggleWhitespace',
    label: '공백 문자 보기',
    contextMenuGroupId: 'dachsterm',
    contextMenuOrder: 1,
    run: () => setEditorView({ whitespace: !getEditorView().whitespace }),
  });
  editor.addAction({
    id: 'dachsterm.toggleWrap',
    label: '자동 줄바꿈',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
    contextMenuGroupId: 'dachsterm',
    contextMenuOrder: 2,
    run: () => setEditorView({ wrap: !getEditorView().wrap }),
  });
}

/**
 * What the rest of the app may do with one editor's text. Monaco's alternative version id comes
 * back to the same value after undo, so undoing every edit also clears the unsaved mark.
 */
function documentHandle(
  editor: monaco.editor.ICodeEditor,
  model: monaco.editor.ITextModel,
  report: (dirty: boolean) => void,
) {
  let clean = model.getAlternativeVersionId();
  let dirty = false;
  const update = () => {
    const now = model.getAlternativeVersionId() !== clean;
    if (now !== dirty) {
      dirty = now;
      report(now);
    }
  };
  const convert = (id: string) => editor.getAction(id)?.run() ?? Promise.resolve();
  const handle: EditorHandle = {
    focus: () => editor.focus(),
    getValue: () => model.getValue(),
    version: () => model.getAlternativeVersionId(),
    markClean: (version) => {
      clean = version;
      update();
    },
    setLineBreak: (lineBreak) =>
      model.pushEOL(
        lineBreak === 'CRLF'
          ? monaco.editor.EndOfLineSequence.CRLF
          : monaco.editor.EndOfLineSequence.LF,
      ),
    setIndent: async ({ tabs, size }) => {
      // Through tabs, read with the old width, so that 4 spaces become 2 and not 4 again.
      await convert('editor.action.indentationToTabs');
      model.updateOptions({ tabSize: size, indentSize: size, insertSpaces: !tabs });
      if (!tabs) await convert('editor.action.indentationToSpaces');
    },
  };
  return { handle, update, resetClean: () => handle.markClean(handle.version()) };
}

/** Monaco has one theme per window, so every editor can re-register it safely. */
function useEditorTheme() {
  const theme = useSyncExternalStore(subscribeTheme, getCurrentTheme);
  useEffect(() => {
    const name = `dachsterm-${theme.id}`;
    monaco.editor.defineTheme(name, editorTheme(theme));
    monaco.editor.setTheme(name);
  }, [theme]);
  return theme;
}

export function MonacoCodeEditor(props: CodeEditorProps) {
  const { value, language = 'plaintext', readOnly = false, ariaLabel } = props;
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const resetClean = useRef<() => void>(() => {});
  const applyingValue = useRef(false);
  const theme = useEditorTheme();
  const view = useSyncExternalStore(subscribeEditorView, getEditorView);
  const initial = useRef({ value, language, readOnly, ariaLabel, theme, view });
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    if (!host.current) return;
    const first = initial.current;
    const model = monaco.editor.createModel(first.value, first.language);
    const editor = monaco.editor.create(host.current, {
      ...sharedOptions,
      ...fontOptions(first.theme),
      ...viewOptions(first.view),
      model,
      readOnly: first.readOnly,
      ariaLabel: first.ariaLabel,
    });
    editorRef.current = editor;
    const document = documentHandle(editor, model, (dirty) =>
      latest.current.onDirtyChange?.(dirty),
    );
    resetClean.current = document.resetClean;
    const changes = model.onDidChangeContent(() => {
      if (applyingValue.current) return;
      latest.current.onChange?.();
      document.update();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => latest.current.onSave?.());
    addViewActions(editor);
    latest.current.onReady?.(document.handle);
    return () => {
      changes.dispose();
      editorRef.current = null;
      // The editor first: a model disposed while still attached makes Monaco report an error.
      editor.dispose();
      model.dispose();
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.getValue() === value) return;
    applyingValue.current = true;
    editor.setValue(value);
    applyingValue.current = false;
    resetClean.current();
  }, [value]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, ariaLabel });
  }, [readOnly, ariaLabel]);
  useEffect(() => {
    editorRef.current?.updateOptions(fontOptions(theme));
  }, [theme]);
  useEffect(() => {
    editorRef.current?.updateOptions(viewOptions(view));
  }, [view]);

  return <div ref={host} className="editor-host" />;
}

export function MonacoDiffEditor(props: DiffEditorProps) {
  const { original, modified, language = 'plaintext', layout, readOnly = false, ariaLabel } = props;
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<monaco.editor.IDiffEditorModel | null>(null);
  const applyingValue = useRef(false);
  const theme = useEditorTheme();
  const initial = useRef({ original, modified, language, layout, readOnly, ariaLabel, theme });
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    if (!host.current) return;
    const first = initial.current;
    const models = {
      original: monaco.editor.createModel(first.original, first.language),
      modified: monaco.editor.createModel(first.modified, first.language),
    };
    const editor = monaco.editor.createDiffEditor(host.current, {
      ...sharedOptions,
      ...fontOptions(first.theme),
      renderSideBySide: first.layout === 'split',
      // The layout is the user's choice; do not switch it for a narrow pane.
      useInlineViewWhenSpaceIsLimited: false,
      originalEditable: false,
      readOnly: first.readOnly,
      ariaLabel: first.ariaLabel,
    });
    editor.setModel(models);
    editorRef.current = editor;
    modelsRef.current = models;
    const changes = models.modified.onDidChangeContent(() => {
      if (!applyingValue.current) latest.current.onChange?.();
    });
    editor
      .getModifiedEditor()
      .addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => latest.current.onSave?.());
    // A diff has no unsaved mark of its own yet, so nothing listens to this report (GE.8).
    latest.current.onReady?.(
      documentHandle(editor.getModifiedEditor(), models.modified, () => {}).handle,
    );
    return () => {
      changes.dispose();
      editorRef.current = null;
      modelsRef.current = null;
      editor.dispose();
      models.original.dispose();
      models.modified.dispose();
    };
  }, []);

  useEffect(() => {
    const model = modelsRef.current?.original;
    if (model && model.getValue() !== original) model.setValue(original);
  }, [original]);
  useEffect(() => {
    const model = modelsRef.current?.modified;
    if (!model || model.getValue() === modified) return;
    applyingValue.current = true;
    model.setValue(modified);
    applyingValue.current = false;
  }, [modified]);
  useEffect(() => {
    const models = modelsRef.current;
    if (!models) return;
    monaco.editor.setModelLanguage(models.original, language);
    monaco.editor.setModelLanguage(models.modified, language);
  }, [language]);
  useEffect(() => {
    editorRef.current?.updateOptions({
      renderSideBySide: layout === 'split',
      readOnly,
      ariaLabel,
    });
  }, [layout, readOnly, ariaLabel]);
  useEffect(() => {
    editorRef.current?.updateOptions(fontOptions(theme));
  }, [theme]);

  return <div ref={host} className="editor-host" />;
}
