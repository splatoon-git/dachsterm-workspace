// Command boundaries (DX.9), Git status (DX.5), change review (DX.6), the agent list (DX.8) and
// starting an agent (DX.7) in the real app against the OpenSSH fixture. Runs from the first SSH tab,
// whose Bash 5.2 has the session hook.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  chooseProfileMenu,
  chooseSectionMenu,
  chooseTabMenu,
  openSettings,
  showSidebarView,
} from './native-workspace.mjs';

const repo = '/tmp/dachsterm-git-ui';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function verifyDeveloperWorkflow({
  page,
  pane,
  docker,
  probe,
  command,
  screenshots,
  connectNewTab,
  invoke,
  setStage,
}) {
  const container = probe('CONTAINER');
  const shell = (script) => docker(['exec', '-u', 'probe', container, 'sh', '-c', script]).trim();
  const viewport = () => pane().locator('.xterm-accessibility-tree').innerText();
  const failed = () => pane().locator('.command-failed');

  setStage('DX.9 failed command marks');
  await command('cd /tmp');
  await expect.poll(() => failed().count()).toBe(0);
  await command('false');
  await expect(failed()).toHaveCount(1);
  await expect(failed().first()).toHaveAttribute('title', '실패한 명령 · 종료 코드 1');
  // An empty line repeats the last code at its prompt, and is not a failed command.
  await pane().locator('.xterm-helper-textarea').press('Enter');
  await command('true');
  await command('(exit 3)');
  await expect(failed()).toHaveCount(2);
  await expect(failed().last()).toHaveAttribute('title', '실패한 명령 · 종료 코드 3');
  console.log('PASS native failed commands marked with their code, empty line and success not');

  setStage('DX.9 prompt jump');
  await command("printf 'JUMP_TOP\\n'; seq 1 200");
  await expect.poll(viewport).toContain('200');
  assert(!(await viewport()).includes('JUMP_TOP'));
  await pane().locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+ArrowUp');
  await expect.poll(viewport).toContain('JUMP_TOP');
  await page.keyboard.press('Control+Shift+ArrowDown');
  await expect.poll(viewport).not.toContain('JUMP_TOP');
  console.log('PASS native Ctrl+Shift+Up/Down moves between prompts');

  setStage('DX.5 Git status');
  const hook = `${repo}-fsmonitor`;
  shell(
    `rm -rf ${repo} ${hook}*; mkdir -p ${repo}/src && cd ${repo} && git init -q && ` +
      `git checkout -q -b main && git config user.email p@example.invalid && ` +
      `git config user.name p && echo a > a.txt && echo s > src/s.txt && git add . && ` +
      `git commit -qm init && echo b >> a.txt && echo s >> src/s.txt && echo n > new.txt && ` +
      `printf '#!/bin/sh\\ntouch "$0.ran"\\n' > ${hook} && chmod +x ${hook} && ` +
      `git config core.fsmonitor ${hook}`,
  );
  const status = page.locator('.status-bar .status-git');
  let failure = null;
  const ran = () => shell(`test -e ${hook}.ran && echo ran || echo none`) === 'ran';
  try {
    await command(`cd ${repo}`);
    await expect(status).toHaveText('main ●3', { timeout: 15000 });
    await expect(status).toHaveAttribute('aria-label', 'Git main, 변경 3개. Git 보기 열기');
    await expect(status).toHaveAttribute('title', /업스트림 없음/);
    const tab = page.locator('.tab-strip .session-tab.selected [role="tab"]').first();
    await expect(tab).toHaveAttribute('aria-label', /Git main, 변경 3개/);
    await expect(tab).toHaveAttribute('title', /저장소 \/tmp\/dachsterm-git-ui/);
    await expect(status).toHaveAttribute('title', /수정 2 · 추적 안 함 1/);
    assert(!ran(), 'the app ran the repository fsmonitor program');
    // A change made in the shell shows at its next prompt, without polling. The user's own
    // `git add` runs the fsmonitor program, so its trace is removed before the next app query.
    await sleep(5200);
    await command(`git add new.txt; rm -f ${hook}.ran`);
    await expect(status).toHaveAttribute('title', /수정 2 · 추가 1/);
    await showSidebarView(page, '파일');
    const row = (name) =>
      page.locator('#file-sidebar .file-tree-row').filter({ hasText: new RegExp(`^${name}`) });
    await expect(row('a.txt').locator('.file-git-mark')).toHaveAttribute('data-mark', 'M');
    await expect(row('new.txt').locator('.file-git-mark')).toHaveAttribute('data-mark', 'A');
    await expect(row('src').locator('.file-git-mark')).toHaveAttribute('data-mark', 'folder');
    assert(!ran(), 'the app ran the repository fsmonitor program');
    console.log('PASS native Git status bar, tab name and tooltip, tree marks, fsmonitor not run');

    setStage('GE.7 Git view');
    await showSidebarView(page, 'Git');
    const gitView = page.locator('#git-sidebar');
    await expect(gitView.locator('.git-view-branch')).toContainText('main', { timeout: 15000 });
    const groupRows = (name) =>
      gitView.getByRole('region', { name, exact: true }).locator('.git-row-name');
    await expect(groupRows('스테이지됨')).toHaveText(['new.txt']);
    await expect(groupRows('변경')).toHaveText(['a.txt', 's.txt']);
    await expect(gitView.locator('.git-row-folder')).toHaveText(['src']);
    assert(!ran(), 'the Git view ran the repository fsmonitor program');
    await showSidebarView(page, '파일');
    console.log('PASS native Git view: staged and changed files of the SSH tab, fsmonitor not run');

    setStage('GE.11 prompt branch');
    await showSidebarView(page, '연결');
    await verifyPromptBranch({ page, pane, command, status, shell, repo, setStage });

    setStage('DX.6 change review and prompt');
    const reviewTab = page.locator('.tab-strip [role="tab"]').filter({ hasText: /^변경 검토 · / });
    const groupsBefore = await page.locator('.tab-strip').count();
    let reviewOpen = false;
    try {
      await pane().locator('.xterm-helper-textarea').focus();
      await page.keyboard.press('Control+Shift+G');
      await expect(reviewTab).toHaveCount(1);
      reviewOpen = true;
      // It opens beside its terminal; zoomed, the file list has room to show as a list.
      await expect(page.locator('.tab-strip')).toHaveCount(groupsBefore + 1);
      await page.keyboard.press('Control+Shift+Enter');
      const review = page.locator('.review-pane');
      await expect(
        review.getByRole('list', { name: '변경 파일' }).locator('.review-path'),
      ).toHaveText(['a.txt', 'new.txt', 'src/s.txt'], { timeout: 15000 });
      await expect(review.locator('.review-mark')).toHaveText(['M', 'A', 'M']);
      await review.getByRole('button', { name: '새 2행 선택', exact: true }).click();
      await review.getByRole('textbox', { name: '의견' }).fill('대문자로 바꾸기');
      await review.getByRole('textbox', { name: '의견' }).press('Enter');
      await page.keyboard.press('Control+Shift+Enter');
      // The shell beside the review. Echo is off in this run, so the pasted text never shows;
      // what shows is whether the line ran.
      const shellScreen = page.locator(
        '.pane-cell:not([hidden]) .terminal-pane:not([hidden]) .xterm-accessibility-tree',
      );
      await expect(shellScreen).toHaveCount(1);
      const errors = async () =>
        ((await shellScreen.innerText()).match(/a\.txt:2: command not found/g) ?? []).length;
      assert.equal(await errors(), 0);
      await review.getByRole('button', { name: /^프롬프트로 보내기 · / }).click();
      await expect(review.getByRole('status')).toHaveText(
        '프롬프트에 넣었습니다. 내용을 확인한 뒤 Enter를 누르세요.',
      );
      await sleep(1500);
      // Had the app pressed Enter, bash would already have refused the line.
      assert.equal(await errors(), 0, 'the comment ran before Enter');
      // The text waits at the prompt: the user's own Enter runs exactly that line.
      await expect(pane().locator('.xterm-helper-textarea')).toBeFocused();
      await pane().locator('.xterm-helper-textarea').press('Enter');
      await expect.poll(errors).toBe(1);
      assert(!ran(), 'the review ran the repository fsmonitor program');
      await reviewTab.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '탭 닫기', exact: true }).click();
      await expect(reviewTab).toHaveCount(0);
      reviewOpen = false;
      await expect(page.locator('.tab-strip')).toHaveCount(groupsBefore);
      console.log(
        'PASS native change review: list, line comment pasted without Enter, fsmonitor not run',
      );
    } catch (error) {
      await page.screenshot({ path: path.join(screenshots, 'review-failure.png') });
      throw error;
    } finally {
      // A failed check must not leave the review focused, where the cleanup has no terminal.
      if (reviewOpen) {
        await page.keyboard.press('Escape');
        await reviewTab.click({ button: 'right' }).catch(() => {});
        await page
          .getByRole('menuitem', { name: '탭 닫기', exact: true })
          .click()
          .catch(() => {});
      }
    }

    setStage('DX.5 quiet outside a repository and without Git');
    await command('cd /tmp');
    await expect(status).toHaveCount(0, { timeout: 15000 });
    docker(['exec', container, 'mv', '/usr/bin/git', '/usr/bin/git.hidden']);
    try {
      await command(`cd ${repo}/src`);
      await sleep(2000);
      await expect(status).toHaveCount(0);
      await expect(page.locator('.status-bar .status-message')).not.toContainText('Git');
    } finally {
      docker(['exec', container, 'mv', '/usr/bin/git.hidden', '/usr/bin/git']);
    }
    console.log('PASS native Git status stays hidden outside a repository and without Git');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    shell(`rm -rf ${repo} ${hook} ${hook}.ran`);
    // After a failure the cleanup may fail too; the first error is the one to report.
    const cleanup = async () => {
      await command('cd /tmp');
      await showSidebarView(page, '연결');
    };
    if (failure) await cleanup().catch(() => {});
    else await cleanup();
  }
  await verifyGitWrite({ page, pane, command, shell, setStage });
  await verifyAgentList({ page, pane, command, connectNewTab, invoke, setStage });
}

/** GE.9: each action of the Git view in the real app, read back with the server's own git. */
async function verifyGitWrite({ page, pane, command, shell, setStage }) {
  const work = '/tmp/dachsterm-git-write';
  const remote = `${work}-remote.git`;
  const git = (args) => shell(`git -C ${work} ${args}`);
  const view = page.locator('#git-sidebar');
  const rows = (name) => view.getByRole('region', { name, exact: true }).locator('.git-row-name');
  const row = (name, file) =>
    view.getByRole('region', { name, exact: true }).locator('.git-row').filter({ hasText: file });
  const menu = (name) => page.getByRole('menuitem', { name, exact: true }).click();
  const more = async (item) => {
    await view.getByRole('button', { name: 'Git 더 보기' }).click();
    await menu(item);
  };
  const dialog = (name) => page.getByRole('dialog', { name, exact: true });
  const error = view.locator('.git-view-error');
  const textarea = pane().locator('.xterm-helper-textarea');
  shell(
    `rm -rf ${work} ${remote}; mkdir -p ${work} && git init -q --bare ${remote} && cd ${work} && ` +
      `git init -q && git checkout -q -b main && git config user.email p@example.invalid && ` +
      `git config user.name p && echo a > edit.txt && echo a > gone.txt && git add . && ` +
      `git commit -qm init && git remote add origin ${remote} && git push -q -u origin main && ` +
      `echo b > edit.txt && echo b > gone.txt && echo n > 'new [1].txt' && echo n > 'new 1.txt'`,
  );
  try {
    setStage('GE.9 stage and commit');
    await command(`cd ${work}`);
    await showSidebarView(page, 'Git');
    await expect(rows('변경')).toHaveText(['edit.txt', 'gone.txt'], { timeout: 15000 });
    await row('변경', 'edit.txt').click({ button: 'right' });
    await menu('스테이지');
    await expect(rows('스테이지됨')).toHaveText(['edit.txt']);
    assert.equal(git('diff --cached --name-only'), 'edit.txt');
    await row('스테이지됨', 'edit.txt').click({ button: 'right' });
    await menu('스테이지 취소');
    await expect(rows('스테이지됨')).toHaveCount(0);
    await row('변경', 'edit.txt').click({ button: 'right' });
    await menu('스테이지');
    await expect(rows('스테이지됨')).toHaveText(['edit.txt']);
    const message = view.getByRole('textbox', { name: '커밋 메시지' });
    await message.fill('첫 커밋 ge9');
    await message.press('Control+Enter');
    await expect(rows('스테이지됨')).toHaveCount(0);
    await expect(message).toHaveValue('');
    assert.equal(git('log -1 --format=%s'), '첫 커밋 ge9');
    await message.fill('고친 커밋 ge9');
    await view.getByRole('button', { name: '커밋 더 보기' }).click();
    await menu('이전 커밋 고치기 (--amend)');
    await expect(message).toHaveValue('');
    assert.equal(git('log -1 --format=%s'), '고친 커밋 ge9');
    assert.equal(git('rev-list --count HEAD'), '2');
    console.log('PASS native Git view stage, unstage, commit and amend on the SSH tab');

    setStage('GE.9 discard');
    await row('변경', 'gone.txt').click({ button: 'right' });
    await menu('변경 버리기…');
    const discard = dialog('변경 버리기');
    await expect(discard.getByRole('list', { name: '대상 파일' })).toHaveText('gone.txt');
    await expect(discard.getByRole('button', { name: '취소', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(discard).toHaveCount(0);
    assert.equal(shell(`cat ${work}/gone.txt`), 'b');
    await row('변경', 'gone.txt').click({ button: 'right' });
    await menu('변경 버리기…');
    await discard.getByRole('button', { name: '변경 버리기', exact: true }).click();
    await expect(rows('변경')).toHaveCount(0);
    assert.equal(shell(`cat ${work}/gone.txt`), 'a');
    await row('추적 안 함', 'new [1].txt').click({ button: 'right' });
    await menu('파일 삭제…');
    await dialog('추적 안 함 파일 삭제').getByRole('button', { name: '삭제', exact: true }).click();
    await expect(rows('추적 안 함')).toHaveText(['new 1.txt']);
    assert.equal(shell(`ls ${work}/new*`), `${work}/new 1.txt`);
    console.log('PASS native discard asks with Cancel chosen, and a name is not a pattern');

    setStage('GE.9 branch, tag and stash');
    await more('새 브랜치…');
    await dialog('새 브랜치').getByRole('textbox', { name: '이름' }).fill('ge9/작업');
    await dialog('새 브랜치').getByRole('button', { name: '만들고 전환' }).click();
    await expect(view.locator('.git-view-branch')).toContainText('ge9/작업', { timeout: 15000 });
    await more('브랜치 전환…');
    await dialog('브랜치 전환').getByRole('button', { name: 'main', exact: true }).click();
    await expect(view.locator('.git-view-branch')).toContainText('main', { timeout: 15000 });
    assert.equal(git('symbolic-ref --short HEAD'), 'main');
    await more('태그…');
    await dialog('태그').getByRole('textbox', { name: '이름' }).fill('v9');
    await dialog('태그').getByRole('button', { name: '태그 만들기' }).click();
    await expect.poll(() => git('tag -l v9')).toBe('v9');
    await more('stash 넣기…');
    await dialog('stash 넣기').getByRole('checkbox', { name: '추적 안 함 파일 포함' }).check();
    await dialog('stash 넣기').getByRole('button', { name: '넣기', exact: true }).click();
    await expect(rows('추적 안 함')).toHaveCount(0);
    assert.equal(git('stash list --format=%gs').includes('WIP'), true);
    await more('stash 꺼내기');
    await expect(rows('추적 안 함')).toHaveText(['new 1.txt']);
    assert.equal(git('stash list'), '');
    console.log('PASS native branch, checkout, tag and stash through their dialogs');

    setStage('GE.9 terminal actions');
    await more('push');
    await expect
      .poll(() => shell(`git --git-dir ${remote} log -1 --format=%s main`))
      .toBe('고친 커밋 ge9');
    await expect(textarea).toBeFocused();
    await command("printf 'AFTER%s\\n' _PUSH");
    await expect
      .poll(() => pane().locator('.xterm-accessibility-tree').innerText())
      .toContain('AFTER_PUSH');
    await more('fetch');
    await command("printf 'AFTER%s\\n' _FETCH");
    await expect
      .poll(() => pane().locator('.xterm-accessibility-tree').innerText())
      .toContain('AFTER_FETCH');
    console.log('PASS native fetch and push are typed at the prompt of the tab');

    setStage('GE.9 busy terminal');
    await textarea.pressSequentially('sleep 4');
    await textarea.press('Enter');
    await more('pull');
    await expect(error).toHaveText('터미널이 사용 중입니다.');
    await sleep(4500);

    // What the user has half typed is not added to. Echo is off in this run, and without echo the
    // text never reaches the screen. The typing waits for the prompt after this command.
    setStage('GE.9 half-typed input');
    const screen = () => pane().locator('.xterm-accessibility-tree').innerText();
    await command("stty echo; printf 'ECHO%s\\n' _ON");
    await expect.poll(screen).toContain('ECHO_ON');
    await sleep(500);
    await textarea.pressSequentially('echo half');
    await expect.poll(screen).toContain('echo half');
    await more('fetch');
    await expect(error).toHaveText('터미널 프롬프트에 입력 중인 글자가 있습니다.');
    await textarea.press('Control+U');
    await command('stty -echo');
    console.log('PASS native a running command and half-typed text block the terminal actions');

    setStage('GE.9 force push');
    git('commit --amend -qm rewritten --allow-empty');
    await more('push 강제(안전)…');
    const force = dialog('강제 push');
    await expect(force.getByRole('button', { name: '취소', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(force).toHaveCount(0);
    await sleep(500);
    assert.equal(shell(`git --git-dir ${remote} log -1 --format=%s main`), '고친 커밋 ge9');
    await more('push 강제(안전)…');
    await force.getByRole('button', { name: '강제 push', exact: true }).click();
    await expect
      .poll(() => shell(`git --git-dir ${remote} log -1 --format=%s main`))
      .toBe('rewritten');
    console.log('PASS native force push uses --force-with-lease after its confirmation');
  } finally {
    shell(`rm -rf ${work} ${remote}`);
    await command('cd /tmp').catch(() => {});
    await showSidebarView(page, '연결').catch(() => {});
  }
}

/** GE.11: the badge on the prompt line, against what the app shows of the cursor's own line. */
async function verifyPromptBranch({ page, pane, command, status, shell, repo, setStage }) {
  const badge = pane().locator('.prompt-branch');
  const textarea = pane().locator('.xterm-helper-textarea');
  await expect(badge).toHaveText('⎇ main ●3', { timeout: 15000 });
  const onCursorRow = async () => {
    const [mark, cursor, screen] = await Promise.all([
      badge.boundingBox(),
      pane().locator('.xterm-rows .xterm-cursor').first().boundingBox(),
      pane().locator('.xterm-screen').boundingBox(),
    ]);
    assert(mark && cursor && screen, 'badge, cursor and screen all have a place');
    assert(Math.abs(mark.y - cursor.y) < 3, `badge at ${mark.y}, cursor line at ${cursor.y}`);
    assert(
      Math.abs(mark.x + mark.width - (screen.x + screen.width)) < 3,
      'badge ends at the right',
    );
  };
  await onCursorRow();

  // The first prompt after a checkout already names the branch. The last query was a moment ago,
  // so the 5 second prompt interval would still hold the status bar back without the branch event.
  await command('git checkout -q -b ge11-native');
  await expect(badge).toContainText('⎇ ge11-native', { timeout: 2000 });
  await expect(status).toContainText('ge11-native', { timeout: 3000 });
  await onCursorRow();
  console.log('PASS native first prompt after checkout names the branch, status bar follows');

  await command('git checkout -q --detach');
  await expect(badge).toContainText(/⎇ @[0-9a-f]{7}/, { timeout: 2000 });
  await command('git checkout -q main');
  await expect(badge).toContainText('⎇ main', { timeout: 2000 });

  // While a command runs and on the alternate screen there is no prompt to mark.
  await textarea.pressSequentially('sleep 2');
  await textarea.press('Enter');
  await expect(badge).toHaveCount(0, { timeout: 1000 });
  await expect(badge).toHaveCount(1, { timeout: 5000 });
  await textarea.pressSequentially('less a.txt');
  await textarea.press('Enter');
  await expect(badge).toHaveCount(0, { timeout: 2000 });
  await textarea.press('q');
  await expect(badge).toHaveCount(1, { timeout: 5000 });
  console.log('PASS native badge hidden while a command runs and in a full-screen program');

  setStage('GE.11 prompt theme with its own branch');
  // A prompt theme that already shows the branch needs no second copy.
  await command("OLD_PS1=$PS1; PS1='(main) \\$ '");
  await expect(badge).toHaveCount(0, { timeout: 2000 });
  await command('PS1=$OLD_PS1');
  await expect(badge).toHaveCount(1, { timeout: 2000 });

  setStage('GE.11 long input line');
  // A long line leaves no room, and the badge comes back when it is gone. This run keeps echo off
  // elsewhere, and without echo the typed text never reaches the screen.
  await command('stty echo');
  await textarea.pressSequentially('x'.repeat(240));
  await expect(badge).toHaveCount(0, { timeout: 2000 });
  await textarea.press('Control+U');
  await expect(badge).toHaveCount(1, { timeout: 2000 });
  await command('stty -echo');

  setStage('GE.11 setting and leaving the repository');

  // The text is drawn over the terminal, so reading the screen does not see it.
  const screenText = await pane().locator('.xterm-accessibility-tree').innerText();
  assert(!screenText.includes('⎇'), 'the badge reached the terminal text');

  // The setting's value, as GE.10 will save it. Other panes read it on this event.
  await page.evaluate(() => {
    const key = 'dachsterm.terminalPreferences';
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(key, JSON.stringify({ ...saved, promptBranch: 'off' }));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
  await expect(badge).toHaveCount(0, { timeout: 2000 });
  await page.evaluate(() => {
    const key = 'dachsterm.terminalPreferences';
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    delete saved.promptBranch;
    localStorage.setItem(key, JSON.stringify(saved));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
  await expect(badge).toHaveCount(1, { timeout: 2000 });

  await command('cd /tmp');
  await expect(badge).toHaveCount(0, { timeout: 2000 });
  await command(`cd ${repo}`);
  await expect(badge).toContainText('⎇ main', { timeout: 2000 });
  // The shell's own git commands above run the repository's fsmonitor program. Only the app must
  // not, which the next stage checks from this trace.
  shell(`git -C ${repo} branch -q -D ge11-native; rm -f ${repo}-fsmonitor.ran`);
  console.log('PASS native badge follows PS1, line length, the setting and leaving the repository');
}

/**
 * Starting an agent (DX.7) in the real app. A stand-in CLI records where and with which arguments
 * it started, so a second run would show. A real CLI agent is checked by hand.
 */
export async function verifyAgentLaunch({
  page,
  pane,
  invoke,
  docker,
  probe,
  command,
  output,
  screenshots,
  setStage,
}) {
  const container = probe('CONTAINER');
  const shell = (script) => docker(['exec', '-u', 'probe', container, 'sh', '-c', script]).trim();
  const session = 'dx7-native';
  const folder = '/tmp/dx7 native 한글';
  const plain = '/tmp/dx7-plain';
  const agent = '/tmp/dx7-agent';
  const log = '/tmp/dx7-agent.log';
  const script = `#!/bin/sh\nprintf '%s|%s\n' "$PWD" "$*" >> ${log}\nprintf 'AGENT_%s\n' READY\nexec cat\n`;
  const runs = () => shell(`cat ${log} 2>/dev/null || true`);
  const connectionId = () => pane().getAttribute('data-connection-id');
  /** A new tab or a reconnect has a new connection ID; before it, pane() is still the old one. */
  async function linked(previous) {
    await expect.poll(connectionId, { timeout: 15000 }).not.toBe(previous);
    await expect(pane().locator('.connection-message')).toContainText('연결됨', { timeout: 15000 });
  }
  const agentDialog = () => page.getByRole('dialog', { name: '에이전트 시작', exact: true });
  const reset = () =>
    shell(
      `tmux kill-session -t =${session} 2>/dev/null; rm -rf "${folder}" ${plain} ${agent} ${log}`,
    );
  reset();
  shell(
    `mkdir -p "${folder}" ${plain} && echo ${Buffer.from(script).toString('base64')} | ` +
      `base64 -d > ${agent} && chmod +x ${agent}`,
  );
  try {
    setStage('DX.7 presets in settings');
    const settings = await openSettings(page, '에이전트');
    await settings.getByRole('textbox', { name: '프리셋 1 명령' }).fill(agent);
    await settings
      .getByRole('textbox', { name: '프리셋 4 명령' })
      .fill(`${agent} --worktree {name}`);
    await settings.getByRole('button', { name: '대화상자 닫기' }).click();
    console.log('PASS native agent presets edited in the settings window');

    setStage('DX.7 tmux start from the connection menu');
    await chooseSectionMenu(page, '새 연결…');
    const form = page.getByRole('dialog');
    await form.getByLabel('이름', { exact: true }).fill('에이전트 tmux');
    await form.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
    await form.getByLabel('포트', { exact: true }).fill(probe('PORT'));
    await form.getByLabel('사용자', { exact: true }).fill('probe');
    await form.getByLabel('비밀번호', { exact: true }).fill(probe('PASSWORD'));
    await form.getByLabel('인증정보 보관', { exact: true }).selectOption('replace');
    await form.locator('summary', { hasText: '고급 옵션' }).click();
    await form.getByLabel('tmux 세션 이름').fill(session);
    await form.getByRole('button', { name: '저장', exact: true }).click();
    const card = page.locator('.profile-card').filter({ hasText: '에이전트 tmux' });
    await chooseProfileMenu(page, card, '에이전트 시작…');
    let dialog = agentDialog();
    await dialog.getByRole('textbox', { name: '폴더' }).fill(folder);
    await dialog.getByLabel('프리셋').selectOption({ label: '새 worktree' });
    await dialog.getByRole('textbox', { name: '이름' }).fill('feat-1');
    await expect(dialog.getByLabel('실행할 명령')).toHaveText(`${agent} --worktree feat-1`);
    let previous = await connectionId();
    await dialog.getByRole('button', { name: '시작', exact: true }).click();
    await linked(previous);
    await output('AGENT_READY');
    await expect.poll(runs).toBe(`${folder}|--worktree feat-1`);
    const paneCommand = () =>
      shell(`tmux display-message -p -t =${session}: '#{pane_current_command}'`);
    expect(paneCommand()).toBe('cat');
    console.log('PASS native worktree preset starts once inside a new tmux session and folder');

    setStage('DX.7 reconnect only attaches');
    const tmuxTab = page.locator('.session-tab').filter({ hasText: '에이전트 tmux' });
    await chooseTabMenu(page, '연결 종료');
    previous = await connectionId();
    await pane().getByRole('button', { name: '재접속', exact: true }).click();
    await linked(previous);
    await output('AGENT_READY');
    await sleep(2000);
    expect(runs()).toBe(`${folder}|--worktree feat-1`);
    expect(paneCommand()).toBe('cat');
    expect(shell(`tmux list-sessions -F '#{session_name}'`).split('\n')).toEqual([session]);
    // A second start for a session that exists attaches and types nothing. A new SSH tab has
    // switched the sidebar to its files, so the connection list comes back first.
    await showSidebarView(page, '연결');
    await chooseProfileMenu(page, card, '에이전트 시작…');
    dialog = agentDialog();
    await expect(dialog).toContainText('이미 있으면 붙기만');
    previous = await connectionId();
    await dialog.getByRole('button', { name: '시작', exact: true }).click();
    await expect(tmuxTab).toHaveCount(2);
    await linked(previous);
    await sleep(2000);
    expect(runs()).toBe(`${folder}|--worktree feat-1`);
    await page.screenshot({ path: path.join(screenshots, 'agent-launch-tmux.png') });
    for (let i = 0; i < 2; i++)
      await page
        .getByRole('button', { name: '에이전트 tmux 탭 닫기', exact: true })
        .first()
        .click();
    await expect(tmuxTab).toHaveCount(0);
    console.log('PASS native reconnect and a second start only attach, the command never reruns');

    setStage('DX.7 plain shell start from the file tree');
    await page
      .getByRole('tab', { name: /^OpenSSH 테스트/ })
      .first()
      .click();
    await command('cd /tmp');
    await showSidebarView(page, '파일');
    const row = page
      .locator('#file-sidebar .file-tree-row')
      .filter({ hasText: /^dx7-plain/ })
      .locator('.file-row');
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^에이전트 시작…/ }).click();
    dialog = agentDialog();
    await expect(dialog).toContainText(plain);
    await expect(dialog.getByLabel('입력할 줄')).toHaveText(`cd ${plain} && ${agent}`);
    previous = await connectionId();
    await dialog.getByRole('button', { name: '시작', exact: true }).click();
    await linked(previous);
    await output('AGENT_READY');
    await expect.poll(runs).toBe(`${folder}|--worktree feat-1\n${plain}|`);
    await chooseTabMenu(page, '연결 종료');
    previous = await connectionId();
    await pane().getByRole('button', { name: '재접속', exact: true }).click();
    await linked(previous);
    await sleep(3000);
    expect(runs()).toBe(`${folder}|--worktree feat-1\n${plain}|`);
    await chooseTabMenu(page, '탭 닫기');
    console.log(
      'PASS native file tree start types the line once at the prompt, reconnect does not',
    );
  } finally {
    reset();
    const profile = (await invoke('sessions')).profiles.find((p) => p.name === '에이전트 tmux');
    if (profile) await invoke('delete_session', { id: profile.id });
    await page
      .getByRole('tab', { name: /^OpenSSH 테스트/ })
      .first()
      .click();
    await showSidebarView(page, '연결');
  }
}

/**
 * The status bar counts tabs that report a program state, the shortcut goes to the next waiting
 * tab, and an independent window's tab is listed, focused from its row, and dropped on close.
 */
async function verifyAgentList({ page, pane, command, connectNewTab, invoke, setStage }) {
  setStage('DX.8 agent list');
  const board = page.locator('.status-bar .agent-board-toggle');
  const list = page.getByRole('region', { name: '에이전트 현황' });
  // printf turns \033 into ESC, so the shell sends OSC 7501 ... ESC \ and then keeps running.
  const report = (state) => `printf '\\033]7501;state=${state}:id=dx8\\033\\\\'; sleep 600`;
  await expect(board).toHaveCount(0);
  const first = await pane().getAttribute('data-connection-id');
  await command(report('blocked:kind=question'));
  await expect(board).toHaveText('입력 대기 1');
  await connectNewTab('OpenSSH 테스트');
  const second = await pane().getAttribute('data-connection-id');
  await page.keyboard.press('Control+Shift+Period');
  await expect.poll(() => pane().getAttribute('data-connection-id')).toBe(first);
  await board.click();
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list.getByRole('button')).toContainText('입력 대기');
  await expect(list.getByRole('button')).toHaveAttribute('title', /입력 대기 · 답변 필요/);
  await page.keyboard.press('Escape');
  console.log('PASS native agent count in the status bar and the next-waiting-tab shortcut');

  setStage('DX.8 independent window');
  await page.locator(`.tab-strip [data-tab-key]`).last().getByRole('tab').click();
  await expect.poll(() => pane().getAttribute('data-connection-id')).toBe(second);
  await chooseTabMenu(page, '새 창으로 분리');
  let detached;
  await expect
    .poll(() => {
      detached = page
        .context()
        .browser()
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes(`detached=${second}`));
      return Boolean(detached);
    })
    .toBe(true);
  const detachedPane = detached.locator('.detached-grid > .terminal-pane');
  await expect(detachedPane.locator('.connection-message')).toContainText('연결됨', {
    timeout: 15000,
  });
  await command(report('working'), detachedPane);
  await expect(board).toHaveText('입력 대기 1 · 작업 중 1');
  const label = `terminal-${second}`;
  const focused = () =>
    detached.evaluate(
      (label) => window.__TAURI_INTERNALS__.invoke('plugin:window|is_focused', { label }),
      label,
    );
  await invoke('plugin:window|set_focus', { label: 'main' });
  await expect.poll(focused).toBe(false);
  await board.click();
  const row = list.getByRole('button', { name: /독립 창/ });
  await expect(row).toContainText('작업 중');
  await row.click();
  await expect.poll(focused).toBe(true);
  const closed = detached.waitForEvent('close');
  await detached
    .getByRole('button', { name: '닫기', exact: true })
    .click()
    .catch((error) => {
      if (!detached.isClosed()) throw error;
    });
  await closed;
  await expect(board).toHaveText('입력 대기 1');
  await pane().locator('.xterm-helper-textarea').press('Control+c');
  await expect(board).toHaveCount(0);
  console.log('PASS native independent window listed, focused from its row, dropped on close');
}
