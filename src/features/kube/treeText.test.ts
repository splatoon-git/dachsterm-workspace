import { describe, expect, it } from 'vitest';
import type { TreeRow } from './tree';
import { treeText, type TreeScope } from './treeText';
import type { WorkerCell } from './workers';

const scope: TreeScope = { context: 'prod', namespace: '', query: '', problemsOnly: false };
const totals = {
  ready: 1,
  total: 2,
  restarts: 3,
  recentRestart: true,
  cpu: 0,
  cpuRequest: 0,
  cpuLimit: 0,
  memory: 0,
  memoryRequest: 0,
  memoryLimit: 0,
};
const group = {
  type: 'group',
  id: 'group-1',
  depth: 0,
  expanded: true,
  toggle: 'group-1',
  group: {
    id: 'group-1',
    label: 'Deployment/api',
    type: 'Deployment',
    count: 2,
    health: 'warn',
    note: '미달',
    totals,
  },
} as unknown as TreeRow;
const pod = {
  type: 'pod',
  id: 'pod-1',
  depth: 1,
  view: {
    health: 'ok',
    status: 'Running',
    ready: 1,
    total: 1,
    restarts: 0,
    recentRestart: false,
    cpu: null,
    memory: null,
    pod: {
      name: 'api-1',
      node: 'n1',
      created: '2026-11-09T00:00:00Z',
      cpuRequest: 0,
      cpuLimit: 0,
      memoryRequest: 0,
      memoryLimit: 0,
    },
  },
} as unknown as TreeRow;
const shown = {
  rows: [group, pod],
  metrics: false,
  grouping: 'workload' as const,
  collectedAt: Date.parse('2026-11-09T00:01:00Z'),
};
const none = new Map<string, WorkerCell>();

describe('treeText', () => {
  it('heads the text with where it came from', () => {
    const [head] = treeText(shown, scope, none).split('\n');
    expect(head).toContain('context prod');
    expect(head).toContain('namespace 전체');
    expect(head).toContain('묶기 namespace > 워크로드 > 파드');
    expect(head).not.toContain('필터');
    expect(head).not.toContain('문제만');
  });

  it('says when a filter narrowed what was copied', () => {
    const narrowed = { ...scope, namespace: 'web', query: 'api !old', problemsOnly: true };
    const [head] = treeText(shown, narrowed, none).split('\n');
    expect(head).toContain('namespace web');
    expect(head).toContain('필터 api !old');
    expect(head).toContain('문제만');
  });

  it('indents by depth and keeps the group facts and pod facts', () => {
    const [, columns, first, second] = treeText(shown, scope, none).split('\n');
    expect(columns.startsWith('이름')).toBe(true);
    expect(columns).toContain('CPU 요청/제한');
    expect(first.startsWith('Deployment/api Deployment 2')).toBe(true);
    expect(first).toContain('▲ 미달');
    expect(first).toContain('3 ↑');
    expect(second.startsWith('  api-1')).toBe(true);
    expect(second).toContain('● Running');
    expect(second).toContain('n1');
  });

  it('lines columns up when Korean text is twice as wide', () => {
    const lines = treeText(shown, scope, none).split('\n').slice(1);
    const columnOf = (line: string) =>
      [...line.slice(0, line.indexOf('미달') >= 0 ? line.indexOf('▲') : line.indexOf('●'))].reduce(
        (sum, c) => sum + (/[가-힣]/u.test(c) ? 2 : 1),
        0,
      );
    expect(columnOf(lines[1])).toBe(columnOf(lines[2]));
  });

  it('shows a watched workload and its suspicion', () => {
    const cells = new Map([['group-1', { text: '사용 8/8', title: '', suspect: true }]]);
    const text = treeText(shown, scope, cells as Map<string, WorkerCell>);
    expect(text.split('\n')[2]).toContain('사용 8/8 의심');
  });

  it('leaves no trailing spaces for a paste', () => {
    for (const line of treeText(shown, scope, none).split('\n')) expect(line).toBe(line.trimEnd());
  });
});
