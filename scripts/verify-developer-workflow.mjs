// Command boundaries (DX.9) and Git status (DX.5) in the real app against the OpenSSH fixture.
// Runs in the first SSH tab, whose Bash 5.2 already has the session hook.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { showSidebarView } from './native-workspace.mjs';

const repo = '/tmp/dachsterm-git-ui';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function verifyDeveloperWorkflow({ page, pane, docker, probe, command, setStage }) {
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
  } finally {
    shell(`rm -rf ${repo} ${hook} ${hook}.ran`);
    await command('cd /tmp');
    await showSidebarView(page, '연결');
  }
}
