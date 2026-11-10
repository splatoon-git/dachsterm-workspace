/**
 * Files and clipboard images waiting in the composer. Nothing is uploaded or saved until the
 * message is sent, so removing a chip costs nothing.
 */
export type ChatAttachment = { id: string; name: string; size: number } & (
  | { kind: 'file'; path: string }
  /** `digest` is the clipboard image the user saw; a changed clipboard is refused at send. */
  | { kind: 'clipboard'; digest: string }
);

/** What `prompt_files_inspect` and `prompt_clipboard_inspect` give back. */
export type AttachItem = { name: string; size: number };
export type ClipboardImage = { item: AttachItem; digest: string };

/** The same file twice would only make the agent read it twice. */
export function addFiles(list: ChatAttachment[], paths: string[], items: AttachItem[]) {
  const known = new Set(list.flatMap((a) => (a.kind === 'file' ? [a.path] : [])));
  const added: ChatAttachment[] = paths.flatMap((path, i) =>
    known.has(path) ? [] : [{ id: crypto.randomUUID(), kind: 'file', path, ...items[i] }],
  );
  return [...list, ...added];
}

/** The message the agent reads: the user's words, then where each attachment can be read. */
export function withAttachments(text: string, paths: string[]) {
  if (!paths.length) return text;
  const list = paths.map((path) => `- ${path}`).join('\n');
  return `${text.trim() ? `${text.trim()}\n\n` : ''}첨부한 파일:\n${list}`;
}

export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
