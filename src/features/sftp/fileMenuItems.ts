import type { MenuItem } from '../../components/ContextMenu';

/** Menu items both file panels share. */
export const copyPathsItem = (paths: string[], fail: (message: string) => void): MenuItem => ({
  label: '전체 경로 복사',
  run: () =>
    void navigator.clipboard.writeText(paths.join('\n')).catch(() => fail('경로 복사 실패')),
});
