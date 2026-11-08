import type { LocalCatalog } from '../features/terminal/sessionTypes';
import { call, UserError } from '../lib/ipc';
import type { Source } from '../lib/source';

export type PickedDocument = { source: Source; path: string };

/** Asks the OS for a file of this PC. Null when the file picker was closed. */
export async function chooseDocument(): Promise<PickedDocument | null> {
  const path = await call<string | null>('local_file_pick');
  if (!path) return null;
  // Asked now because the list from app start can be missing or stale, and the backend only reads
  // a target it listed.
  const { targets } = await call<LocalCatalog>('local_targets');
  // Any shell of this PC reads the same files, and a WSL target would expect a Linux path.
  const shell = targets.find((target) => target.kind !== 'wsl');
  if (!shell) throw new UserError('이 PC의 로컬 셸을 찾지 못해 파일을 열 수 없습니다.');
  return { source: { kind: 'local', targetId: shell.id }, path };
}
