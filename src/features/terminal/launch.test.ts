import { describe, expect, it } from 'vitest';
import { typeAtPrompt, type PromptTarget } from './launch';

const times = { connectMs: 200, hookMs: 200, promptMs: 60, stepMs: 5 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeTab() {
  const tab = {
    status: 'connecting',
    directoryHook: undefined as string | undefined,
    current: true,
    prompt: false,
    typed: [] as string[],
    target: {} as PromptTarget,
  };
  tab.target = {
    state: () => ({ status: tab.status, directoryHook: tab.directoryHook }),
    current: () => tab.current,
    atPrompt: () => tab.prompt,
    type: (text) => tab.typed.push(text),
  };
  return tab;
}

describe('typing a start command at the prompt', () => {
  it('waits for the connection and the session hook, then types once with Enter', async () => {
    const tab = fakeTab();
    tab.prompt = true;
    const result = typeAtPrompt(tab.target, 'cd /srv && cli', times);
    await sleep(20);
    expect(tab.typed).toEqual([]);
    tab.status = 'connected';
    tab.directoryHook = 'waiting';
    await sleep(30);
    // A prompt while the hook is being typed belongs to the hook.
    expect(tab.typed).toEqual([]);
    tab.directoryHook = undefined;
    expect(await result).toBe('typed');
    expect(tab.typed).toEqual(['cd /srv && cli\r']);
  });

  it('types nothing when no prompt appears in time', async () => {
    const tab = fakeTab();
    tab.status = 'connected';
    const started = Date.now();
    expect(await typeAtPrompt(tab.target, 'cli', times)).toBe('noPrompt');
    expect(Date.now() - started).toBeGreaterThanOrEqual(times.promptMs);
    expect(tab.typed).toEqual([]);
  });

  it('gives up without typing when the tab ends, closes or reconnects', async () => {
    for (const end of [
      (t: ReturnType<typeof fakeTab>) => (t.status = 'error'),
      (t: ReturnType<typeof fakeTab>) => (t.status = 'closed'),
      (t: ReturnType<typeof fakeTab>) => (t.current = false),
    ]) {
      const tab = fakeTab();
      const result = typeAtPrompt(tab.target, 'cli', times);
      await sleep(10);
      end(tab);
      tab.prompt = true;
      expect(await result).toBe('ended');
      expect(tab.typed).toEqual([]);
    }
  });

  it('does not wait forever for a hook or a sign-in', async () => {
    const hook = fakeTab();
    hook.status = 'connected';
    hook.directoryHook = 'waiting';
    hook.prompt = true;
    expect(await typeAtPrompt(hook.target, 'cli', times)).toBe('noPrompt');
    expect(hook.typed).toEqual([]);
    const login = fakeTab();
    expect(await typeAtPrompt(login.target, 'cli', times)).toBe('noPrompt');
  });
});
