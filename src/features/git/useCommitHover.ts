import { useCallback, useEffect, useRef, useState } from 'react';

const showDelay = 350;
/** Long enough to move the pointer from the row onto the card. */
const hideDelay = 150;

export type CommitHover<T> = { item: T; rect: DOMRect };

/** Which row's card is showing. The pointer can leave the row for the card without closing it. */
export function useCommitHover<T>() {
  const [hover, setHover] = useState<CommitHover<T> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keep = useCallback(() => clearTimeout(timer.current), []);
  useEffect(() => keep, [keep]);
  const show = useCallback(
    (item: T, element: HTMLElement) => {
      keep();
      timer.current = setTimeout(
        () => setHover({ item, rect: element.getBoundingClientRect() }),
        showDelay,
      );
    },
    [keep],
  );
  const hide = useCallback(() => {
    keep();
    timer.current = setTimeout(() => setHover(null), hideDelay);
  }, [keep]);
  const close = useCallback(() => {
    keep();
    setHover(null);
  }, [keep]);
  return { hover, show, keep, hide, close };
}
