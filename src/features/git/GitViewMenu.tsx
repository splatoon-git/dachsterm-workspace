import { useState } from 'react';
import {
  ContextMenu,
  anchorBelow,
  type MenuItem,
  type MenuPoint,
} from '../../components/ContextMenu';
import { call, errorText } from '../../lib/ipc';
import type { GitRow, GitViewRepo } from './gitViewModel';

type Open = { at: MenuPoint; label: string; items: MenuItem[] };

const point = (at: MenuPoint | HTMLElement): MenuPoint =>
  at instanceof HTMLElement ? anchorBelow(at) : at;

/** The `⋯` menu and the file rows' right-click menu. Actions that change the repository are GE.9. */
export function useGitViewMenu({
  repo,
  tree,
  setTree,
  refresh,
  review,
  configure,
  notice,
}: {
  repo: GitViewRepo | null;
  tree: boolean;
  setTree: (tree: boolean) => void;
  refresh: () => void;
  /** Absent where the tab cannot open a change review. */
  review?: () => void;
  /** Opens this repository's own `git config`. Absent outside a repository. */
  configure?: () => void;
  notice: (text: string) => void;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const more = (anchor: HTMLElement) =>
    setOpen({
      at: anchorBelow(anchor),
      label: 'Git 더 보기',
      items: [
        { label: '새로 고침', run: refresh },
        ...(review ? [{ label: '변경 검토', run: review, separated: true }] : []),
        {
          label: tree ? '목록으로 보기' : '폴더로 묶어 보기',
          run: () => setTree(!tree),
          separated: true,
        },
        ...(configure ? [{ label: '이 저장소의 Git 설정…', run: configure }] : []),
      ],
    });
  const row = (file: GitRow, at: MenuPoint | HTMLElement) => {
    if (!repo) return;
    const path = `${repo.root.replace(/\/+$/, '')}/${file.path}`;
    setOpen({
      at: point(at),
      label: `${file.path} 작업`,
      items: [
        {
          label: '경로 복사',
          disabled: !file.readable,
          run: () =>
            void call('clipboard_write_text', { text: path }).catch((e) => notice(errorText(e))),
        },
      ],
    });
  };
  const menu = open && (
    <ContextMenu at={open.at} items={open.items} label={open.label} close={() => setOpen(null)} />
  );
  return { more, row, menu };
}
