import { describe, expect, it } from 'vitest';
import {
  agentPrograms,
  buildAgentCommand,
  dangerWarning,
  isDangerousCommand,
  parseAgentCommand,
} from './agentOptions';
import { defaultAgentPresets } from './presets';

describe('agent start options', () => {
  it('builds the commands the tools document', () => {
    const line = (program: string, mode: string, start: string) =>
      buildAgentCommand({ program, mode, start });
    expect(line('claude', 'default', 'new')).toBe('claude');
    expect(line('claude', 'plan', 'continue')).toBe('claude --continue --permission-mode plan');
    expect(line('claude', 'accept-edits', 'worktree')).toBe(
      'claude --worktree {name} --permission-mode acceptEdits',
    );
    expect(line('codex', 'auto', 'new')).toBe('codex --approve-for-me');
    expect(line('codex', 'default', 'continue')).toBe('codex resume --last');
    expect(line('codex', 'bypass', 'pick')).toBe(
      'codex resume --dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('reads every combination back from its command', () => {
    for (const program of agentPrograms)
      for (const start of program.starts)
        for (const mode of program.modes) {
          const choice = { program: program.command, mode: mode.id, start: start.id };
          expect(parseAgentCommand(buildAgentCommand(choice))).toEqual(choice);
        }
    expect(parseAgentCommand('  claude   --continue ')).toEqual({
      program: 'claude',
      mode: 'default',
      start: 'continue',
    });
  });

  it('leaves anything it cannot show as free text', () => {
    for (const command of [
      '',
      'cli --review',
      'claude --model fast',
      'claude --continue --resume',
      'codex --full-auto',
      'cd /srv && claude',
    ])
      expect(parseAgentCommand(command), command).toBe(null);
  });

  it('opens each default preset as a choice and never defaults to a dangerous mode', () => {
    for (const preset of defaultAgentPresets) {
      expect(parseAgentCommand(preset.command), preset.command).not.toBe(null);
      expect(isDangerousCommand(preset.command), preset.command).toBe(false);
    }
  });

  it('marks a mode as dangerous in its label exactly when the command is flagged', () => {
    for (const program of agentPrograms)
      for (const mode of program.modes)
        expect(isDangerousCommand(`${program.command} ${mode.args.join(' ')}`), mode.id).toBe(
          mode.label.endsWith('(위험)'),
        );
  });

  it('flags dangerous options in typed commands and not their look-alikes', () => {
    for (const command of [
      'claude --dangerously-skip-permissions',
      'claude --allow-dangerously-skip-permissions',
      'claude --permission-mode bypassPermissions',
      'claude --permission-mode=bypassPermissions',
      "claude '--dangerously-skip-permissions'",
      'cd /srv && codex --yolo',
      'codex resume --last --dangerously-bypass-approvals-and-sandbox',
      'codex -s danger-full-access',
      'codex --sandbox=danger-full-access',
    ])
      expect(isDangerousCommand(command), command).toBe(true);
    for (const command of [
      'claude --permission-mode plan',
      'codex --sandbox workspace-write',
      'codex --approve-for-me',
      'cli --dangerously',
      'not--yolo',
    ])
      expect(isDangerousCommand(command), command).toBe(false);
  });

  it('warns without naming a product', () => {
    expect(dangerWarning).not.toMatch(/claude|codex/i);
    expect(dangerWarning).toContain('SSH 키 서명');
  });
});
