import type { Profile } from '../../lib/ipc';

/** The commands an import preview would save, with the token `config_apply` checks (CG.2). */
export type CommandPlan = {
  token: string;
  sessions: { id: string; name: string; command: string }[];
};

const runsCommand = (p: Profile) => p.proxy?.kind === 'command';

/** What a new preview selects: everything except sessions that would run a command. */
export function initialSelection(profiles: Profile[]): string[] {
  return profiles.filter((p) => !runsCommand(p)).map((p) => p.id);
}

/** Sessions about to be saved with a command the user has not ticked, e.g. a needed jump host. */
export function unapproved(profiles: Profile[], selected: string[]): Profile[] {
  return profiles.filter((p) => runsCommand(p) && !selected.includes(p.id));
}

/** The `approved` argument of `config_apply`: the ticked sessions whose command is saved. */
export function approval(
  plan: CommandPlan | null | undefined,
  profiles: Profile[],
  selected: string[],
) {
  if (!plan) return null;
  const ids = profiles.filter((p) => runsCommand(p) && selected.includes(p.id)).map((p) => p.id);
  return { token: plan.token, ids };
}
