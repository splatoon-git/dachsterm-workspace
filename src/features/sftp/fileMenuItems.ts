import type { MenuItem } from '../../components/ContextMenu';
import { modKey } from '../../lib/platform';

/** Menu items both file panels share. */
export const copyPathsItem = (paths: string[], fail: (message: string) => void): MenuItem => ({
  label: '전체 경로 복사',
  run: () =>
    void navigator.clipboard.writeText(paths.join('\n')).catch(() => fail('경로 복사 실패')),
});

export const fileKeys = { copy: modKey('C'), cut: modKey('X'), paste: modKey('V') };
