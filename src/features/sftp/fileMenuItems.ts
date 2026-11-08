import type { MenuItem } from '../../components/ContextMenu';
import { call, errorText } from '../../lib/ipc';
import { isMac } from '../../lib/platform';
import type { Source } from '../../lib/source';

/** Menu items both file panels share. */
export const copyPathsItem = (paths: string[], fail: (message: string) => void): MenuItem => ({
  label: '전체 경로 복사',
  run: () =>
    void navigator.clipboard.writeText(paths.join('\n')).catch(() => fail('경로 복사 실패')),
});

/** Shows one item of this computer in the file manager; `path` is undefined for several items. */
export const revealItem = (
  source: Source,
  path: string | undefined,
  fail: (message: string) => void,
): MenuItem => ({
  label: isMac ? 'Finder에서 보기' : '탐색기에서 보기',
  disabled: path === undefined,
  run: () => void call('files_reveal', { source, path }).catch((e) => fail(errorText(e))),
});
