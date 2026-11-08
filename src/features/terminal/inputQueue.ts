import { errorText } from '../../lib/ipc';

const maxQueued = 65536;
const maxMessage = 4096;

type Host = {
  /** One IPC message to the terminal's backend. */
  send: (data: string) => Promise<unknown>;
  notice: (message: string) => void;
  disposed: () => boolean;
};

/**
 * Typed and pasted text on its way to the backend, sent in order. Both the queue and each IPC
 * message are bounded, and a message never splits a surrogate pair.
 */
export class InputQueue {
  private queue: string[] = [];
  private sending = false;
  constructor(private readonly host: Host) {}
  clear() {
    this.queue = [];
  }
  push(data: string) {
    if (this.queue.reduce((n, s) => n + s.length, 0) + data.length > maxQueued) {
      this.host.notice('붙여넣기는 한 번에 64KiB 이하로 나누어 주세요.');
      return;
    }
    let chunk = '';
    for (const character of data) {
      chunk += character;
      if (chunk.length >= maxMessage) {
        this.queue.push(chunk);
        chunk = '';
      }
    }
    if (chunk) this.queue.push(chunk);
    void this.flush();
  }
  private async flush() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length && !this.host.disposed()) await this.host.send(this.queue.shift()!);
    } catch (e) {
      this.queue = [];
      this.host.notice(errorText(e));
    } finally {
      this.sending = false;
    }
  }
}
