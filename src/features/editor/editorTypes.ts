// What the app may know about the editor. No type here names the editor component, so replacing
// the component stays inside `MonacoEditors.tsx`.

export type EditorHandle = {
  focus(): void;
  /** The editor's text; the modified side for a diff. */
  getValue(): string;
};

export type CodeEditorProps = {
  /** Replaces the text when it differs from the editor's, without reporting a change. */
  value: string;
  language?: string;
  readOnly?: boolean;
  ariaLabel?: string;
  /** Reports that the user changed the text. Read it with `EditorHandle.getValue`. */
  onChange?: () => void;
  /** Ctrl/Cmd+S inside the editor. */
  onSave?: () => void;
  onReady?: (handle: EditorHandle) => void;
};

export type DiffLayout = 'split' | 'inline';

export type DiffEditorProps = {
  original: string;
  modified: string;
  language?: string;
  layout: DiffLayout;
  /** Whether the modified side is read-only. The original side always is. */
  readOnly?: boolean;
  ariaLabel?: string;
  onChange?: () => void;
  onSave?: () => void;
  onReady?: (handle: EditorHandle) => void;
};
