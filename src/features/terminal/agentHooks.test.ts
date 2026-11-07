import { describe, expect, it } from 'vitest';
import { agentHookExample, tmuxSettingsExample } from './agentHooks';
import { hookStatus } from './programStatus';

type Hooks = {
  hooks: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
};

describe('agent hook example', () => {
  const { hooks } = JSON.parse(agentHookExample) as Hooks;
  const sequence = (event: string) => {
    const { type, command } = hooks[event][0].hooks[0];
    expect(type).toBe('command');
    const output = /^printf '%s' '(.*)'$/.exec(command)![1];
    return (JSON.parse(output) as { terminalSequence: string }).terminalSequence;
  };

  it.each([
    ['UserPromptSubmit', 'working'],
    ['PostToolUse', 'working'],
    ['PermissionRequest', 'blocked'],
    ['PreToolUse', 'blocked'],
    ['Notification', 'blocked'],
    ['Stop', 'done'],
    ['StopFailure', 'error'],
  ])('%s prints JSON the terminal reads as %s', (event, state) => {
    const printed = sequence(event);
    expect(printed.startsWith('\x1b]777;')).toBe(true);
    expect(printed.endsWith('\x07')).toBe(true);
    expect(hookStatus(printed.slice(6, -1))).toBe(state);
  });

  it('does not report an idle reminder as a program waiting for input', () => {
    const types = hooks.Notification[0].matcher!.split('|');
    expect(types).toContain('permission_prompt');
    expect(types).not.toContain('idle_prompt');
  });

  it('marks only a question as waiting before a tool runs', () => {
    expect(hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
  });

  it('has a shell-safe command with no single quote inside the JSON', () => {
    for (const event of Object.keys(hooks)) {
      const output = /^printf '%s' '(.*)'$/.exec(hooks[event][0].hooks[0].command)![1];
      expect(output).not.toContain("'");
    }
  });

  it('asks for the tmux settings the verification used', () => {
    expect(tmuxSettingsExample).toContain('set -g allow-passthrough on');
    expect(tmuxSettingsExample).toContain('set -s extended-keys on');
  });
});
