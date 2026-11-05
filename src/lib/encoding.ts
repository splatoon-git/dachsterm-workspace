/** Keeps incomplete characters across SSH frames; ANSI escape bytes remain unchanged. */
export class TerminalDecoder {
  private decoder: TextDecoder;
  constructor(label = 'utf-8') {
    this.decoder = new TextDecoder(label);
  }
  push(bytes: number[] | Uint8Array) {
    return this.decoder.decode(new Uint8Array(bytes), { stream: true });
  }
  finish() {
    return this.decoder.decode();
  }
}
