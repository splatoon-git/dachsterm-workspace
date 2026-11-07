import { describe, expect, it } from 'vitest';
import {
  clipLine,
  MAX_LINE,
  parseUnifiedDiff,
  selectionRange,
  splitRows,
  unifiedRows,
} from './unifiedDiff';
import { terminalCommand, type DiffFile } from './gitDiff';

const modified = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function a() {
 one
-two
-three
+TWO
+THREE
+added
 four
@@ -10 +11 @@
-ten
\\ No newline at end of file
+TEN
\\ No newline at end of file
`;

describe('parseUnifiedDiff', () => {
  it('numbers both sides through every hunk', () => {
    const diff = parseUnifiedDiff(modified);
    expect(diff.binary).toBe(false);
    expect(diff.hunks.map((h) => h.header)).toEqual([
      '@@ -1,4 +1,5 @@ function a() {',
      '@@ -10 +11 @@',
    ]);
    expect(diff.hunks[0].lines).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'one' },
      { kind: 'del', old: 2, text: 'two' },
      { kind: 'del', old: 3, text: 'three' },
      { kind: 'add', new: 2, text: 'TWO' },
      { kind: 'add', new: 3, text: 'THREE' },
      { kind: 'add', new: 4, text: 'added' },
      { kind: 'context', old: 4, new: 5, text: 'four' },
    ]);
    expect(diff.hunks[1].lines).toEqual([
      { kind: 'del', old: 10, text: 'ten' },
      { kind: 'note', text: 'No newline at end of file' },
      { kind: 'add', new: 11, text: 'TEN' },
      { kind: 'note', text: 'No newline at end of file' },
    ]);
  });

  it('reads new, deleted and renamed files and their facts', () => {
    const added = parseUnifiedDiff(
      'diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n',
    );
    expect(added.meta).toEqual(['new file mode 100644']);
    expect(added.hunks[0].lines.map((l) => l.kind)).toEqual(['add', 'add']);
    const deleted = parseUnifiedDiff(
      'diff --git a/d b/d\ndeleted file mode 100644\n--- a/d\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n',
    );
    expect(deleted.hunks[0].lines).toEqual([{ kind: 'del', old: 1, text: 'x' }]);
    const renamed = parseUnifiedDiff(
      'diff --git a/old name b/새 이름\nsimilarity index 100%\nrename from old name\nrename to 새 이름\n',
    );
    expect(renamed.meta).toEqual([
      'similarity index 100%',
      'rename from old name',
      'rename to 새 이름',
    ]);
    expect(renamed.hunks).toEqual([]);
  });

  it('marks binary changes without hunks', () => {
    const diff = parseUnifiedDiff(
      'diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n',
    );
    expect(diff.binary).toBe(true);
    expect(diff.hunks).toEqual([]);
  });

  it('keeps content that looks like a header inside a hunk', () => {
    const diff = parseUnifiedDiff(
      '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- a/fake\n+++ b/fake\n context\n',
    );
    expect(diff.hunks[0].lines).toEqual([
      { kind: 'del', old: 1, text: '-- a/fake' },
      { kind: 'add', new: 1, text: '++ b/fake' },
      { kind: 'context', old: 2, new: 2, text: 'context' },
    ]);
  });

  it('accepts an empty context line written without its space', () => {
    const diff = parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n');
    expect(diff.hunks[0].lines.map((l) => l.kind)).toEqual(['context', 'context', 'del', 'add']);
  });
});

describe('rows', () => {
  const diff = parseUnifiedDiff(modified);
  it('stacks lines in one column for a narrow pane', () => {
    const rows = unifiedRows(diff);
    expect(rows[0]).toEqual({ kind: 'hunk', text: '@@ -1,4 +1,5 @@ function a() {' });
    expect(rows[2]).toEqual({ kind: 'line', type: 'del', old: 2, text: 'two' });
    expect(rows).toHaveLength(2 + 7 + 4);
  });
  it('pairs removed lines with the added lines after them side by side', () => {
    const rows = splitRows(diff);
    expect(rows.slice(1, 6)).toEqual([
      {
        kind: 'pair',
        left: { line: 1, text: 'one', kind: 'context' },
        right: { line: 1, text: 'one', kind: 'context' },
      },
      {
        kind: 'pair',
        left: { line: 2, text: 'two', kind: 'del' },
        right: { line: 2, text: 'TWO', kind: 'add' },
      },
      {
        kind: 'pair',
        left: { line: 3, text: 'three', kind: 'del' },
        right: { line: 3, text: 'THREE', kind: 'add' },
      },
      { kind: 'pair', left: null, right: { line: 4, text: 'added', kind: 'add' } },
      {
        kind: 'pair',
        left: { line: 4, text: 'four', kind: 'context' },
        right: { line: 5, text: 'four', kind: 'context' },
      },
    ]);
  });
  it('turns a row selection into the new file lines, or removed lines alone', () => {
    const rows = unifiedRows(diff);
    // "two" (old 2) through "added" (new 4).
    expect(selectionRange(rows, 6, 2)).toEqual({ side: 'new', start: 2, end: 4 });
    expect(selectionRange(rows, 2, 3)).toEqual({ side: 'old', start: 2, end: 3 });
    expect(selectionRange(rows, 0, 0)).toBeNull();
    const pairs = splitRows(diff);
    expect(selectionRange(pairs, 2, 4)).toEqual({ side: 'new', start: 2, end: 4 });
  });
});

describe('long lines and terminal commands', () => {
  it('cuts a line at 4,000 characters and counts the rest', () => {
    expect(clipLine('a'.repeat(MAX_LINE))).toEqual({ text: 'a'.repeat(MAX_LINE), cut: 0 });
    expect(clipLine('가'.repeat(MAX_LINE + 5))).toEqual({ text: '가'.repeat(MAX_LINE), cut: 5 });
  });
  it('quotes paths in the command offered for files it does not show', () => {
    const file = (change: DiffFile['change'], path: string, oldPath: string | null = null) => ({
      path,
      oldPath,
      change,
      added: null,
      removed: null,
      binary: true,
      readable: true,
    });
    expect(terminalCommand({ kind: 'workingTree' }, file('modified', "it's big.bin"))).toBe(
      "git diff HEAD -- 'it'\\''s big.bin'",
    );
    expect(
      terminalCommand({ kind: 'branch', ref: 'refs/heads/main' }, file('renamed', 'b', 'a')),
    ).toBe(`git diff "$(git merge-base HEAD 'main')" -- 'a' 'b'`);
    expect(terminalCommand({ kind: 'workingTree' }, file('untracked', 'n.bin'))).toBe(
      "git diff --no-index -- /dev/null 'n.bin'",
    );
  });
});
