// GE.11: what the prompt hook reports about the branch, in real Bash and Zsh shells on a pty.
// Each step's first report after its command is what the app gets at that prompt. Needs Docker with
// Linux containers and Node 23.6 or later (it imports the hook's TypeScript directly).
// `--timing` also prints how long the report takes per prompt in shallow and deep folders.
import { execFileSync } from 'node:child_process';
import { shellHook } from '../src/features/terminal/shellHook.ts';

const timing = process.argv.includes('--timing');
const hook = shellHook({ guide: false });
const shells = [
  { name: 'Bash 3.2', image: 'bash:3.2', run: 'bash --norc --noprofile -i' },
  { name: 'Bash 4.4', image: 'bash:4.4', run: 'bash --norc --noprofile -i' },
  { name: 'Bash 5.2', image: 'bash:5.2', run: 'bash --norc --noprofile -i' },
  { name: 'Zsh', image: 'bash:5.2', run: 'zsh -f -i', extra: 'zsh' },
  { name: 'Bash 5.2 LANG=C', image: 'bash:5.2', run: 'bash --norc --noprofile -i', lang: 'C' },
  { name: 'Zsh LANG=C', image: 'bash:5.2', run: 'zsh -f -i', extra: 'zsh', lang: 'C' },
];

const korean = 'feature/한글';
// Runs before the shell starts, so the test files never appear in the shell's echo.
const fixtures = String.raw`
git config --global user.email p@example.invalid; git config --global user.name p
git config --global protocol.file.allow always; git config --global advice.detachedHead false
mkdir -p /tmp/ge/out /tmp/ge/repo/src/deep /tmp/ge/lib /tmp/ge/evil/.git /tmp/ge/nonl/.git
mkdir -p /tmp/ge/stub/.git /tmp/ge/dangling
(cd /tmp/ge/repo && git init -q && git symbolic-ref HEAD refs/heads/main)
(cd /tmp/ge/lib && git init -q && git symbolic-ref HEAD refs/heads/libmain && git commit -q --allow-empty -m l)
printf 'ref: refs/heads/a\033]0;pwned\007b\n' > /tmp/ge/evil/.git/HEAD
printf 'ref: refs/heads/nonl' > /tmp/ge/nonl/.git/HEAD
printf 'ref: refs/heads/.invalid\n' > /tmp/ge/stub/.git/HEAD
printf 'gitdir: /tmp/ge/missing\n' > /tmp/ge/dangling/.git
`;

/** The command at one prompt, and what the prompt after it must report. */
const steps = (lang) => [
  ['outside a repository', 'cd /tmp/ge/out', ''],
  ['unborn branch', 'cd /tmp/ge/repo', 'main'],
  ['after the first commit', 'git commit -q --allow-empty -m one', 'main'],
  ['checkout -b', 'git checkout -q -b feature/ge11', 'feature/ge11'],
  ['checkout back', 'git checkout -q main', 'main'],
  // In the C locale these bytes are not printable, and the app falls back on Git's own answer.
  ['non-ASCII branch', `git checkout -q -b ${korean}`, lang === 'C' ? '' : korean],
  ['subfolder', 'cd src/deep', lang === 'C' ? '' : korean],
  ['detached HEAD', 'git checkout -q --detach', /^@[0-9a-f]{7}$/],
  ['linked worktree', 'git worktree add -q -b wt-branch /tmp/ge/wt && cd /tmp/ge/wt', 'wt-branch'],
  [
    'submodule (relative gitdir)',
    'cd /tmp/ge/repo && git checkout -q main && git submodule --quiet add /tmp/ge/lib lib && cd lib && git checkout -q -b in-sub',
    'in-sub',
  ],
  ['hostile HEAD', 'cd /tmp/ge/evil', ''],
  ['HEAD without a final newline', 'cd /tmp/ge/nonl', 'nonl'],
  ['reftable stub HEAD', 'cd /tmp/ge/stub', ''],
  ['dangling .git file', 'cd /tmp/ge/dangling', ''],
];

// Worst case for the walk: no repository anywhere, so every level up to / is checked twice.
const timingLines = String.raw`
d=/tmp/ge/d; i=0; while [ $i -lt 300 ]; do d=$d/dir; i=$((i+1)); done; mkdir -p $d
t() { a=$(date +%s%3N); i=0; while [ $i -lt 200 ]; do __dachsterm_head >/dev/null; i=$((i+1)); done; b=$(date +%s%3N); echo "TIMING $1 $(((b-a)*5))us/prompt depth=$(printf %s "$PWD" | tr -cd / | wc -c)"; }
cd /tmp/ge/out; t shallow
cd $d; t deep
cd /tmp/ge/repo/src/deep; t repo
`
  .trim()
  .split('\n');

function run(shell) {
  const list = steps(shell.lang ?? 'C.UTF-8');
  const lines = list.map(([, command], i) => `${command}; printf 'ST%sP${i}\\n' E`);
  const input = [hook, ...lines, ...(timing ? timingLines : [])].join('\n');
  // Each line waits for the previous prompt, as a person would. stdin ends the pty, so the feeder
  // holds it open until the last line has run.
  const script = `set -e
apk add --no-cache git util-linux coreutils ${shell.extra ?? ''} >/dev/null 2>&1
export LANG=${shell.lang ?? 'C.UTF-8'} LC_ALL=${shell.lang ?? 'C.UTF-8'} HOME=/root TERM=xterm
${fixtures}
cat > /tmp/in <<'END_OF_INPUT'
${input}
END_OF_INPUT
{ sleep 1; while IFS= read -r line; do printf '%s\\n' "$line"; sleep 0.4; done < /tmp/in; sleep ${timing ? 8 : 1}; printf 'exit\\n'; sleep 0.5; } | script -q -c ${JSON.stringify(shell.run)} /dev/null > /tmp/out 2>&1 || true
base64 /tmp/out
`;
  const output = execFileSync('docker', ['run', '--rm', '-i', shell.image, 'sh', '-s'], {
    input: script,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 240_000,
  });
  const text = Buffer.from(output.replace(/\s/g, ''), 'base64').toString('utf8');
  let failures = 0;
  list.forEach(([name, , want], i) => {
    const after = text.indexOf(`STEP${i}\r`);
    const rest = after < 0 ? '' : text.slice(after);
    const prefix = '\x1b]777;DachsTerm;branch;';
    const start = rest.indexOf(prefix);
    const end = start < 0 ? -1 : rest.indexOf('\x07', start);
    const got = end < 0 ? null : rest.slice(start + prefix.length, end);
    const ok = got !== null && (want instanceof RegExp ? want.test(got) : got === want);
    // The prompt mark follows the report, so the app has the branch when it draws the prompt.
    const marked = end >= 0 && rest.indexOf('\x1b]133;A\x07', end) > end;
    if (ok && marked) console.log(`PASS ${shell.name}: ${name} -> "${got}"`);
    else {
      failures++;
      console.log(
        `FAIL ${shell.name}: ${name}: got ${JSON.stringify(got)}, wanted ${String(want)}, prompt mark ${!!marked}`,
      );
    }
  });
  for (const bad of [
    '\x1b]0;pwned',
    'No such file',
    'command not found',
    'parse error',
    'syntax error',
  ])
    if (text.includes(bad)) {
      failures++;
      console.log(`FAIL ${shell.name}: output has ${JSON.stringify(bad)}`);
    }
  for (const [line] of text.matchAll(/TIMING [^\r\n]*/g))
    if (!line.includes('$')) console.log(`${shell.name}: ${line}`);
  return failures;
}

let failures = 0;
for (const shell of shells) failures += run(shell);
if (failures) {
  console.error(`FAIL ${failures} prompt branch checks`);
  process.exit(1);
}
console.log('PASS prompt branch reports in every shell');
