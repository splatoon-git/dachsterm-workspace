import { useState } from 'react';
import {
  ContextMenu,
  anchorBelow,
  type MenuItem,
  type MenuPoint,
} from '../../components/ContextMenu';
import { call, errorText } from '../../lib/ipc';
import type { GitGroup, GitRow, GitViewRepo } from './gitViewModel';
import { groupItems, rowItems, type FileActions } from './gitWriteMenu';
import { networkCommands, type GitDialogRequest } from './gitWrite';
import type { GitWrite } from './useGitWrite';

type Open = { at: MenuPoint; label: string; items: MenuItem[] };

const point = (at: MenuPoint | HTMLElement): MenuPoint =>
  at instanceof HTMLElement ? anchorBelow(at) : at;

/** The `⋯` menu, the commit button's menu and the right-click menus of files and groups. */
export function useGitViewMenu({
  repo,
  groups,
  tree,
  setTree,
  refresh,
  review,
  configure,
  notice,
  write,
  ask,
}: {
  repo: GitViewRepo | null;
  groups: GitGroup[];
  tree: boolean;
  setTree: (tree: boolean) => void;
  refresh: () => void;
  /** Absent where the tab cannot open a change review. */
  review?: () => void;
  /** Opens this repository's own `git config`. Absent outside a repository. */
  configure?: () => void;
  notice: (text: string) => void;
  write: GitWrite;
  ask: (request: GitDialogRequest) => void;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const files: FileActions = {
    busy: write.busy,
    stage: (paths) => void write.apply({ kind: 'stage', paths }),
    unstage: (paths) => void write.apply({ kind: 'unstage', paths }),
    discard: (target) => ask({ kind: 'discard', target }),
  };
  const repoItems = (current: GitViewRepo): MenuItem[] => {
    const type = (command: string) => () => void write.runInTerminal(command);
    const disabled = write.busy;
    const staged = groups.some((group) => group.id === 'staged');
    return [
      { label: 'fetch', separated: true, run: type(networkCommands.fetch) },
      { label: 'pull', run: type(networkCommands.pull) },
      { label: 'push', run: type(networkCommands.push) },
      {
        label: 'push 강제(안전)…',
        danger: true,
        disabled: !current.branch,
        run: () => ask({ kind: 'forcePush' }),
      },
      {
        label: '브랜치 전환…',
        separated: true,
        disabled,
        run: () => ask({ kind: 'checkout' }),
      },
      { label: '새 브랜치…', disabled, run: () => ask({ kind: 'branchCreate' }) },
      { label: '태그…', disabled: disabled || !current.oid, run: () => ask({ kind: 'tag' }) },
      {
        label: 'stash 넣기…',
        separated: true,
        disabled: disabled || !current.oid,
        run: () => ask({ kind: 'stash' }),
      },
      {
        label: 'stash 꺼내기',
        disabled,
        run: () => void write.apply({ kind: 'stashPop' }),
      },
      {
        label: '모두 스테이지',
        separated: true,
        disabled: disabled || !current.entries.length,
        run: () => files.stage(null),
      },
      {
        label: '모두 스테이지 취소',
        disabled: disabled || !staged,
        run: () => files.unstage(null),
      },
    ];
  };
  const more = (anchor: HTMLElement) =>
    setOpen({
      at: anchorBelow(anchor),
      label: 'Git 더 보기',
      items: [
        { label: '새로 고침', run: refresh },
        ...(repo ? repoItems(repo) : []),
        ...(review ? [{ label: '변경 검토', run: review, separated: true }] : []),
        {
          label: tree ? '목록으로 보기' : '폴더로 묶어 보기',
          run: () => setTree(!tree),
          separated: true,
        },
        ...(configure ? [{ label: '이 저장소의 Git 설정…', run: configure }] : []),
      ],
    });
  const commitMore = (anchor: HTMLElement) =>
    setOpen({
      at: anchorBelow(anchor),
      label: '커밋 더 보기',
      items: [
        {
          label: '이전 커밋 고치기 (--amend)',
          disabled: !repo?.oid,
          run: () => {
            const message = write.draft;
            void write.apply({ kind: 'commit', message, amend: true }).then((done) => {
              if (done) write.setDraft('');
            });
          },
        },
      ],
    });
  const row = (file: GitRow, at: MenuPoint | HTMLElement) => {
    if (!repo) return;
    const path = `${repo.root.replace(/\/+$/, '')}/${file.path}`;
    setOpen({
      at: point(at),
      label: `${file.path} 작업`,
      items: [
        ...rowItems(file, files),
        {
          label: '경로 복사',
          separated: true,
          disabled: !file.readable,
          run: () =>
            void call('clipboard_write_text', { text: path }).catch((e) => notice(errorText(e))),
        },
      ],
    });
  };
  const group = (target: GitGroup, at: MenuPoint | HTMLElement) => {
    const items = groupItems(target, files);
    if (items.length) setOpen({ at: point(at), label: `${target.label} 작업`, items });
  };
  const menu = open && (
    <ContextMenu at={open.at} items={open.items} label={open.label} close={() => setOpen(null)} />
  );
  return { more, commitMore, row, group, menu };
}
