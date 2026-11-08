import type { PointerEvent as ReactPointerEvent } from 'react';
import { whileDraggingOut } from '../../lib/fileDrop';
import { call, desktop, errorText } from '../../lib/ipc';
import type { Source } from '../../lib/source';
import { withoutNested } from './fileList';

type Point = { x: number; y: number };

/** The same distance the OS waits for, so a slightly unsteady click stays a click. */
const startDistance = 5;
export const farEnough = (from: Point, to: Point) =>
  Math.hypot(to.x - from.x, to.y - from.y) >= startDistance;

/** A drag carries the selection when it starts on a selected row, otherwise only that row. */
export function dragNames(row: string, selection: string[]) {
  return selection.includes(row) ? withoutNested(selection) : [row];
}

/**
 * Drags rows of a file list out to the OS. The list gets one handler, and each row names itself
 * with `data-file-name`. The page cannot start an OS drag, so the app does it past the distance.
 */
export function useFileDragOut(
  source: Source | null,
  pathOf: (name: string) => string,
  selection: string[],
  fail: (message: string) => void,
) {
  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      '.file-row[data-file-name]:not(:disabled)',
    );
    const name = row?.dataset.fileName;
    if (!desktop || !source || event.button !== 0 || name === undefined) return;
    const from = { x: event.clientX, y: event.clientY };
    let released = false;
    const stopWatching = () => {
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    const release = () => {
      released = true;
      stopWatching();
    };
    const moved = (move: PointerEvent) => {
      if (!farEnough(from, { x: move.clientX, y: move.clientY })) return;
      window.removeEventListener('pointermove', moved);
      void whileDraggingOut(async () => {
        const paths = dragNames(name, selection).map(pathOf);
        const id = await call<string>('files_drag_prepare', { source, paths });
        if (released) {
          if (source.kind !== 'local')
            fail('파일을 받는 동안 버튼을 놓아 끌기를 취소했습니다. 누른 채로 기다려 주세요.');
          return;
        }
        await call('files_drag_out', { id });
      })
        .catch((e) => fail(errorText(e)))
        .finally(stopWatching);
    };
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  }
  return { onPointerDown };
}
