import { nameToken } from './presets';

/**
 * The start options offered for each agent command, checked against the `--help` of
 * claude 2.1.114 and codex-cli 0.155.1 (DX.16.0). Options change between versions of those tools,
 * so this table is the only place that names them. A label ends in "(위험)" exactly when
 * `isDangerousCommand` flags the option, which the unit test holds.
 */
export type AgentOption = { id: string; label: string; args: readonly string[] };
export type AgentProgram = {
  command: string;
  modes: readonly AgentOption[];
  starts: readonly AgentOption[];
};
export type AgentChoice = { program: string; mode: string; start: string };

const plainMode: AgentOption = { id: 'default', label: '기본', args: [] };
const newStart: AgentOption = { id: 'new', label: '새로', args: [] };

export const agentPrograms: readonly AgentProgram[] = [
  {
    command: 'claude',
    modes: [
      plainMode,
      { id: 'accept-edits', label: '편집 자동 승인', args: ['--permission-mode', 'acceptEdits'] },
      { id: 'plan', label: '계획', args: ['--permission-mode', 'plan'] },
      { id: 'skip', label: '권한 확인 생략 (위험)', args: ['--dangerously-skip-permissions'] },
    ],
    starts: [
      newStart,
      { id: 'continue', label: '이어서', args: ['--continue'] },
      { id: 'pick', label: '세션 선택', args: ['--resume'] },
      { id: 'worktree', label: '새 worktree', args: ['--worktree', nameToken] },
    ],
  },
  {
    command: 'codex',
    modes: [
      plainMode,
      { id: 'auto', label: '자동', args: ['--approve-for-me'] },
      {
        id: 'bypass',
        label: '승인·샌드박스 생략 (위험)',
        args: ['--dangerously-bypass-approvals-and-sandbox'],
      },
    ],
    // `resume` is a subcommand, so it comes first; it takes the mode options after it.
    starts: [
      newStart,
      { id: 'continue', label: '이어서', args: ['resume', '--last'] },
      { id: 'pick', label: '세션 선택', args: ['resume'] },
    ],
  },
];

export const programOf = (command: string) => agentPrograms.find((p) => p.command === command);

const lineOf = (program: AgentProgram, start: AgentOption, mode: AgentOption) =>
  [program.command, ...start.args, ...mode.args].join(' ');

/** The command for a choice. An id the program does not have reads as its plain first option. */
export function buildAgentCommand(choice: AgentChoice): string {
  const program = programOf(choice.program) ?? agentPrograms[0];
  const pick = (options: readonly AgentOption[], id: string) =>
    options.find((o) => o.id === id) ?? options[0];
  return lineOf(program, pick(program.starts, choice.start), pick(program.modes, choice.mode));
}

/** The choice a saved command stands for, or null when only free text can show it. */
export function parseAgentCommand(command: string): AgentChoice | null {
  const words = command.trim().split(/\s+/);
  const program = programOf(words[0]);
  if (!program) return null;
  const text = words.join(' ');
  for (const start of program.starts)
    for (const mode of program.modes)
      if (lineOf(program, start, mode) === text)
        return { program: program.command, mode: mode.id, start: start.id };
  return null;
}

/**
 * Whole-word match, so a typed command is caught too. `--yolo` is a hidden codex alias, and any
 * future `--dangerously-*` option counts. This only drives a warning; it guards nothing.
 */
const dangerWord = /^(--(allow-)?dangerously-.+|--yolo|bypassPermissions|danger-full-access)$/;

/** Whether the command turns off the agent's own approvals or sandbox. */
export function isDangerousCommand(command: string): boolean {
  return command
    .replace(/['"]/g, '')
    .split(/[\s;&|()=]+/)
    .some((word) => dangerWord.test(word));
}

export const dangerWarning =
  '권한 확인을 건너뛰어 에이전트가 묻지 않고 파일을 바꾸고 명령을 실행합니다. SSH 키 서명과 Git 자격 증명은 이 모드에서도 앱의 승인을 따릅니다.';
