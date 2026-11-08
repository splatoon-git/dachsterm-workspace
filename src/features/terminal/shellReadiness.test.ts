// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shellReadiness, type ShellFacts } from './shellReadiness';

const atPrompt: ShellFacts = {
  connected: true,
  tmux: false,
  fullScreen: false,
  reportsPrompts: true,
  promptWaiting: true,
  promptHasText: false,
};

describe('shellReadiness', () => {
  it('types only at an empty, reported prompt', () => {
    expect(shellReadiness(atPrompt)).toEqual({ state: 'ready' });
  });

  it('blocks a full-screen program, a running command and half-typed text', () => {
    expect(shellReadiness({ ...atPrompt, fullScreen: true }).state).toBe('blocked');
    expect(shellReadiness({ ...atPrompt, promptWaiting: false }).state).toBe('blocked');
    expect(shellReadiness({ ...atPrompt, promptHasText: true }).state).toBe('blocked');
    expect(shellReadiness({ ...atPrompt, connected: false }).state).toBe('blocked');
  });

  it('leaves the decision to the user when the shell reports nothing', () => {
    expect(shellReadiness({ ...atPrompt, reportsPrompts: false }).state).toBe('ask');
    expect(shellReadiness({ ...atPrompt, tmux: true }).state).toBe('ask');
  });

  it('still blocks a full-screen program when prompts are not reported', () => {
    expect(shellReadiness({ ...atPrompt, reportsPrompts: false, fullScreen: true }).state).toBe(
      'blocked',
    );
  });
});
