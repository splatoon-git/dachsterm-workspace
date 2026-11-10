import { expect, test, type Page } from '@playwright/test';
import type { ChatEvent } from '../../src/features/chat/chatState';
import type {} from './fixtures/chat';

const emit = (page: Page, events: ChatEvent[]) =>
  page.evaluate((list) => window.__chatEmit(list), events);

async function open(page: Page) {
  await page.goto('/tests/ui/fixtures/chat.html');
  await expect(page.getByRole('textbox', { name: '프롬프트' })).toBeEnabled();
  await emit(page, [{ kind: 'started', session: 's', model: 'claude-opus-5-5' }]);
}

test('a turn streams Markdown, shows its tools and can be stopped', async ({ page }) => {
  await open(page);
  const prompt = page.getByRole('textbox', { name: '프롬프트' });
  await prompt.fill('a.txt를 고쳐 줘');
  await prompt.press('Enter');
  await expect(page.getByRole('list', { name: '대화' })).toContainText('a.txt를 고쳐 줘');
  await expect(page.getByText('작업 중…')).toBeVisible();

  await emit(page, [
    { kind: 'thinking', done: false },
    { kind: 'thinking', done: true },
    {
      kind: 'toolStarted',
      id: 't1',
      name: 'Edit',
      summary: '/Users/me/work/app/a.txt',
      edit: { path: '/Users/me/work/app/a.txt', before: 'hello', after: 'bye' },
    },
    { kind: 'toolFinished', id: 't1', ok: true, output: 'The file was updated' },
    { kind: 'textDelta', text: '`a.txt`의 ' },
    { kind: 'textDelta', text: '내용을 바꿨습니다.' },
  ]);
  await expect(page.getByText('초 생각함')).toBeVisible();
  const tool = page.getByRole('button', { name: /Edit/ });
  await tool.click();
  await expect(page.getByLabel('/Users/me/work/app/a.txt 변경')).toContainText('- hello');
  await expect(page.locator('.chat-markdown code')).toHaveText('a.txt');

  // Stop is offered while the turn runs and the draft is empty.
  await page.getByRole('button', { name: '작업 중지' }).click();
  expect(await page.evaluate(() => window.__chat.calls.map((c) => c.command))).toContain(
    'chat_interrupt',
  );
  await emit(page, [{ kind: 'turnFinished', ok: false, detail: 'error_during_execution' }]);
  await expect(page.getByText('중지했습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '보내기' })).toBeVisible();
  await page.screenshot({ path: 'test-results/chat-turn.png' });
});

test('a finished block replaces what was streamed for it', async ({ page }) => {
  await open(page);
  const prompt = page.getByRole('textbox', { name: '프롬프트' });
  await prompt.fill('x');
  await prompt.press('Enter');
  await emit(page, [
    { kind: 'textDelta', text: '안' },
    { kind: 'text', text: '안녕하세요' },
    { kind: 'turnFinished', ok: true, detail: null },
  ]);
  await expect(page.locator('.chat-markdown')).toHaveCount(1);
  await expect(page.locator('.chat-markdown')).toHaveText('안녕하세요');
});

test('the composer offers commands, models, context use and subagents', async ({ page }) => {
  await open(page);
  await emit(page, [
    {
      kind: 'capabilities',
      models: [
        {
          value: 'default',
          label: 'Default (recommended)',
          detail: 'Opus 5.5',
          hint: 'claude-opus-5-5',
          levels: [],
        },
        { value: 'opus', label: 'Opus', detail: 'Opus 5.5', hint: 'claude-opus-5-5', levels: [] },
        {
          value: 'sonnet',
          label: 'Sonnet',
          detail: 'Sonnet 5.5',
          hint: 'claude-sonnet-5-5',
          levels: [],
        },
      ],
      commands: [
        {
          value: 'review',
          label: 'review',
          detail: 'Review a pull request',
          hint: '[pr]',
          levels: [],
        },
        {
          value: 'compact',
          label: 'compact',
          detail: 'Compact the conversation',
          hint: '',
          levels: [],
        },
      ],
      agents: [],
      permissionMode: 'default',
      account: { plan: 'Claude Max', email: 'me@example.com' },
    },
    {
      kind: 'context',
      model: 'claude-opus-5-5',
      percentage: 13,
      used: 25200,
      max: 200000,
      parts: [
        { name: 'System prompt', tokens: 3593, free: false },
        { name: 'Free space', tokens: 170000, free: true },
      ],
    },
    { kind: 'agentStarted', id: 'a1', call: 't9', role: 'Explore', task: '결제 모듈 탐색' },
  ]);

  // The model chip names the model by its label, and picking another asks the agent.
  await expect(page.getByRole('button', { name: '모델 Opus' })).toBeVisible();
  await page.getByRole('button', { name: '모델 Opus' }).click();
  await page
    .getByRole('dialog', { name: '모델' })
    .getByRole('button', { name: /Sonnet/ })
    .click();
  expect(await page.evaluate(() => window.__chat.calls.at(-1))).toEqual({
    command: 'chat_set_model',
    args: { id: expect.any(String), model: 'sonnet' },
  });
  await expect(page.getByRole('button', { name: '모델 Sonnet' })).toBeVisible();

  // A slash at the start lists the commands; Enter takes the highlighted one.
  const prompt = page.getByRole('textbox', { name: '프롬프트' });
  await prompt.fill('/re');
  await expect(page.getByRole('listbox', { name: '명령' }).getByRole('option')).toHaveCount(1);
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('/review ');
  await expect(page.getByRole('listbox', { name: '명령' })).toHaveCount(0);

  await page.getByRole('button', { name: '컨텍스트 13% 사용' }).click();
  await expect(page.getByRole('dialog', { name: '컨텍스트' })).toContainText('25k / 200k');
  await page.screenshot({ path: 'test-results/chat-composer.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '에이전트 1개 실행 중' }).click();
  await expect(page.getByRole('dialog', { name: '서브에이전트' })).toContainText('결제 모듈 탐색');
});

test('permission mode, effort, usage, a new chat beside and copying', async ({ page }) => {
  await open(page);
  await emit(page, [
    {
      kind: 'capabilities',
      models: [
        {
          value: 'opus',
          label: 'Opus',
          detail: 'Opus 5.5',
          hint: 'claude-opus-5-5',
          levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      ],
      commands: [],
      agents: [{ value: 'Explore', label: 'Explore', detail: '', hint: '', levels: [] }],
      permissionMode: 'default',
      account: { plan: 'Claude Max', email: 'me@example.com' },
    },
    { kind: 'effort', level: 'high' },
    {
      kind: 'usage',
      cost: 0.42,
      added: 12,
      removed: 3,
      limits: [
        { name: 'five_hour', percent: 21, resetsAt: '4102444800' },
        { name: 'seven_day', percent: 81, resetsAt: '4102444800' },
      ],
    },
  ]);
  const calls = () => page.evaluate(() => window.__chat.calls.map((c) => c.command));

  await expect(page.getByRole('button', { name: '모델 Opus' })).toHaveText('Opus · High');
  await page.getByRole('button', { name: '모델 Opus' }).click();
  await page.getByRole('group', { name: '노력 수준' }).getByRole('button', { name: 'Max' }).click();
  expect(await calls()).toContain('chat_set_effort');
  await expect(page.getByRole('button', { name: '모델 Opus' })).toHaveText('Opus · Max');
  await page.getByRole('switch', { name: /Ultracode/ }).check();
  expect(await calls()).toContain('chat_set_ultracode');
  await expect(page.getByRole('button', { name: '모델 Opus' })).toHaveText(
    'Opus · Max · Ultracode',
  );
  await emit(page, [{ kind: 'turnFinished', ok: true, detail: null }]);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '권한 모드 기본' }).click();
  await page
    .getByRole('dialog', { name: '권한 모드' })
    .getByRole('button', { name: /편집 자동 승인/ })
    .click();
  expect(await calls()).toContain('chat_set_mode');
  await emit(page, [{ kind: 'mode', mode: 'acceptEdits' }]);
  await expect(page.getByRole('button', { name: '권한 모드 편집 자동 승인' })).toBeVisible();

  await page.getByRole('button', { name: '사용량 5시간 21%' }).click();
  const usage = page.getByRole('dialog', { name: '계정과 사용량' });
  await expect(usage).toContainText('Claude Max');
  await expect(usage).toContainText('81%');
  await expect(usage).toContainText('$0.420 · +12 −3줄');
  await page.screenshot({ path: 'test-results/chat-usage.png' });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '같은 위치에서 새 채팅' }).click();
  expect(await calls()).toContain('again');

  const prompt = page.getByRole('textbox', { name: '프롬프트' });
  await prompt.fill('복사할 질문');
  await prompt.press('Enter');
  await emit(page, [
    { kind: 'text', text: '복사할 답' },
    { kind: 'turnFinished', ok: true, detail: null },
  ]);
  await page.locator('.chat-reply').hover();
  await page.locator('.chat-reply').getByRole('button', { name: '복사' }).click();
  expect(await page.evaluate(() => window.__chat.calls.at(-1))).toEqual({
    command: 'clipboard_write_text',
    args: { text: '복사할 답' },
  });
  await expect(page.locator('.chat-reply').getByRole('button', { name: '복사됨' })).toBeVisible();
});

test('files and a pasted image go with the message as paths the agent can read', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: '파일 첨부' }).click();
  const chips = page.getByRole('list', { name: '첨부' });
  await expect(chips).toContainText('notes.txt');
  // Picking the same file again adds nothing.
  await page.getByRole('button', { name: '파일 첨부' }).click();
  await expect(chips.getByRole('listitem')).toHaveCount(1);

  const prompt = page.getByRole('textbox', { name: '프롬프트' });
  await prompt.evaluate((box) => {
    const data = new DataTransfer();
    data.items.add(new File(['png'], 'shot.png', { type: 'image/png' }));
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await expect(chips).toContainText('clipboard.png');
  await expect(chips).toContainText('20 KB');
  await page.screenshot({ path: 'test-results/chat-attach.png' });

  await prompt.fill('이거 봐 줘');
  await prompt.press('Enter');
  const sent = await page.evaluate(() =>
    window.__chat.calls.filter((c) => c.command === 'chat_send').at(-1),
  );
  expect(sent?.args.text).toBe(
    '이거 봐 줘\n\n첨부한 파일:\n- /Users/me/work/app/notes.txt\n- /tmp/dachsterm-chat/clipboard-1.png',
  );
  await expect(page.locator('.chat-you')).toContainText('첨부: notes.txt, clipboard.png');
  await expect(page.getByRole('list', { name: '첨부' })).toHaveCount(0);
});

test('approvals: once, for this chat, refused, and a question answered', async ({ page }) => {
  await open(page);
  const prompt = page.getByRole('textbox', { name: '프롬프트' });
  await prompt.fill('테스트 돌려 줘');
  await prompt.press('Enter');
  const ask = (request: string, tool: string, summary: string) =>
    emit(page, [
      { kind: 'approvalAsked', request, tool, summary, detail: '', edit: null, questions: [] },
    ]);
  const answers = () =>
    page.evaluate(() =>
      window.__chat.calls.filter((c) => c.command === 'chat_answer').map((c) => c.args),
    );

  await ask('r1', 'Bash', 'npm test');
  const card = page.getByRole('group', { name: 'Bash 승인 요청' });
  await expect(card).toContainText('명령을 실행할까요?');
  await expect(page.getByText('작업 중…')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/chat-approval.png' });
  await card.getByRole('button', { name: '이 채팅에서 이 명령은 묻지 않기' }).click();
  await expect(page.getByText('허용함 · Bash npm test')).toBeVisible();

  // The same command again is allowed without a card; another one asks.
  await ask('r2', 'Bash', 'npm test');
  await expect(page.getByText('자동 허용 · Bash npm test')).toBeVisible();
  await ask('r3', 'Bash', 'rm -rf build');
  await page
    .getByRole('group', { name: 'Bash 승인 요청' })
    .getByRole('button', { name: '거부' })
    .click();
  await expect(page.getByText('거부함 · Bash rm -rf build')).toBeVisible();

  await emit(page, [
    {
      kind: 'approvalAsked',
      request: 'r4',
      tool: 'AskUserQuestion',
      summary: '',
      detail: '',
      edit: null,
      questions: [
        {
          question: 'Which colour?',
          header: 'Colour',
          multi: false,
          options: [
            { label: 'Red', detail: '' },
            { label: 'Blue', detail: '' },
          ],
        },
      ],
    },
  ]);
  const question = page.getByRole('group', { name: 'AskUserQuestion 승인 요청' });
  await expect(question.getByRole('button', { name: '답하기' })).toBeDisabled();
  await question.getByRole('button', { name: 'Blue' }).click();
  await question.getByRole('button', { name: '답하기' }).click();
  await expect(page.getByText('답함: Blue')).toBeVisible();

  expect(await answers()).toEqual([
    { id: expect.any(String), request: 'r1', allow: true, answers: null },
    { id: expect.any(String), request: 'r2', allow: true, answers: null },
    { id: expect.any(String), request: 'r3', allow: false, answers: null },
    { id: expect.any(String), request: 'r4', allow: true, answers: { 'Which colour?': 'Blue' } },
  ]);
});

test('a server chat waits through a lost connection and answers after reconnecting', async ({
  page,
}) => {
  await page.goto('/tests/ui/fixtures/chat.html?ssh');
  const calls = () => page.evaluate(() => window.__chat.calls);
  // The terminal's connection is shared: no login of the chat's own.
  await expect(page.getByRole('textbox', { name: '프롬프트' })).toBeEnabled();
  const started = (await calls()).find((c) => c.command === 'chat_start');
  expect(started?.args).toMatchObject({ connection: 'terminal-1', folder: '/srv/app' });
  expect((await calls()).some((c) => c.command === 'chat_open')).toBe(false);
  const id = started?.args.id;

  const prompt = page.getByRole('textbox', { name: '프롬프트' });
  await prompt.fill('배포 스크립트 실행해 줘');
  await prompt.press('Enter');
  await emit(page, [
    {
      kind: 'approvalAsked',
      request: 'r1',
      tool: 'Bash',
      summary: './deploy.sh',
      detail: '',
      edit: null,
      questions: [],
    },
    { kind: 'ended', reason: 'disconnected', detail: null },
  ]);
  const card = page.getByRole('group', { name: 'Bash 승인 요청' });
  await expect(card.getByRole('button', { name: '이번만 허용' })).toBeDisabled();
  await expect(card).toContainText('다시 연결하면 이 요청에 이어서 답합니다');
  await expect(page.getByRole('button', { name: '보내기' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/chat-disconnected.png' });

  // The terminal is back on a new connection; the chat attaches through it.
  await page.evaluate(() => (window.__via = 'terminal-2'));
  await page.getByRole('button', { name: '다시 연결' }).click();
  const attached = (await calls()).find((c) => c.command === 'chat_attach');
  expect(attached?.args).toEqual({ id, connection: 'terminal-2' });
  await expect(page.getByText('다시 연결했습니다.')).toBeVisible();
  await card.getByRole('button', { name: '이번만 허용' }).click();
  expect((await calls()).at(-1)).toMatchObject({
    command: 'chat_answer',
    args: { id, request: 'r1', allow: true },
  });
  // What the agent wrote while away arrives on the new reading.
  await emit(page, [
    { kind: 'text', text: '배포했습니다.' },
    { kind: 'turnFinished', ok: true, detail: null },
  ]);
  await expect(page.locator('.chat-markdown')).toHaveText('배포했습니다.');
  await expect(prompt).toHaveAttribute('placeholder', /맡길 일/);
});

test('without a terminal to share, reconnecting logs in on its own', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/chat.html?ssh');
  await expect(page.getByRole('textbox', { name: '프롬프트' })).toBeEnabled();
  await emit(page, [{ kind: 'ended', reason: 'disconnected', detail: null }]);
  await page.evaluate(() => (window.__via = null));
  await page.getByRole('button', { name: '다시 연결' }).click();
  const login = (await page.evaluate(() => window.__chat.calls)).find(
    (c) => c.command === 'chat_open',
  );
  expect(login?.args).toMatchObject({ profileId: 'p1' });
  await expect(page.getByRole('status')).toHaveText('서버에 연결하는 중…');
  await page.evaluate(() => window.__linkEmit('connected', '연결됨'));
  await expect(page.getByText('다시 연결했습니다.')).toBeVisible();
  const attached = (await page.evaluate(() => window.__chat.calls)).find(
    (c) => c.command === 'chat_attach',
  );
  expect(attached?.args.connection).toBe(login?.args.id);

  // Losing that login's connection is noticed from the link too, once.
  await page.evaluate(() => window.__linkEmit('closed', '연결이 끊어졌습니다.'));
  await expect(page.getByRole('button', { name: '다시 연결' })).toBeVisible();
  await expect(page.getByText(/서버에서는 작업이 계속되며/)).toHaveCount(2);
});

test('a codex chat starts codex and offers its own modes and efforts', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/chat.html?codex');
  await expect(page.getByRole('textbox', { name: '프롬프트' })).toBeEnabled();
  const started = await page.evaluate(() =>
    window.__chat.calls.find((c) => c.command === 'chat_start_local'),
  );
  expect(started?.args).toMatchObject({ program: 'codex', folder: '/Users/me/work/app' });
  await expect(page.locator('.chat-head')).toContainText('codex · zsh · 기본 셸');
  await emit(page, [
    { kind: 'started', session: 'th1', model: 'gpt-x' },
    { kind: 'mode', mode: 'default' },
    { kind: 'effort', level: 'high' },
    {
      kind: 'capabilities',
      models: [
        {
          value: 'gpt-x',
          label: 'GPT-X',
          detail: 'Big.',
          hint: 'gpt-x',
          levels: ['low', 'high', 'ultra'],
        },
      ],
      commands: [],
      agents: [],
      permissionMode: 'default',
      account: { plan: 'pro', email: '' },
    },
    {
      kind: 'limits',
      limits: [{ name: 'seven_day', percent: 64, resetsAt: '4102444800' }],
    },
  ]);
  const calls = () => page.evaluate(() => window.__chat.calls.map((c) => c.command));

  await page.getByRole('button', { name: '모델 GPT-X' }).click();
  const efforts = page.getByRole('group', { name: '노력 수준' });
  await expect(efforts.getByRole('button', { name: 'Ultra' })).toBeVisible();
  await expect(page.getByRole('switch', { name: /Ultracode/ })).toHaveCount(0);
  await efforts.getByRole('button', { name: 'Low' }).click();
  expect(await calls()).toContain('chat_set_effort');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '권한 모드 기본' }).click();
  const modes = page.getByRole('dialog', { name: '권한 모드' });
  await expect(modes.getByRole('button', { name: /편집 자동 승인/ })).toHaveCount(0);
  await modes.getByRole('button', { name: /읽기 전용/ }).click();
  expect(await calls()).toContain('chat_set_mode');
  await emit(page, [{ kind: 'mode', mode: 'readOnly' }]);
  await expect(page.getByRole('button', { name: '권한 모드 읽기 전용' })).toBeVisible();
  await expect(page.getByRole('button', { name: /사용량 7일 64%/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/chat-codex.png' });
});
