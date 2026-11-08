// What the app may know about the editor. No type here names the editor component, so replacing
// the component stays inside `MonacoEditors.tsx`.

export type LineBreak = 'LF' | 'CRLF';
export type Indent = { tabs: boolean; size: number };

export type EditorHandle = {
  focus(): void;
  /** The editor's text; the modified side for a diff. */
  getValue(): string;
  /** Names the text as it is now. Undo back to it returns the same value. */
  version(): number;
  /** Records that the text at `version` is what the file holds. */
  markClean(version: number): void;
  /** Rewrites every line break. One undo step, and it counts as an edit. */
  setLineBreak(lineBreak: LineBreak): void;
  /** Rewrites leading whitespace, and how new lines are indented. */
  setIndent(indent: Indent): Promise<void>;
};

export type CodeEditorProps = {
  /** Replaces the text when it differs from the editor's, without reporting a change. */
  value: string;
  language?: string;
  readOnly?: boolean;
  ariaLabel?: string;
  /** Reports that the user changed the text. Read it with `EditorHandle.getValue`. */
  onChange?: () => void;
  /** Whether the text differs from the last `markClean`, each time that changes. */
  onDirtyChange?: (dirty: boolean) => void;
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
