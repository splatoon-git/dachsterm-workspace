// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Backend = { targets: string[]; selected: string[] };
const backend: Backend = { targets: [], selected: [] };
const call = vi.fn(async (command: string, args?: { ids: string[] }) => {
  if (command === 'broadcast_set') backend.selected = [...args!.ids];
  if (command === 'broadcast_status')
    return {
      targets: backend.targets.map((id) => ({ id, name: id, host: 'h', username: 'u' })),
      selected: [...backend.selected],
    };
});
vi.mock('../../lib/ipc', () => ({
  call: (...args: unknown[]) => call(...(args as [string])),
  desktop: true,
  errorText: (e: unknown) => String(e),
}));
const { useInputScope } = await import('./useInputScope');
const { releaseText } = await import('./inputScopeModel');
const { BROADCAST_POLL_MS } = await import('./broadcastStatus');
type Controller = ReturnType<typeof useInputScope>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let current: Controller;
const report = (controller: Controller) => {
  current = controller;
};
function Harness({ visible }: { visible: string[] }) {
  const controller = useInputScope(visible);
  useEffect(() => report(controller));
  return null;
}
let root: Root | undefined;
const show = (visible: string[]) => act(() => root!.render(<Harness visible={visible} />));
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
  });
const poll = () => act(() => vi.advanceTimersByTimeAsync(BROADCAST_POLL_MS));
const sets = () => call.mock.calls.filter(([command]) => command === 'broadcast_set');

beforeEach(async () => {
  vi.useFakeTimers();
  backend.targets = ['a', 'b', 'c'];
  backend.selected = [];
  root = createRoot(document.createElement('div'));
  await show(['a', 'b', 'group-1']);
  await settle();
  call.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
});

describe('input scope in a window', () => {
  it('sends to every visible terminal and goes back to one pane when the layout changes', async () => {
    expect(current.candidates).toEqual(['a', 'b']);
    act(() => current.choose('all'));
    await settle();
    expect(sets()).toEqual([['broadcast_set', { ids: ['a', 'b'] }]]);
    expect(current.sending).toBe(true);
    expect(current.roleOf('a')).toBe('target');
    expect(current.roleOf(undefined)).toBe('outside');

    await show(['a', 'c']);
    await settle();
    expect(backend.selected).toEqual([]);
    expect(current.scope).toEqual({ mode: 'off' });
    expect(current.notice).toBe(releaseText.layout);
  });

  it('starts a pick only at the second pane and keeps following the boxes', async () => {
    act(() => current.choose('pick'));
    expect(current.roleOf('a')).toBe('pick');
    act(() => current.toggle('a', true));
    await settle();
    expect(sets()).toEqual([]);
    expect(current.sending).toBe(false);
    act(() => current.toggle('b', true));
    await settle();
    expect(backend.selected).toEqual(['a', 'b']);
    act(() => current.toggle('a', false));
    await settle();
    expect(backend.selected).toEqual([]);
    expect(current.scope).toEqual({ mode: 'pick', ids: ['b'] });
  });

  it('says why when a target loses its connection', async () => {
    act(() => current.choose('all'));
    await settle();
    // The backend drops the whole group as soon as one target stops being ready.
    backend.targets = ['a', 'c'];
    backend.selected = [];
    await poll();
    await settle();
    expect(current.sending).toBe(false);
    expect(current.scope).toEqual({ mode: 'off' });
    expect(current.notice).toBe(releaseText.disconnected);
  });

  it("leaves another window's group alone", async () => {
    backend.selected = ['x', 'y'];
    await poll();
    await settle();
    expect(current.sending).toBe(false);
    await show(['a']);
    await settle();
    expect(sets()).toEqual([]);
    expect(backend.selected).toEqual(['x', 'y']);
  });

  it('opens the pick from the shortcut and stops a group with it', async () => {
    act(() => current.shortcut());
    expect(current.scope).toEqual({ mode: 'pick', ids: [] });
    expect(sets()).toEqual([]);
    act(() => current.choose('all'));
    await settle();
    act(() => current.shortcut());
    await settle();
    expect(backend.selected).toEqual([]);
    expect(current.scope).toEqual({ mode: 'off' });
  });

  it('refuses a scope while fewer than two terminals are on screen', async () => {
    await show(['a', 'group-1']);
    await settle();
    act(() => current.choose('all'));
    await settle();
    expect(sets()).toEqual([]);
    expect(current.notice).toContain('2개 이상');
  });
});
