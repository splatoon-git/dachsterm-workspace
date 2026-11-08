import { useRef, useState, type RefObject } from 'react';
import { notifyGitChange } from '../../lib/gitChanges';
import { call, errorText } from '../../lib/ipc';
import type { Source } from '../../lib/source';
import type { EditorHandle } from './editorTypes';
import type { SaveOutcome } from './fileDocuments';
import type { FileRead } from './fileRead';

/** What `file_write` returns (`file_write.rs`). */
type WriteResult =
  | { status: 'saved'; hash: string; notice: string | null }
  | { status: 'conflict'; hash: string | null };

export type Conflict = {
  path: string;
  /** What the file holds now, and so the base an overwrite has to name. Null when it is gone. */
  hash: string | null;
  /** What this save expected: null when the name was meant to be new. */
  expected: string | null;
};

export type ConflictKind = 'changed' | 'removed' | 'taken';

export function conflictKind(conflict: Pick<Conflict, 'hash' | 'expected'>): ConflictKind {
  if (conflict.expected === null) return 'taken';
  return conflict.hash === null ? 'removed' : 'changed';
}

/** Saving one text file. `hash` starts as what the tab read and follows every save. */
export function useFileSave({
  source,
  path,
  encoding,
  hash,
  editor,
  moved,
  saved,
}: {
  source: Source;
  path: string;
  encoding: string;
  hash: string;
  editor: RefObject<EditorHandle | null>;
  /** The save went to a new name, and the tab now belongs to it. */
  moved: (path: string) => void;
  /** The file now holds this text, with this hash. */
  saved?: (hash: string, text: string) => void;
}) {
  const base = useRef(hash);
  const running = useRef<Promise<SaveOutcome> | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const write = (target: string, baseHash: string | null): Promise<SaveOutcome> => {
    if (running.current) return running.current;
    const handle = editor.current;
    if (!handle) return Promise.resolve('failed');
    // Typing while the save runs must stay marked as unsaved, so only this version becomes clean.
    const version = handle.version();
    const content = handle.getValue();
    setError('');
    setNotice('');
    setSaving(true);
    const finish = (outcome: SaveOutcome) => {
      running.current = null;
      setSaving(false);
      return outcome;
    };
    const job = call<WriteResult>('file_write', {
      source,
      path: target,
      content,
      encoding,
      baseHash,
    }).then(
      (result) => {
        if (result.status === 'conflict') {
          setConflict({ path: target, hash: result.hash, expected: baseHash });
          return finish('conflict');
        }
        base.current = result.hash;
        handle.markClean(version);
        setConflict(null);
        saved?.(result.hash, content);
        notifyGitChange({ kind: 'saved', source });
        if (result.notice) setNotice(result.notice);
        if (target !== path) moved(target);
        return finish('saved');
      },
      (reason) => {
        setError(errorText(reason));
        return finish('failed');
      },
    );
    running.current = job;
    return job;
  };

  return {
    saving,
    conflict,
    error,
    notice,
    save: () => write(path, base.current),
    saveAs: (target: string) => write(target, null),
    /** Replaces exactly the version the conflict reported; if it moved on, this conflicts again. */
    overwrite: (found: Conflict) => write(found.path, found.hash),
    dismissConflict: () => setConflict(null),
  };
}

export type ServerText = { kind: 'text'; text: string } | { kind: 'none'; message: string };

/** The file as it is now, for comparing against the editor, read the same way the tab read it. */
export async function readCurrentText(
  source: Source,
  path: string,
  encoding: string | null,
): Promise<ServerText> {
  try {
    const file = await call<FileRead>('file_read', {
      source,
      path,
      options: { large: true, encoding },
    });
    return file.kind === 'text'
      ? { kind: 'text', text: file.text }
      : { kind: 'none', message: '텍스트 파일이 아니어서 비교할 수 없습니다.' };
  } catch (reason) {
    return { kind: 'none', message: errorText(reason) };
  }
}
