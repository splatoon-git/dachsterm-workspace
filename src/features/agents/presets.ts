/**
 * Start commands for CLI agents. A preset is command text only: the app never runs an agent
 * itself, and worktrees are created and removed by the tool the command starts.
 */
export type AgentPreset = { name: string; command: string };

export const agentPresetsKey = 'dachsterm.agentPresets';
export const maxPresets = 20;
const maxNameLength = 40;
const maxCommandLength = 1000;
const nameToken = '{name}';

export const defaultAgentPresets: readonly AgentPreset[] = [
  { name: '에이전트', command: 'claude' },
  { name: '이어서', command: 'claude --continue' },
  { name: '세션 선택', command: 'claude --resume' },
  { name: '새 worktree', command: `claude --worktree ${nameToken}` },
];

const hasControl = (text: string) => /\p{Cc}/u.test(text);

/** Why a preset cannot be saved, or null when it can. */
export function presetProblem(preset: AgentPreset): string | null {
  const name = preset.name.trim();
  const command = preset.command.trim();
  if (!name || name.length > maxNameLength) return `이름은 1~${maxNameLength}자로 입력하세요.`;
  if (!command || command.length > maxCommandLength)
    return `명령은 1~${maxCommandLength}자로 입력하세요.`;
  if (hasControl(preset.name) || hasControl(preset.command))
    return '이름과 명령에는 줄바꿈이나 제어 문자를 넣을 수 없습니다.';
  return null;
}

/** The saved list, checked entry by entry. Anything unreadable falls back to the defaults. */
export function readAgentPresets(): AgentPreset[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(agentPresetsKey) ?? 'null');
    if (!Array.isArray(saved)) return [...defaultAgentPresets];
    const presets = saved
      .slice(0, maxPresets)
      .filter(
        (p): p is AgentPreset =>
          typeof p?.name === 'string' && typeof p?.command === 'string' && !presetProblem(p),
      )
      .map((p) => ({ name: p.name.trim(), command: p.command.trim() }));
    return presets.length ? presets : [...defaultAgentPresets];
  } catch {
    // Blocked storage or a damaged value: the defaults still let the user start an agent.
    return [...defaultAgentPresets];
  }
}

/** Saves only a list that reads back the same; returns whether it was stored. */
export function writeAgentPresets(presets: AgentPreset[]): boolean {
  if (!presets.length || presets.length > maxPresets || presets.some(presetProblem)) return false;
  try {
    const clean = presets.map((p) => ({ name: p.name.trim(), command: p.command.trim() }));
    localStorage.setItem(agentPresetsKey, JSON.stringify(clean));
    return true;
  } catch {
    // The caller tells the user the list was not saved.
    return false;
  }
}

export const needsName = (preset: AgentPreset) => preset.command.includes(nameToken);

/**
 * A worktree or session name. It starts with a letter or digit so it can never be read as an
 * option or as `.`/`..`, and needs no quoting in any shell.
 */
export function nameProblem(name: string): string | null {
  if (!name) return '이름을 입력하세요.';
  if (name.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    return '이름은 영문·숫자로 시작하고 영문, 숫자, ., _, - 로 64자까지 입력하세요.';
  return null;
}

/** The final command, or null while `{name}` still needs a valid value. */
export function presetCommand(preset: AgentPreset, name: string): string | null {
  if (!needsName(preset)) return preset.command;
  return nameProblem(name) ? null : preset.command.split(nameToken).join(name);
}

/** A server folder for the start, or why it cannot be used. Empty means the login folder. */
export function folderProblem(folder: string): string | null {
  if (!folder) return null;
  if (!folder.startsWith('/')) return '서버 폴더는 /로 시작하는 경로로 입력하세요.';
  if (hasControl(folder) || folder.length > 4096) return '폴더 경로를 확인하세요.';
  return null;
}
