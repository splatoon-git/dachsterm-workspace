import { describe, expect, it, vi } from 'vitest';
import { InputQueue } from './inputQueue';

vi.mock('../../lib/ipc', () => ({ errorText: (e: unknown) => String(e) }));

const flushed = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('terminal input', () => {
  it('goes out in order, in messages that never split a character', async () => {
    const sent: string[] = [];
    const queue = new InputQueue({
      send: async (data) => void sent.push(data),
      notice: vi.fn(),
      disposed: () => false,
    });
    queue.push('a'.repeat(4095) + '😀' + 'b');
    queue.push('c');
    await flushed();
    expect(sent.join('')).toBe('a'.repeat(4095) + '😀' + 'bc');
    expect(sent[0]).toHaveLength(4097);
    expect(sent[0].endsWith('😀')).toBe(true);
  });

  it('refuses a paste over 64 KiB and drops the rest after a failed send', async () => {
    const notice = vi.fn();
    const send = vi.fn().mockRejectedValueOnce('연결이 종료되었습니다.');
    const queue = new InputQueue({ send, notice, disposed: () => false });
    queue.push('x'.repeat(65537));
    expect(notice).toHaveBeenCalledWith('붙여넣기는 한 번에 64KiB 이하로 나누어 주세요.');
    expect(send).not.toHaveBeenCalled();
    queue.push('x'.repeat(10_000));
    await flushed();
    expect(send).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenLastCalledWith('연결이 종료되었습니다.');
  });
});
