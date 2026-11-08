// Measures the editor wrapper in real WebView2 under the app's CSP, using a build whose page is
// tests/editor-trial. Composition here goes through CDP, so it exercises the editor's handling of
// composition events but not an OS IME; real IMEs are checked by hand with --manual.
//   node scripts/test-editor-native.mjs [--reuse-build] [--manual]
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';

const args = new Set(process.argv.slice(2));
// Absolute: Cargo runs in src-tauri and would resolve a relative directory from there.
const targetDirectory = path.resolve('target/editor-trial');
const executable = path.join(targetDirectory, 'debug', 'dachsterm.exe');
const output = 'test-results-native/editor-trial';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!args.has('--reuse-build')) {
  // A target directory of its own: other native scripts must not run this page by accident.
  const build = spawnSync(
    'npm run tauri -- build --debug --no-bundle --config tests/editor-trial/tauri.trial.json',
    {
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
    },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
}

await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-editor-'));
const { app, page, version, stop } = await launchNativeApp({
  executable,
  directory,
  visible: args.has('--manual'),
});

if (args.has('--manual')) {
  console.log('Trial window is open. Close it to finish.');
  await new Promise((resolve) => app.once('exit', resolve));
  // The app is gone, so its CDP connection cannot be closed politely.
  process.exit(0);
}

const checks = [];
const report = { webview: version, measurements: {}, checks };
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(
    `${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
  );
}
const consoleProblems = [];
page.on('console', (message) => {
  const text = message.text();
  if (message.type() === 'error' || /web worker|falling back/i.test(text))
    consoleProblems.push(`${message.type()}: ${text}`);
});
page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));
const cdp = await page.context().newCDPSession(page);
// The window need not be in front while the script runs.
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

const trial = (fn, arg) => page.evaluate(fn, arg);
const value = () => trial(() => window.__editorTrial.handle.getValue());
async function show(view) {
  await trial((next) => window.__editorTrial.show(next), view);
  await page.waitForFunction(() => window.__editorTrial.handle, undefined, { timeout: 30000 });
  await page.locator('.monaco-editor').first().waitFor();
  await trial(() => window.__editorTrial.handle.focus());
}
const emptyDocument = { kind: 'code', value: '', language: 'plaintext' };

let compositionDelay = 25;
async function compose(frames) {
  for (const text of frames) {
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    await sleep(compositionDelay);
  }
}
const commit = (text) => cdp.send('Input.insertText', { text });
async function syllable(frames) {
  await compose(frames);
  await commit(frames.at(-1));
}

const hangulPhrase = '한글 값이 아녕';
async function typeHangulPhrase() {
  await show(emptyDocument);
  await syllable(['ㅎ', '하', '한']);
  await syllable(['ㄱ', '그', '글']);
  await commit(' ');
  await syllable(['ㄱ', '가', '갑', '값']);
  await syllable(['ㅇ', '이']);
  await commit(' ');
  // A final consonant that becomes the next syllable's first: 안 + ㅕ turns into 아 + 녀.
  await compose(['ㅇ', '아', '안', '아']);
  await commit('아');
  await syllable(['녀', '녕']);
  return value();
}

/** Composition is timing-sensitive, so one pass proves little. */
async function compositionRepeat(delay, rounds) {
  compositionDelay = delay;
  const wrong = [];
  for (let round = 0; round < rounds; round++) {
    const typed = await typeHangulPhrase();
    if (typed !== hangulPhrase) wrong.push({ round, typed });
  }
  compositionDelay = 25;
  report.measurements[`조합 반복 ${delay}ms`] = { rounds, wrong };
  check(`합성 조합 반복 ${delay}ms: ${rounds}회 모두 일치`, !wrong.length, wrong.slice(0, 8));
}

/** The first typing after the page and its editor chunks have just loaded. */
async function compositionAfterLoad(rounds) {
  const wrong = [];
  for (let round = 0; round < rounds; round++) {
    await page.reload();
    await page.waitForFunction(() => window.__editorTrial, undefined, { timeout: 30000 });
    const typed = await typeHangulPhrase();
    if (typed !== hangulPhrase) wrong.push({ round, typed });
  }
  report.measurements['조합 새로 로드 직후'] = { rounds, wrong };
  check(`합성 조합 새로 로드 직후: ${rounds}회 모두 일치`, !wrong.length, wrong.slice(0, 8));
}

async function compositionChecks() {
  const name = (label) => `합성 조합: ${label}`;

  const typed = await typeHangulPhrase();
  check(name('받침과 받침 넘어가기'), typed === hangulPhrase, typed);

  await show(emptyDocument);
  await commit('한글abc');
  await sleep(100);
  const caret = await trial(() => {
    const cursor = document.querySelector('.cursor');
    const line = document.querySelector('.view-line');
    const range = document.createRange();
    range.selectNodeContents(line);
    return {
      cursor: cursor.getBoundingClientRect().left,
      textEnd: range.getBoundingClientRect().right,
    };
  });
  check(name('한글 뒤 커서 위치'), Math.abs(caret.cursor - caret.textEnd) <= 2, caret);

  await show(emptyDocument);
  await commit('가나');
  await compose(['ㄷ', '다']);
  const during = await value();
  await page.keyboard.press('ArrowLeft');
  await commit('다');
  await sleep(50);
  const moved = await value();
  report.measurements['조합 중 왼쪽 화살표'] = { during, after: moved };
  check(
    name('조합 중 커서 이동에서 글자 손실·중복 없음'),
    ['가', '나', '다'].every((letter) => moved.split(letter).length === 2),
    moved,
  );

  // The order an IME reports it: the syllable is committed first, then the key arrives.
  await show(emptyDocument);
  await commit('가나');
  await syllable(['ㄷ', '다']);
  await page.keyboard.press('ArrowLeft');
  await syllable(['ㄹ', '라']);
  check(name('확정 뒤 커서 이동'), (await value()) === '가나라다', await value());

  await show(emptyDocument);
  const savesBefore = await trial(() => window.__editorTrial.saves.length);
  await commit('저장');
  await compose(['ㅎ', '하']);
  await page.keyboard.press('Control+S');
  await commit('하');
  await sleep(50);
  const saved = await trial((before) => window.__editorTrial.saves.slice(before), savesBefore);
  const afterSave = await value();
  check(name('조합 중 저장에서 글자 손실·중복 없음'), afterSave === '저장하', afterSave);
  report.measurements['조합 중 저장'] = { saved, afterSave };
  await page.keyboard.press('Control+S');
  const finalSaves = await trial(() => window.__editorTrial.saves.at(-1));
  check(name('확정 뒤 저장은 전체 글자를 넘김'), finalSaves === '저장하', finalSaves);

  await show(emptyDocument);
  await compose(['か', 'かん', 'かんじ', '漢字']);
  await commit('漢字');
  await compose(['に', 'にほ', 'にほん', '日本']);
  await commit('日本');
  check(name('일본어 변환'), (await value()) === '漢字日本', await value());

  await show(emptyDocument);
  await compose(['n', 'ni', "ni'h", "ni'hao"]);
  await commit('你好');
  await compose(['s', 'sh', 'shi', "shi'j", "shi'jie"]);
  await commit('世界');
  check(name('중국어 병음'), (await value()) === '你好世界', await value());

  await show({
    kind: 'diff',
    original: 'a\n',
    modified: 'a\n',
    language: 'plaintext',
    layout: 'split',
  });
  await syllable(['ㅎ', '하', '한']);
  check(name('diff 수정 쪽 조합'), (await value()).includes('한'), await value());
}

async function workerChecks() {
  async function squiggle(language, text, label) {
    await show({ kind: 'code', value: text, language });
    const found = await page
      .locator('.squiggly-error')
      .first()
      .waitFor({ timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    check(`웹 워커 ${label} 진단이 표시됨`, found);
  }
  await squiggle('typescript', 'const a: number = "text";\n', 'TypeScript');
  await squiggle('json', '{ "a": 1, }\n', 'JSON');
  await squiggle('css', 'a { color: ; }\n', 'CSS');
  await show({ kind: 'code', value: '<div><span></span></div>\n', language: 'html' });
  await sleep(3000);
  const seen = await trial(() => window.__editorTrial.workers);
  report.measurements.workers = seen;
  for (const label of ['ts.worker', 'json.worker', 'css.worker', 'html.worker', 'editor.worker'])
    check(
      `웹 워커 ${label} 시작`,
      seen.some((w) => w.url.includes(label)),
    );
  check(
    '웹 워커 시작 오류 없음',
    seen.every((w) => !w.errors.length),
    seen.flatMap((w) => w.errors),
  );
}

/** Frame times while `action` runs. */
async function frameStats(action) {
  await trial(() => {
    const frames = [];
    let last = performance.now();
    window.__frames = frames;
    window.__framesOn = true;
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (window.__framesOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  const frames = await trial(() => {
    window.__framesOn = false;
    return window.__frames;
  });
  const sorted = [...frames].sort((a, b) => a - b);
  const pick = (q) => Math.round(sorted[Math.floor((sorted.length - 1) * q)]);
  return { count: frames.length, p50: pick(0.5), p95: pick(0.95), max: pick(1) };
}

async function bigFileChecks(language) {
  const started = await trial(
    ({ language: next }) => {
      const text = Array.from(
        { length: 100_000 },
        (_, index) => `const line${index + 1} = ${index}; // 한글 주석 ${index + 1}`,
      ).join('\n');
      const startedAt = performance.now();
      window.__editorTrial.show({ kind: 'code', value: text, language: next });
      return startedAt;
    },
    { language },
  );
  await page.waitForFunction(() => window.__editorTrial.handle, undefined, { timeout: 60000 });
  await page.locator('.view-line', { hasText: 'line1 ' }).first().waitFor({ timeout: 60000 });
  const openMs = Math.round((await trial(() => performance.now())) - started);
  const box = await page.locator('.monaco-editor').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const firstLine = () =>
    trial(() =>
      Math.min(
        ...[...document.querySelectorAll('.margin-view-overlays .line-numbers')]
          .map((e) => Number(e.textContent))
          .filter((line) => line > 0),
      ),
    );
  const idle = await frameStats(() => sleep(1000));
  await trial(() => {
    addEventListener(
      'wheel',
      (e) => (window.__wheel = { deltaY: e.deltaY, wheelDeltaY: e.wheelDeltaY, mode: e.deltaMode }),
      { once: true, capture: true },
    );
  });
  const wheelLines = [await firstLine()];
  const wheel = await frameStats(async () => {
    for (let i = 1; i <= 90; i++) {
      await page.mouse.wheel(0, 2400);
      await sleep(16);
      if (i % 30 === 0) wheelLines.push(await firstLine());
    }
    await sleep(100);
  });
  const lowest = wheelLines.at(-1);
  const wheelEvent = await trial(() => window.__wheel);
  const slider = await page.locator('.scrollbar.vertical .slider').first().boundingBox();
  const track = await page.locator('.scrollbar.vertical').first().boundingBox();
  const drag = await frameStats(async () => {
    await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2);
    await page.mouse.down();
    await page.mouse.move(slider.x + slider.width / 2, track.y + track.height / 2, { steps: 40 });
    await page.mouse.up();
    await sleep(200);
  });
  const afterDrag = await firstLine();
  await page.keyboard.press('Control+End');
  const reachedEnd = await page
    .locator('.view-line', { hasText: 'line100000 ' })
    .first()
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  await page.keyboard.press('Control+Home');
  const measured = {
    openMs,
    idleFrames: idle,
    wheelFrames: wheel,
    dragFrames: drag,
    wheelEvent,
    firstLineEvery30Wheels: wheelLines,
    firstLineAfterDrag: afterDrag,
    heapMiB: await trial(() => Math.round(performance.memory.usedJSHeapSize / 1048576)),
  };
  report.measurements[`10만 줄 ${language}`] = measured;
  check(
    `10만 줄 ${language}: 휠마다 아래로 이동`,
    lowest >= 90 && wheelLines.every((line, i) => !i || line > wheelLines[i - 1]),
    measured,
  );
  check(
    `10만 줄 ${language}: 스크롤바 끌기로 중간에 도달`,
    afterDrag > 40000 && afterDrag < 60000,
    afterDrag,
  );
  check(`10만 줄 ${language}: 마지막 줄에 도달`, reachedEnd);
  await page.screenshot({ path: `${output}/big-${language}.png` });
}

async function themeChecks(view, label) {
  await show(view);
  const list = await trial(() => window.__editorTrial.themes);
  const results = [];
  for (const id of list) {
    await trial((next) => window.__editorTrial.setTheme(next), id);
    await page.waitForFunction((next) => document.documentElement.dataset.theme === next, id);
    await sleep(120);
    results.push(
      await trial((theme) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--terminal-background)';
        probe.style.color = 'var(--terminal-magenta)';
        document.body.append(probe);
        const expected = getComputedStyle(probe);
        const background = getComputedStyle(
          document.querySelector('.monaco-editor .monaco-editor-background'),
        ).backgroundColor;
        const keyword = [...document.querySelectorAll('.view-line span span')].find(
          (element) => element.textContent.trim() === 'const',
        );
        const result = {
          theme,
          backgroundMatches: background === expected.backgroundColor,
          keywordMatches: keyword ? getComputedStyle(keyword).color === expected.color : null,
        };
        probe.remove();
        return result;
      }, id),
    );
    await page.screenshot({ path: `${output}/${label}-${id}.png` });
  }
  await trial((first) => window.__editorTrial.setTheme(first), list[0]);
  report.measurements[`테마 ${label}`] = results;
  check(
    `테마 전환 ${label}: ${list.length}개 배경이 토큰과 일치`,
    results.every((r) => r.backgroundMatches),
    results.filter((r) => !r.backgroundMatches).map((r) => r.theme),
  );
  if (view.kind === 'code')
    check(
      `테마 전환 ${label}: 키워드 색이 토큰과 일치`,
      results.every((r) => r.keywordMatches),
      results.filter((r) => !r.keywordMatches).map((r) => r.theme),
    );
}

async function diffChecks() {
  const original = '첫 줄은 그대로\n둘째 줄을 바꿉니다\n셋째 줄은 그대로\n';
  const modified =
    '첫 줄은 그대로\n둘째 줄이 바뀌었습니다\n셋째 줄은 그대로\n넷째 줄을 더했습니다\n';
  await show({ kind: 'diff', original, modified, language: 'plaintext', layout: 'split' });
  await page.locator('.char-insert, .line-insert').first().waitFor({ timeout: 30000 });
  const split = await trial(() => ({
    original: document.querySelector('.editor.original')?.getBoundingClientRect().width ?? 0,
    modified: document.querySelector('.editor.modified')?.getBoundingClientRect().width ?? 0,
    inserts: document.querySelectorAll('.char-insert, .line-insert').length,
    deletes: document.querySelectorAll('.char-delete, .line-delete').length,
  }));
  report.measurements['diff 좌우'] = split;
  check(
    'diff 좌우: 두 쪽이 모두 보이고 변경 표시',
    split.original > 100 && split.modified > 100 && split.inserts && split.deletes,
    split,
  );
  await page.screenshot({ path: `${output}/diff-split.png` });

  await show({ kind: 'diff', original, modified, language: 'plaintext', layout: 'inline' });
  await page.locator('.char-insert, .line-insert').first().waitFor({ timeout: 30000 });
  await sleep(200);
  const inline = await trial(() => ({
    original: document.querySelector('.editor.original')?.getBoundingClientRect().width ?? 0,
    modified: document.querySelector('.editor.modified')?.getBoundingClientRect().width ?? 0,
    deletedShown: [...document.querySelectorAll('.view-zones *')].some((e) =>
      e.textContent.includes('바꿉니다'),
    ),
  }));
  report.measurements['diff 한 줄'] = inline;
  check(
    'diff 한 줄: 수정 쪽 하나에 삭제 줄을 끼워 표시',
    // The original side keeps only its line-number gutter.
    inline.original < 60 && inline.modified > 100 && inline.deletedShown,
    inline,
  );
  await page.screenshot({ path: `${output}/diff-inline.png` });
}

try {
  await page.waitForFunction(() => window.__editorTrial, undefined, { timeout: 30000 });
  const entry = await readFile('test-results-native/editor-trial-dist/index.html', 'utf8');
  check('첫 화면이 편집기 청크를 미리 불러오지 않음', !/MonacoEditors|editor\.api/.test(entry));

  await show(emptyDocument);
  const input = await trial(() => ({
    nativeEditContext: document.querySelectorAll('.native-edit-context').length,
    textarea: document.querySelectorAll('textarea.inputarea').length,
  }));
  report.measurements.inputPath = input;
  check('입력 경로가 WKWebView와 같은 textarea', !input.nativeEditContext && input.textarea, input);
  await compositionChecks();
  await compositionRepeat(25, 40);
  await compositionRepeat(60, 20);
  await compositionAfterLoad(20);
  await page.locator('.monaco-editor').first().waitFor();

  await workerChecks();
  await diffChecks();
  await themeChecks({ kind: 'code', value: 'const a = 1;\n', language: 'typescript' }, 'code');
  await themeChecks(
    {
      kind: 'diff',
      original: 'const a = 1;\n',
      modified: 'const a = 2;\n',
      language: 'typescript',
      layout: 'split',
    },
    'diff',
  );
  await bigFileChecks('plaintext');
  await bigFileChecks('typescript');

  const fonts = await trial(() => document.fonts.check('16px codicon'));
  check('아이콘 글꼴 로딩', fonts);
  check(
    'CSP 위반 없음',
    !(await trial(() => window.__editorTrial.cspViolations.length)),
    await trial(() => window.__editorTrial.cspViolations),
  );
  check('콘솔 오류·워커 대체 없음', !consoleProblems.length, consoleProblems.slice(0, 10));
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await stop();
}

const failed = checks.filter((item) => !item.pass);
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed. Report: ${output}/report.json`,
);
process.exit(failed.length ? 1 : 0);
