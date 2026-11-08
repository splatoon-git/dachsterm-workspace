// What a file's name says about how to show it. The bytes decide text, image or binary (`file_read`);
// this only picks the language and which extra view a text file offers.

const byExtension: Record<string, string> = {
  bash: 'shell',
  bat: 'bat',
  c: 'c',
  cc: 'cpp',
  cfg: 'ini',
  cjs: 'javascript',
  cmd: 'bat',
  conf: 'ini',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cxx: 'cpp',
  dart: 'dart',
  env: 'ini',
  go: 'go',
  graphql: 'graphql',
  h: 'cpp',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  lua: 'lua',
  markdown: 'markdown',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  pl: 'perl',
  ps1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  r: 'r',
  rb: 'ruby',
  rs: 'rust',
  scala: 'scala',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  svg: 'xml',
  swift: 'swift',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
};

const byName: Record<string, string> = {
  '.bash_profile': 'shell',
  '.bashrc': 'shell',
  '.profile': 'shell',
  '.zprofile': 'shell',
  '.zshrc': 'shell',
  containerfile: 'dockerfile',
  dockerfile: 'dockerfile',
};

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** The editor's language id, or 'plaintext' for anything it would only guess at. */
export function languageOf(name: string) {
  const lower = name.toLowerCase();
  return byName[lower] ?? byExtension[extensionOf(lower)] ?? 'plaintext';
}

export const isMarkdown = (name: string) => languageOf(name) === 'markdown';
export const isJson = (name: string) => languageOf(name) === 'json';
