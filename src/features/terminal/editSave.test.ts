// @vitest-environment jsdom
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../../lib/ipc';
import type { ExternalEdit } from '../../lib/externalEdit';
import { EditSaveQueue, asksOnCard, editForPane, editNotifier } from './editSave';

vi.mock('../../lib/ipc', () => ({
  desktop: true,
  call: vi.fn(() => Promise.resolve([])),
  errorText: (e: unknown) => String(e),
}));

const edit = (extra: Partial<ExternalEdit> = {}): ExternalEdit => ({
  id: 'e1',
  connectionId: 'c1',
  profileId: 'p1',
  uploadMode: 'ask',
  remote: '/srv/app.conf',
  local: 'C:/edits/working.conf',
  status: 'pending',
  message: '',
  connectionLive: true,
  ...extra,
});

const mocked = vi.mocked(call);
const backend = (rows: () => ExternalEdit[], answer?: () => Promise<unknown>) =>
  mocked.mockImplementation((command: string) =>
    command === 'edit_list'
      ? Promise.resolve(rows() as never)
      : ((answer?.() ?? Promise.resolve()) as Promise<never>),
  );
const owner = () => ({ connectionId: 'c9', profile: { id: 'p1' }, notice: vi.fn() });
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  mocked.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('which edits ask on a card', () => {
  it('asks for a save in ask mode and for any conflict', () => {
    expect(asksOnCard(edit())).toBe(true);
    expect(asksOnCard(edit({ status: 'conflict', uploadMode: 'manual' }))).toBe(true);
  });
  it('leaves a manual upload and every other state to the file panel', () => {
    expect(asksOnCard(edit({ uploadMode: 'manual' }))).toBe(false);
    for (const status of ['watching', 'uploading', 'committing', 'recovery', 'error'])
      expect(asksOnCard(edit({ status }))).toBe(false);
  });
});

describe('which tab shows an edit', () => {
  it('is the tab on its connection, even with another tab of the same session', () => {
    const rows = [edit()];
    expect(editForPane(rows, 'c1', 'p1')).toBe(rows[0]);
    expect(editForPane(rows, 'c2', 'p1')).toBeNull();
  });
  it('moves to a reconnected tab of the same session once the connection has ended', () => {
    const rows = [edit({ connectionLive: false })];
    expect(editForPane(rows, 'c2', 'p1')).toBe(rows[0]);
    expect(editForPane(rows, 'c2', 'other')).toBeNull();
  });
});

describe('EditSaveQueue', () => {
  it('reads the backend only while a pane listens and never overlaps its reads', async () => {
    let release = () => {};
    mocked.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve([] as never))),
    );
    const queue = new EditSaveQueue();
    const stop = queue.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocked).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocked).toHaveBeenCalledTimes(2);
    release();
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it('does not tell panes about a poll that changed nothing', async () => {
    backend(() => [edit()]);
    const queue = new EditSaveQueue();
    const listener = vi.fn();
    const stop = queue.subscribe(listener);
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it.each([
    [{ action: 'upload' } as const, 'retry', null],
    [{ action: 'cancel' } as const, 'pause', null],
    [{ action: 'overwrite' } as const, 'overwrite', null],
    [{ action: 'reload' } as const, 'reload', null],
    [{ action: 'saveAs', path: '/srv/b' } as const, 'saveAs', '/srv/b'],
  ])('sends %j through edit_resolve for the answering tab', async (answer, choice, path) => {
    backend(() => []);
    await new EditSaveQueue().answer(edit(), answer, owner());
    expect(mocked).toHaveBeenCalledWith('edit_resolve', {
      id: 'e1',
      connectionId: 'c9',
      profileId: 'p1',
      choice,
      path,
    });
  });

  it('asks the backend for the connection-only mode with the answering tab', async () => {
    backend(() => []);
    await new EditSaveQueue().answer(edit(), { action: 'connectionAuto' }, owner());
    expect(mocked).toHaveBeenCalledWith('edit_session_auto', {
      id: 'e1',
      connectionId: 'c9',
      profileId: 'p1',
    });
  });

  it('hides the card at once and keeps it hidden until the answer is done', async () => {
    let rows = [edit()];
    let finish = () => {};
    backend(
      () => rows,
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const queue = new EditSaveQueue();
    const stop = queue.subscribe(() => {});
    await settle();
    expect(queue.snapshot()).toHaveLength(1);
    const answered = queue.answer(queue.snapshot()[0], { action: 'upload' }, owner());
    expect(queue.snapshot()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(queue.snapshot()).toHaveLength(0);
    rows = [];
    finish();
    await answered;
    expect(queue.snapshot()).toHaveLength(0);
    stop();
  });

  it('ignores a read that started before the answer was recorded', async () => {
    const reads: ((rows: never) => void)[] = [];
    mocked.mockImplementation((command: string) =>
      command === 'edit_list'
        ? new Promise((resolve) => reads.push(resolve))
        : Promise.resolve(undefined as never),
    );
    const queue = new EditSaveQueue();
    const stop = queue.subscribe(() => {});
    reads[0]([edit()] as never);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    const stale = reads[1];
    const answered = queue.answer(queue.snapshot()[0], { action: 'upload' }, owner());
    await settle();
    reads[2]([] as never);
    await answered;
    stale([edit()] as never);
    await settle();
    expect(queue.snapshot()).toHaveLength(0);
    stop();
  });

  it('turns a conflict found during upload into the next question, with no error notice', async () => {
    let rows = [edit()];
    backend(
      () => rows,
      () => {
        rows = [edit({ status: 'conflict' })];
        return Promise.reject(new Error('conflict'));
      },
    );
    const queue = new EditSaveQueue();
    const stop = queue.subscribe(() => {});
    await settle();
    const who = owner();
    await queue.answer(queue.snapshot()[0], { action: 'upload' }, who);
    expect(queue.snapshot()[0].status).toBe('conflict');
    expect(who.notice).not.toHaveBeenCalled();
    stop();
  });

  it('shows any other failure, including one on a card that was already a conflict', async () => {
    const rows = [edit({ status: 'conflict' })];
    backend(
      () => rows,
      () => Promise.reject(new Error('편집을 시작한 서버 세션으로 연결하세요.')),
    );
    const queue = new EditSaveQueue();
    const stop = queue.subscribe(() => {});
    await settle();
    const who = owner();
    await queue.answer(queue.snapshot()[0], { action: 'reload' }, who);
    expect(who.notice).toHaveBeenCalledWith(
      expect.stringContaining('편집을 시작한 서버 세션으로 연결하세요.'),
    );
    expect(queue.snapshot()).toHaveLength(1);
    stop();
  });
});

describe('OS notification', () => {
  const session = () => ({
    terminal: { textarea: null } as unknown as Terminal,
    profile: { name: '배포 서버' } as never,
    notice: vi.fn(),
  });
  const notifications = () =>
    mocked.mock.calls.filter(([command]) => command === 'notification_show');
  afterEach(() => vi.restoreAllMocks());

  it('is sent when the app is in the background', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    editNotifier(session())(edit());
    expect(notifications()[0][1]).toEqual({
      title: '배포 서버 — 입력 대기',
      body: '업로드 확인 · app.conf',
    });
  });
  it('is not sent while the app is in front, where the card is visible', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    editNotifier(session())(edit());
    expect(notifications()).toHaveLength(0);
  });
});
