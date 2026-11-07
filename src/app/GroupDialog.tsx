import { Dialog } from '../components/Dialog';
import { groupPath } from '../features/sessions/model';
import type { Group, Snapshot } from '../lib/ipc';

/** New group and group edit. `action` runs a command and refreshes, true when it succeeded. */
export function GroupDialog({
  group,
  setGroup,
  snapshot,
  action,
}: {
  group: Group;
  setGroup: (group: Group | null) => void;
  snapshot: Snapshot;
  action: (command: string, args: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <Dialog title={group.id ? '그룹 수정' : '새 그룹'} size="small" close={() => setGroup(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action('group_update', {
            group: {
              ...group,
              id: group.id || crypto.randomUUID(),
              parentId: group.parentId ?? null,
              sortOrder: group.sortOrder ?? 0,
            },
          }).then((ok) => {
            if (ok) setGroup(null);
          });
        }}
      >
        <label>
          그룹 이름
          <input
            autoFocus
            required
            maxLength={100}
            value={group.name}
            onChange={(e) => setGroup({ ...group, name: e.target.value })}
          />
        </label>
        <label>
          상위 그룹
          <select
            value={group.parentId ?? ''}
            onChange={(e) => setGroup({ ...group, parentId: e.target.value || null })}
          >
            <option value="">최상위</option>
            {snapshot.groups
              .filter((g) => g.id !== group.id)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {groupPath(g.id, snapshot.groups)}
                </option>
              ))}
          </select>
        </label>
        <label>
          정렬 순서
          <input
            type="number"
            value={group.sortOrder ?? 0}
            onChange={(e) => setGroup({ ...group, sortOrder: Number(e.target.value) })}
          />
        </label>
        {group.id && (
          <p className="field-help">
            삭제하면 직속 세션 {snapshot.profiles.filter((p) => p.groupId === group.id).length}
            개와 하위 그룹 {snapshot.groups.filter((g) => g.parentId === group.id).length}개를
            최상위로 옮깁니다. 열린 연결은 유지됩니다.
          </p>
        )}
        <div className="form-actions">
          {group.id && (
            <button
              type="button"
              className="start danger-quiet"
              onClick={() =>
                void action('save_group', { id: group.id, name: null }).then((ok) => {
                  if (ok) setGroup(null);
                })
              }
            >
              그룹 삭제
            </button>
          )}
          <button type="button" onClick={() => setGroup(null)}>
            취소
          </button>
          <button className="primary">저장</button>
        </div>
      </form>
    </Dialog>
  );
}
