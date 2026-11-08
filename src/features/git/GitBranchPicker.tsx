import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { Icon, type IconName } from '../../components/Icon';
import { call, errorText } from '../../lib/ipc';
import type { GitRefs } from './gitDiff';
import type { GitViewRepo } from './gitViewModel';
import {
  branchChoices,
  branchPicks,
  trackCommand,
  type BranchPick,
  type GitDialogRequest,
} from './gitWrite';
import type { GitWrite } from './useGitWrite';

const headings = { local: '로컬', remote: '원격' };
const icons: Record<BranchPick['kind'], IconName> = {
  create: 'plus',
  local: 'branch',
  remote: 'cloud',
};
const hint = (pick: BranchPick) => (pick.kind === 'remote' ? '터미널에서 추적 브랜치 만들기' : '');

/** Switching branches as a quick pick: type to narrow, arrows to move, Enter to go. */
export function GitBranchPicker({
  repo,
  close,
  write,
  ask,
}: {
  repo: GitViewRepo;
  close: () => void;
  write: GitWrite;
  ask: (request: GitDialogRequest) => void;
}) {
  const [refs, setRefs] = useState<GitRefs | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const { source } = write;
  useEffect(() => {
    let live = true;
    void call<GitRefs>('git_refs', { source, folder: repo.root })
      .then((value) => {
        if (live) setRefs(value);
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
    };
    // Asked once for the picker: `source` is a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.root]);
  const choices = useMemo(() => branchChoices(refs?.refs ?? [], repo.branch), [refs, repo.branch]);
  const picks = useMemo(() => branchPicks(choices, filter), [choices, filter]);
  const at = Math.min(active, picks.length - 1);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, picks]);

  const choose = (pick: BranchPick) => {
    if (pick.kind === 'create') {
      ask({ kind: 'branchCreate', name: filter.trim() });
      return;
    }
    close();
    if (pick.kind === 'local') {
      void write.apply({ kind: 'checkout', branch: pick.name });
      return;
    }
    const command = trackCommand(pick.name);
    if (command) void write.runInTerminal(command);
    else write.note('이 브랜치 이름은 터미널에 안전하게 입력할 수 없습니다. 직접 입력하세요.');
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (picks.length)
        setActive((at + (event.key === 'ArrowDown' ? 1 : -1) + picks.length) % picks.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const pick = picks[at];
      if (pick) choose(pick);
    }
  };
  const optionId = (index: number) => `${id}-${index}`;
  return (
    <Dialog
      title="브랜치 전환"
      description={repo.branch ? `현재 브랜치: ${repo.branch}` : undefined}
      size="small"
      className="git-branch-picker"
      close={close}
    >
      {error && <p role="alert">{error}</p>}
      <input
        role="combobox"
        aria-label="브랜치 찾기"
        aria-expanded
        aria-controls={`${id}-list`}
        aria-activedescendant={picks[at] ? optionId(at) : undefined}
        placeholder="브랜치 찾기, 또는 새 이름 입력"
        spellCheck={false}
        value={filter}
        onChange={(event) => {
          const typed = event.target.value;
          setFilter(typed);
          // Enter goes to the branch that was being looked for, once there is one to go to.
          setActive(typed.trim() && branchPicks(choices, typed).length > 1 ? 1 : 0);
        }}
        onKeyDown={onKey}
      />
      {!refs && !error && <p className="git-branch-picker-note">불러오는 중…</p>}
      <ul
        id={`${id}-list`}
        ref={list}
        role="listbox"
        aria-label="브랜치"
        className="git-branch-picker-list"
      >
        {picks.map((pick, index) => {
          const previous = picks[index - 1];
          const heading =
            pick.kind !== 'create' && previous?.kind !== pick.kind ? headings[pick.kind] : null;
          return (
            <li key={`${pick.kind}:${pick.name}`} role="presentation">
              {heading && (
                <div className="git-branch-picker-heading" role="presentation">
                  {heading}
                </div>
              )}
              <div
                id={optionId(index)}
                role="option"
                aria-selected={index === at}
                className="git-branch-picker-option"
                onPointerMove={() => setActive(index)}
                onClick={() => choose(pick)}
              >
                <Icon name={icons[pick.kind]} size={14} />
                <span className="git-branch-picker-name">
                  {pick.kind === 'create'
                    ? filter.trim()
                      ? `새 브랜치 만들기: ${filter.trim()}`
                      : '새 브랜치 만들기…'
                    : pick.name}
                </span>
                {hint(pick) && <small>{hint(pick)}</small>}
              </div>
            </li>
          );
        })}
      </ul>
      {refs && picks.length === 1 && filter.trim() === '' && (
        <p className="git-branch-picker-note">전환할 브랜치가 없습니다.</p>
      )}
    </Dialog>
  );
}
