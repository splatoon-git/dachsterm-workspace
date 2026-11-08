import type { MenuItem } from '../../components/ContextMenu';
import type { IconName } from '../../components/Icon';
import type { DiscardTarget } from './gitWrite';
import type { GitGroup, GitRow } from './gitViewModel';

/** A menu item that can also be a button on its row. */
export type GitActionItem = MenuItem & { icon: IconName };

/** What the Git view's menus can do to files. */
export type FileActions = {
  busy: boolean;
  stage(paths: string[] | null): void;
  unstage(paths: string[] | null): void;
  discard(target: DiscardTarget): void;
};

/** A staged rename is two index entries, and unstaging only the new name would leave the delete. */
const unstagePaths = (row: GitRow) => (row.oldPath ? [row.path, row.oldPath] : [row.path]);

/** A file's own actions. A name that is not UTF-8 is not the real one, so it can only be read. */
export function rowItems(row: GitRow, actions: FileActions): GitActionItem[] {
  const disabled = actions.busy || !row.readable;
  if (row.group === 'staged')
    return [
      {
        label: '스테이지 취소',
        icon: 'minus',
        disabled,
        run: () => actions.unstage(unstagePaths(row)),
      },
    ];
  if (row.group === 'conflict')
    return [
      {
        label: '해결됨으로 스테이지',
        icon: 'plus',
        disabled,
        run: () => actions.stage([row.path]),
      },
    ];
  const stage: GitActionItem = {
    label: '스테이지',
    icon: 'plus',
    disabled,
    run: () => actions.stage([row.path]),
  };
  return row.group === 'untracked'
    ? [
        stage,
        {
          label: '파일 삭제…',
          icon: 'trash',
          danger: true,
          disabled,
          run: () => actions.discard({ paths: [], untracked: [row.path] }),
        },
      ]
    : [
        stage,
        {
          label: '변경 버리기…',
          icon: 'undo',
          danger: true,
          disabled,
          run: () => actions.discard({ paths: [row.path], untracked: [] }),
        },
      ];
}

/** A group's actions, on exactly the files it lists. Only unstaging all has no list to get wrong. */
export function groupItems(group: GitGroup, actions: FileActions): GitActionItem[] {
  const paths = group.rows.filter((row) => row.readable).map((row) => row.path);
  const omitted = group.rows.length - paths.length;
  const disabled = actions.busy || !paths.length;
  if (group.id === 'staged')
    return [
      {
        label: '모두 스테이지 취소',
        icon: 'minus',
        disabled: actions.busy,
        run: () => actions.unstage(null),
      },
    ];
  if (group.id === 'conflict') return [];
  const stage: GitActionItem = {
    label: '모두 스테이지',
    icon: 'plus',
    disabled,
    run: () => actions.stage(paths),
  };
  return group.id === 'untracked'
    ? [
        stage,
        {
          label: '추적 안 함 파일 모두 삭제…',
          icon: 'trash',
          danger: true,
          disabled,
          run: () => actions.discard({ paths: [], untracked: paths, omitted }),
        },
      ]
    : [
        stage,
        {
          label: '변경 모두 버리기…',
          icon: 'undo',
          danger: true,
          disabled,
          run: () => actions.discard({ paths, untracked: [], omitted }),
        },
      ];
}
