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
