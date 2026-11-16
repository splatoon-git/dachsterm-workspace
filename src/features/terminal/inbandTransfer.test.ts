import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../../lib/ipc';
import {
  InbandTransfer,
  inbandProgress,
  inbandQuestion,
  inbandSummary,
  type InbandNotice,
} from './inbandTransfer';

vi.mock('../../lib/ipc', () => ({
  call: vi.fn(() => Promise.resolve()),
  errorText: String,
}));

const notice = (patch: Partial<InbandNotice>): InbandNotice => ({
  type: 'inband',
  request: 'r1',
  stage: 'ask',
  direction: 'download',
  protocol: 'zmodem',
  name: null,
  done: 0,
  total: 0,
  files: 0,
  message: null,
  ...patch,
});

function host() {
  const written: string[] = [];
  const h = {
    connectionId: 'c1',
    terminal: { write: (t: string) => written.push(t) } as never,
    notice: vi.fn(),
  };
  return { h, written };
}

describe('in-band transfers', () => {
  beforeEach(() => vi.mocked(call).mockClear());

  it('names the program that asks and what answering does', () => {
    expect(inbandQuestion(notice({}))).toMatch(/sz가 파일을 보내려/);
    expect(inbandQuestion(notice({ direction: 'upload', protocol: 'trzsz' }))).toMatch(
      /trz가 파일을 받으려/,
    );
  });

  it('shows progress with and without a size', () => {
    expect(inbandProgress(notice({ name: 'a.bin', done: 12288, total: 65536 }))).toBe(
      'a.bin · 12.0 / 64.0 KiB (18%)',
    );
    expect(inbandProgress(notice({ name: 'a.bin', done: 2048 }))).toBe('a.bin · 2.0 KiB');
  });

  it('leaves a line in the terminal at the end, without control characters', () => {
    expect(inbandSummary(notice({ stage: 'done', message: 'ok\u001b[2Jdone\r' }))).toBe(
      '\r\n[파일 전송 · ZMODEM] ok [2Jdone \r\n',
    );
  });

  it('answers the shown request on its connection and forgets it at the end', async () => {
    const { h, written } = host();
    const transfer = new InbandTransfer(h);
    transfer.update(notice({}));
    transfer.answer('accept');
    expect(call).toHaveBeenCalledWith('inband_transfer_answer', {
      id: 'c1',
      request: 'r1',
      action: 'accept',
    });
    transfer.update(notice({ stage: 'progress', name: 'a.bin' }));
    expect(transfer.snapshot()?.stage).toBe('progress');
    transfer.update(notice({ stage: 'done', message: '저장했습니다' }));
    expect(transfer.snapshot()).toBeNull();
    expect(written.join('')).toContain('저장했습니다');
  });

  it('does not bring an old card back after a reconnect', () => {
    const { h } = host();
    const transfer = new InbandTransfer(h);
    transfer.update(notice({}));
    h.connectionId = 'c2';
    expect(transfer.snapshot()).toBeNull();
    transfer.answer('decline');
    expect(call).not.toHaveBeenCalled();
  });
});
