import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { errorText } from '../../lib/ipc';
import { setBroadcast, useBroadcastStatus } from './broadcastStatus';
import {
  MIN_TARGETS,
  paneRole,
  releaseReason,
  releaseText,
  sameIds,
  scopeCandidates,
  scopeIds,
  togglePick,
  type InputScope,
} from './inputScopeModel';

/** How long the status bar keeps saying why the input went back to one pane. */
export const NOTICE_MS = 5000;
const tooFew = '보이는 터미널 창이 2개 이상이어야 합니다';

/**
 * Input scope for the panes on screen. `visible` lists the connection of each visible pane in
 * screen order; any change to it ends the group, as does a target losing its connection.
 */
export function useInputScope(visible: readonly string[]) {
  const status = useBroadcastStatus();
  const [scope, setScope] = useState<InputScope>({ mode: 'off' });
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  /** The group this window last set, so a group the backend dropped can be told apart. */
  const applied = useRef<string[]>([]);
  const candidates = scopeCandidates(visible, status.targets);
  // Another window's group is not this window's to show or to stop.
  const sending =
    status.selected.length >= MIN_TARGETS && status.selected.some((id) => visible.includes(id));

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  async function apply(ids: string[]) {
    const previous = applied.current;
    // While the group changes, a status without it is not a dropped group.
    applied.current = [];
    setPending(true);
    try {
      await setBroadcast(ids);
      applied.current = ids;
      return true;
    } catch (e) {
      applied.current = previous;
      setNotice(errorText(e));
      return false;
    } finally {
      setPending(false);
    }
  }
  function choose(mode: InputScope['mode']) {
    setNotice('');
    if (mode === 'off') {
      setScope({ mode: 'off' });
      if (sending) void apply([]);
    } else if (candidates.length < MIN_TARGETS) setNotice(tooFew);
    else if (mode === 'all') {
      setScope({ mode: 'all' });
      void apply(candidates).then((ok) => ok || setScope({ mode: 'off' }));
    } else setScope({ mode: 'pick', ids: status.selected.filter((id) => candidates.includes(id)) });
  }
  function toggle(id: string, checked: boolean) {
    const next = togglePick(scope, id, checked);
    setScope(next);
    const ids = scopeIds(next, candidates);
    if (!sameIds(ids, status.selected)) void apply(ids);
  }
  /** `Ctrl/Cmd+Shift+M`: stops a group at once, and otherwise only opens the pick. */
  function shortcut() {
    choose(sending || scope.mode !== 'off' ? 'off' : 'pick');
  }

  const visibleKey = visible.join(',');
  const shown = useRef(visible);
  const layoutChanged = useEffectEvent((before: readonly string[]) => {
    const group = status.selected.some((id) => before.includes(id) || visible.includes(id));
    if (scope.mode === 'off' && !group) return;
    setScope({ mode: 'off' });
    if (group) void apply([]);
    setNotice(releaseText.layout);
  });
  useEffect(() => {
    const before = shown.current;
    if (before.join(',') === visibleKey) return;
    shown.current = visibleKey ? visibleKey.split(',') : [];
    layoutChanged(before);
  }, [visibleKey]);

  const statusChanged = useEffectEvent(() => {
    const reason = releaseReason(applied.current, status);
    if (!reason) return;
    applied.current = [];
    setScope({ mode: 'off' });
    setNotice(releaseText[reason]);
  });
  useEffect(() => statusChanged(), [status]);

  return {
    scope,
    status,
    candidates,
    sending,
    pending,
    notice: notice || status.error || '',
    choose,
    toggle,
    shortcut,
    /** How a pane shows its part in the group; `undefined` is a pane with no terminal. */
    roleOf: (id: string | undefined) =>
      id === undefined
        ? sending || scope.mode !== 'off'
          ? ('outside' as const)
          : null
        : paneRole(id, scope, status, candidates, sending),
  };
}
export type InputScopeController = ReturnType<typeof useInputScope>;
