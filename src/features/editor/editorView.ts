// How text is drawn in every editor: whitespace marks and word wrap. Not per file, so a preference
// set in one tab holds in the next.

export type EditorView = { whitespace: boolean; wrap: boolean };

const KEY = 'dachsterm.editor.view';
const defaults: EditorView = { whitespace: false, wrap: false };

function read(): EditorView {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved && typeof saved === 'object') {
      const { whitespace, wrap } = saved as Record<string, unknown>;
      return { whitespace: whitespace === true, wrap: wrap === true };
    }
  } catch {
    // Unreadable or blocked storage is the same as never having chosen.
  }
  return defaults;
}

let view: EditorView | null = null;
const listeners = new Set<() => void>();

export function getEditorView(): EditorView {
  return (view ??= read());
}

export function subscribeEditorView(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function setEditorView(change: Partial<EditorView>) {
  view = { ...getEditorView(), ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(view));
  } catch {
    // Blocked storage only means the choice does not outlast this run.
  }
  listeners.forEach((listener) => listener());
}
