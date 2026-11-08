import { describe, expect, it } from 'vitest';
import { fileTypeOf } from './fileType';

describe('fileTypeOf', () => {
  it.each([
    ['src/app/App.tsx', 'react'],
    ['src/lib/ipc.ts', 'ts'],
    ['scripts/run.mjs', 'js'],
    ['package.json', 'json'],
    ['docs/progress.md', 'markdown'],
    ['src-tauri/src/lib.rs', 'rust'],
    ['Cargo.toml', 'toml'],
    ['.github/workflows/ci.yml', 'yaml'],
    ['scripts/verify.ps1', 'powershell'],
    ['scripts/verify.sh', 'shell'],
    ['src/a.css', 'css'],
    ['logo.PNG', 'image'],
    ['package-lock.lock', 'lock'],
  ])('%s is %s', (path, id) => expect(fileTypeOf(path).id).toBe(id));

  it('a test file reads as a test, whatever it is written in', () => {
    expect(fileTypeOf('src/a.test.ts').id).toBe('test');
    expect(fileTypeOf('tests/ui/git-view.spec.tsx').id).toBe('test');
    expect(fileTypeOf('src/latest.ts').id).toBe('ts');
  });

  it('knows some files by their whole name', () => {
    expect(fileTypeOf('deploy/Dockerfile').id).toBe('docker');
    expect(fileTypeOf('.gitignore').id).toBe('git');
    expect(fileTypeOf('C:\\repo\\.env').id).toBe('config');
  });

  it('anything else is a plain file', () => {
    for (const path of ['notes.xyz', 'README', 'a.', '메모.txt'])
      expect(fileTypeOf(path).id).toBe('file');
  });

  it('every type is drawn one way', () => {
    for (const path of ['a.ts', 'a.tsx', 'a.bin']) {
      const type = fileTypeOf(path);
      expect(Boolean(type.icon) !== Boolean(type.glyph)).toBe(true);
    }
  });
});
