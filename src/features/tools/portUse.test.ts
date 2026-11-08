import { describe, expect, it } from 'vitest';
import { answerPorts, parsePortFilter, processText, unusedText, type Listener } from './portUse';

const listener = (port: number, over: Partial<Listener> = {}): Listener => ({
  protocol: 'tcp',
  address: '0.0.0.0',
  port,
  process: { kind: 'known', name: 'nginx', pid: 7 },
  ...over,
});

describe('port filter', () => {
  it('reads single ports and ranges, without repeats', () => {
    expect(parsePortFilter('22, 80 79-81')).toEqual({ ports: [22, 79, 80, 81], error: null });
    expect(parsePortFilter('  ')).toEqual({ ports: [], error: null });
  });

  it('says which part is wrong', () => {
    for (const bad of ['0', '65536', 'abc', '90-80', '1-2-3', '1-'])
      expect(parsePortFilter(bad).error).toContain(bad);
  });
});

describe('port answers', () => {
  it('separates used from unused, and a port with two sockets is one port', () => {
    const list = [listener(80), listener(80, { protocol: 'udp' }), listener(22)];
    const { used, unused } = answerPorts(list, [80, 443]);
    expect(used).toHaveLength(2);
    expect(unused).toEqual([443]);
  });

  it('shows what is known about the owner', () => {
    expect(processText({ kind: 'known', name: 'sshd', pid: 1 })).toBe('sshd (1)');
    expect(processText({ kind: 'known', name: 'sshd', pid: null })).toBe('sshd');
    expect(processText({ kind: 'denied' })).toBe('권한 없음');
    expect(processText({ kind: 'unavailable' })).toBe('알 수 없음');
  });

  it('cuts a long list of unused ports short', () => {
    const ports = Array.from({ length: 40 }, (_, index) => index + 1);
    expect(unusedText(ports)).toMatch(/32 외 8개$/);
    expect(unusedText([1, 2])).toBe('1, 2');
  });
});
