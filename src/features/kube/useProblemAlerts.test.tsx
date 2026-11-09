// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../../lib/ipc';
import { emptyIssues, type IssueLog } from './history';
import type { Problem } from './problems';
import { useProblemAlerts } from './useProblemAlerts';

vi.mock('../../lib/ipc', () => ({
  call: vi.fn(() => Promise.resolve()),
  errorText: (e: unknown) => String(e),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const problem = (name: string): Problem => ({
  key: `node:${name}`,
  kind: 'node',
  health: 'error',
  object: name,
  detail: 'NotReady',
  target: null,
});

const withAlerts = (names: string[], from = 1): IssueLog => ({
  ...emptyIssues(),
  alerts: names.map((name, at) => ({ id: from + at, problem: problem(name) })),
});

type Props = { issues: IssueLog; enabled: boolean; onScreen: boolean };

function Probe(props: Props) {
  useProblemAlerts(props.issues, props.enabled, 'prod', props.onScreen);
  return null;
}

const sent = () =>
  vi.mocked(call).mock.calls.filter(([command]) => command === 'notification_show');
const bodies = () => sent().map(([, args]) => (args as { body: string }).body);

describe('sending alerts', () => {
  let root: Root;
  // The limiter is shared by the app, so each test starts far past the last one's sends.
  let clock = 1_000_000;
  const render = (props: Partial<Props> & { issues: IssueLog }) =>
    act(() => root.render(<Probe enabled onScreen={false} {...props} />));

  beforeEach(() => {
    clock += 60_000;
    vi.useFakeTimers({ now: clock, toFake: ['Date'] });
    vi.mocked(call).mockClear();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    root = createRoot(document.createElement('div'));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('sends one notification for the problems in a poll', () => {
    render({ issues: withAlerts(['n1', 'n2']) });
    expect(bodies()).toEqual(['n1 NotReady · n2 NotReady']);
  });

  it('does not send the same alert twice', () => {
    const issues = withAlerts(['n1']);
    render({ issues });
    vi.setSystemTime(clock + 10_000);
    render({ issues: { ...issues } });
    expect(sent()).toHaveLength(1);
  });

  it('holds what the rate limit refuses and sends it with a later poll', () => {
    render({ issues: withAlerts(['n1']) });
    vi.setSystemTime(clock + 1000);
    render({ issues: withAlerts(['n1', 'n2']) });
    expect(sent()).toHaveLength(1);
    vi.setSystemTime(clock + 6000);
    render({ issues: withAlerts(['n1', 'n2']) });
    expect(bodies()).toEqual(['n1 NotReady', 'n2 NotReady']);
  });

  it('sends nothing while off, and does not report that time when turned on', () => {
    render({ issues: withAlerts(['n1']), enabled: false });
    expect(sent()).toHaveLength(0);
    render({ issues: withAlerts(['n1']), enabled: true });
    expect(sent()).toHaveLength(0);
  });

  it('stays quiet while the user is looking at this workspace', () => {
    render({ issues: withAlerts(['n1']), onScreen: true });
    expect(sent()).toHaveLength(0);
  });

  it('still sends when the workspace is on screen but the app is in the background', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    render({ issues: withAlerts(['n1']), onScreen: true });
    expect(sent()).toHaveLength(1);
  });
});
