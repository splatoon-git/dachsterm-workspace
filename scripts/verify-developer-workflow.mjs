// Command boundaries (DX.9), Git status (DX.5), change review (DX.6) and starting an agent (DX.7)
// in the real app against the OpenSSH fixture. Runs from the first SSH tab, whose Bash 5.2 has the session hook.
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
    await expect(status).toHaveAttribute('aria-label', 'Git main, 변경 3개. 새로 고침');
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
