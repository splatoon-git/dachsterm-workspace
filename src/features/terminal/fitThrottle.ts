/**
 * Runs once a terminal shown again has resumed rendering, and returns a cancel function. xterm stops
 * its renderer while hidden and restarts it from an IntersectionObserver, which fires at the end of
 * the first visible frame. A fit before that leaves the scroll range at the old height for good, and
 * new output then stays below the visible rows.
 */
export function afterRendererResumes(run: () => void) {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(run);
  });
  return () => cancelAnimationFrame(frame);
}

/**
 * Runs at once, then at most once per interval, and always once after the last call. Dragging a
 * divider resizes the screen every frame; this keeps the remote end from receiving each size while
 * still ending on the final one.
 */
export function throttleTrailing(run: () => void, interval: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  const tick = () => {
    if (!pending) {
      timer = undefined;
      return;
    }
    pending = false;
    run();
    timer = setTimeout(tick, interval);
  };
  return {
    call() {
      if (timer !== undefined) {
        pending = true;
        return;
      }
      run();
      timer = setTimeout(tick, interval);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = false;
    },
  };
}
