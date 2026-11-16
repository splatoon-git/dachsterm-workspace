import type { Terminal } from '@xterm/xterm';
import { call, errorText } from '../../lib/ipc';

/** A file transfer inside the terminal (CG.8), as `inband/mod.rs` reports it. */
export type InbandNotice = {
  type: 'inband';
  request: string;
  stage: 'ask' | 'progress' | 'done' | 'failed';
  direction: 'download' | 'upload';
  protocol: 'zmodem' | 'trzsz';
  name: string | null;
  done: number;
  total: number;
  files: number;
  message: string | null;
};
export type InbandAction = 'accept' | 'decline' | 'stop';
type Shown = InbandNotice & { connection: string };
type Host = { terminal: Terminal; connectionId: string; notice: (message: string) => void };

const protocolName = (n: InbandNotice) => (n.protocol === 'zmodem' ? 'ZMODEM' : 'trzsz');

export function inbandQuestion(n: InbandNotice) {
  const program =
    n.protocol === 'zmodem'
      ? n.direction === 'download'
        ? 'sz'
        : 'rz'
      : n.direction === 'download'
        ? 'tsz'
        : 'trz';
  return n.direction === 'download'
    ? `서버의 ${program}가 파일을 보내려 합니다. 저장할 폴더를 고르면 받습니다.`
    : `서버의 ${program}가 파일을 받으려 합니다. 보낼 파일을 고르면 보냅니다.`;
}

/** `a.bin · 12.0 / 64.0 KiB (19%)`, or the bytes so far when the sender gave no size. */
export function inbandProgress(n: InbandNotice) {
  const kib = (b: number) => `${(b / 1024).toFixed(1)}`;
  const name = n.name ?? '';
  if (!n.total) return `${name} · ${kib(n.done)} KiB`;
  const percent = Math.min(100, Math.floor((n.done / n.total) * 100));
  return `${name} · ${kib(n.done)} / ${kib(n.total)} KiB (${percent}%)`;
}

/** The line left in the terminal when a transfer ends. Control characters cannot pass. */
export function inbandSummary(n: InbandNotice) {
  // eslint-disable-next-line no-control-regex -- removing these is the point.
  const text = (n.message ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return `\r\n[파일 전송 · ${protocolName(n)}] ${text}\r\n`;
}

/**
 * The tab's transfer: the question, then progress, and a line in the terminal at the end. Only
 * the connection that reported it shows it, so a reconnect does not bring back an old card.
 */
export class InbandTransfer {
  private shown: Shown | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly host: Host) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () =>
    this.shown && this.shown.connection === this.host.connectionId ? this.shown : null;

  update(notice: InbandNotice) {
    if (notice.stage === 'done' || notice.stage === 'failed') {
      this.host.terminal.write(inbandSummary(notice));
      this.shown = null;
    } else this.shown = { ...notice, connection: this.host.connectionId };
    this.listeners.forEach((fn) => fn());
  }

  answer(action: InbandAction) {
    const shown = this.snapshot();
    if (!shown) return;
    void call('inband_transfer_answer', {
      id: shown.connection,
      request: shown.request,
      action,
    }).catch((e) => this.host.notice(errorText(e)));
  }
}
