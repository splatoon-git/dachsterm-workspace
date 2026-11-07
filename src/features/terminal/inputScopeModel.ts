/**
 * Input scope: which visible terminals receive what is typed into one of them. The backend
 * (`broadcast.rs`) only knows the selected connection IDs; the mode and the half-made pick live
 * here so the status bar and the tab bars agree on them.
 */
export type InputScope = { mode: 'off' } | { mode: 'all' } | { mode: 'pick'; ids: string[] };

export type BroadcastTarget = { id: string; name: string; host: string; username: string };
export type BroadcastStatus = { targets: BroadcastTarget[]; selected: string[] };

/** The backend refuses a group of one, so a pick starts sending at two. */
export const MIN_TARGETS = 2;

/** Visible terminals the backend can also reach, in the order they are on screen. */
export function scopeCandidates(visible: readonly string[], targets: readonly BroadcastTarget[]) {
  return visible.filter(
    (id, index) => visible.indexOf(id) === index && targets.some((t) => t.id === id),
  );
}

/** What to hand the backend for a scope: nothing until at least two panes take part. */
export function scopeIds(scope: InputScope, candidates: readonly string[]): string[] {
  const ids =
    scope.mode === 'all'
      ? [...candidates]
      : scope.mode === 'pick'
        ? scope.ids.filter((id) => candidates.includes(id))
        : [];
  return ids.length >= MIN_TARGETS ? ids : [];
}

export function togglePick(scope: InputScope, id: string, checked: boolean): InputScope {
  const ids = scope.mode === 'pick' ? scope.ids.filter((other) => other !== id) : [];
  return { mode: 'pick', ids: checked ? [...ids, id] : ids };
}

export const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/** Whether a pane takes input from the others, for its border and its tab bar mark. */
export function paneRole(
  id: string,
  scope: InputScope,
  status: BroadcastStatus,
  candidates: readonly string[],
  /** A group that includes a pane in this window is on. */
  sending: boolean,
): 'target' | 'pick' | 'outside' | null {
  if (scope.mode === 'pick' && candidates.includes(id)) return 'pick';
  if (status.selected.includes(id)) return 'target';
  return sending || scope.mode !== 'off' ? 'outside' : null;
}

export type ScopeRelease = 'layout' | 'disconnected' | 'stopped';

export const releaseText: Record<ScopeRelease, string> = {
  layout: '보이는 창이 바뀌어 개별 입력으로 돌아갔습니다',
  disconnected: '대상 연결이 끊겨 개별 입력으로 돌아갔습니다',
  stopped: '동시 입력이 중지되었습니다',
};

/**
 * Why the backend dropped a group this window had set. The backend clears the whole group as
 * soon as one target stops being ready, so a missing target means a lost connection.
 */
export function releaseReason(
  applied: readonly string[],
  status: BroadcastStatus,
): ScopeRelease | null {
  if (applied.length < MIN_TARGETS || status.selected.length) return null;
  return applied.every((id) => status.targets.some((t) => t.id === id))
    ? 'stopped'
    : 'disconnected';
}
