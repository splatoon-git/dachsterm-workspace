/**
 * Where a file or a Git command lives (`source.rs`). Commands that work on any tab take this, so
 * the kind of tab is not mixed into a string.
 */
export type Source =
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'local'; targetId: string }
  | { kind: 'ftp'; connectionId: string };

export const sameSource = (a: Source, b: Source) =>
  a.kind === b.kind &&
  (a.kind === 'local'
    ? a.targetId === (b as typeof a).targetId
    : a.connectionId === (b as typeof a).connectionId);
