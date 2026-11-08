import type { IconName } from './Icon';

/** The theme color family of a file's icon. `FileTypeIcon` turns it into a token. */
export type FileTone = 'info' | 'warning' | 'success' | 'error' | 'accent' | 'muted';

/** Drawn as an icon, or as up to two letters where a letter says it better. */
export type FileType = { id: string; tone: FileTone } & (
  { icon: IconName; glyph?: undefined } | { glyph: string; icon?: undefined }
);

const glyph = (id: string, text: string, tone: FileTone): FileType => ({ id, glyph: text, tone });
const icon = (id: string, name: IconName, tone: FileTone): FileType => ({ id, icon: name, tone });

const byName: Record<string, FileType> = {
  dockerfile: glyph('docker', 'D', 'info'),
  makefile: glyph('make', 'M', 'muted'),
  license: glyph('license', '©', 'warning'),
  '.gitignore': icon('git', 'branch', 'error'),
  '.gitattributes': icon('git', 'branch', 'error'),
  '.gitmodules': icon('git', 'branch', 'error'),
  '.env': icon('config', 'settings', 'warning'),
};

const groups: [FileType, string[]][] = [
  [glyph('ts', 'TS', 'info'), ['ts', 'mts', 'cts']],
  [glyph('js', 'JS', 'warning'), ['js', 'mjs', 'cjs']],
  [icon('react', 'react', 'info'), ['tsx', 'jsx']],
  [icon('json', 'snippet', 'warning'), ['json', 'jsonc', 'json5']],
  [glyph('markdown', 'M↓', 'info'), ['md', 'mdx', 'markdown']],
  [icon('rust', 'gear', 'error'), ['rs']],
  [glyph('toml', 'T', 'error'), ['toml']],
  [glyph('yaml', 'Y', 'accent'), ['yml', 'yaml']],
  [icon('config', 'settings', 'muted'), ['ini', 'cfg', 'conf', 'env', 'properties']],
  [glyph('css', '#', 'accent'), ['css', 'scss', 'sass', 'less']],
  [glyph('html', '<>', 'error'), ['html', 'htm', 'vue', 'svelte']],
  [glyph('xml', '<>', 'muted'), ['xml', 'plist']],
  [icon('powershell', 'terminal', 'info'), ['ps1', 'psm1', 'psd1']],
  [icon('shell', 'terminal', 'success'), ['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd']],
  [glyph('python', 'PY', 'info'), ['py', 'pyi']],
  [glyph('go', 'GO', 'info'), ['go']],
  [glyph('java', 'J', 'error'), ['java', 'jar']],
  [glyph('kotlin', 'K', 'accent'), ['kt', 'kts']],
  [glyph('c', 'C', 'info'), ['c', 'h']],
  [glyph('cpp', 'C+', 'info'), ['cpp', 'cc', 'cxx', 'hpp']],
  [glyph('csharp', 'C#', 'success'), ['cs']],
  [glyph('ruby', 'RB', 'error'), ['rb']],
  [glyph('php', 'P', 'accent'), ['php']],
  [glyph('swift', 'S', 'warning'), ['swift']],
  [glyph('sql', 'DB', 'accent'), ['sql', 'sqlite', 'sqlite3', 'db']],
  [icon('image', 'image', 'accent'), ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'icns']],
  [icon('lock', 'lock', 'muted'), ['lock']],
  [icon('archive', 'archive', 'warning'), ['zip', 'gz', 'tar', 'tgz', '7z', 'rar', 'xz']],
];

const byExtension = new Map(
  groups.flatMap(([type, extensions]) => extensions.map((end) => [end, type] as const)),
);
const test = icon('test', 'flask', 'accent');
const plain = icon('file', 'file', 'muted');

/** A test file reads as a test first: `a.test.ts` is more that than TypeScript. */
export function fileTypeOf(path: string): FileType {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  const named = byName[name];
  if (named) return named;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return test;
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && byExtension.get(name.slice(dot + 1))) || plain;
}
