import type { Profile } from '../../lib/ipc';

/** Only the kind of screen is chosen here. Detection happens in the tab on the first connection. */
export function WorkspaceField({
  profile,
  field,
}: {
  profile: Profile;
  field: (key: 'workspace', value: NonNullable<Profile['workspace']>) => void;
}) {
  return (
    <label>
      접속 후 화면
      <select
        aria-label="접속 후 화면"
        value={profile.workspace ?? 'terminal'}
        onChange={(e) => field('workspace', e.target.value as NonNullable<Profile['workspace']>)}
      >
        <option value="terminal">터미널</option>
        <option value="kubernetes">쿠버네티스</option>
      </select>
    </label>
  );
}
