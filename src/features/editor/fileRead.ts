import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import type { Source } from '../../lib/source';

/** What `file_read` returns (`file_read.rs`). */
type Facts = { size: number | null; modified: number | null };
export type FileRead = Facts &
  (
    | {
        kind: 'text';
        text: string;
        encoding: string;
        /** Some bytes were not valid here, so the text holds replacement characters. */
        lossy: boolean;
        large: boolean;
        hash: string;
      }
    | { kind: 'image'; mime: string; data: string; hash: string }
    | { kind: 'binary'; format: string }
    | { kind: 'large' }
    | { kind: 'tooLarge' }
  );

type ReadOptions = { large: boolean; encoding: string | null };
export type ReadState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  /** `generation` counts the reads, so reading the same bytes again still starts a fresh tab. */
  | { status: 'done'; file: FileRead; generation: number };

const firstOptions: ReadOptions = { large: false, encoding: null };

/** Reads the file, and again whenever the user changes how it should be read. */
export function useFileRead(source: Source, path: string) {
  const [options, setOptions] = useState(firstOptions);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ReadState>({ status: 'loading' });
  const generation = useRef(0);
  const adopted = useRef<string | null>(null);
  useEffect(() => {
    // Saved under this name a moment ago: the editor already holds exactly these bytes.
    if (adopted.current === path) {
      adopted.current = null;
      return;
    }
    let alive = true;
    call<FileRead>('file_read', { source, path, options }).then(
      (file) => {
        if (!alive) return;
        generation.current += 1;
        setState({ status: 'done', file, generation: generation.current });
      },
      (e) => {
        if (alive) setState({ status: 'failed', message: errorText(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [source, path, options, revision]);
  const change = useCallback((next: Partial<ReadOptions>) => {
    setState({ status: 'loading' });
    setOptions((old) => ({ ...old, ...next }));
  }, []);
  const chooseEncoding = useCallback((encoding: string) => change({ encoding }), [change]);
  return {
    state,
    openLarge: () => change({ large: true }),
    chooseEncoding,
    /** The encoding the user picked, or null when the file's own bytes decided it. */
    chosenEncoding: options.encoding,
    reload: useCallback(() => {
      setState({ status: 'loading' });
      setRevision((value) => value + 1);
    }, []),
    /** The tab moves to this path after a save, without reading what it just wrote. */
    adopt: useCallback((next: string) => {
      adopted.current = next;
    }, []),
  };
}
