import type { MenuItem } from '../components/ContextMenu';
import { call, errorText } from './ipc';
import { isMac } from './platform';
import type { Source } from './source';

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
