import type { ReactNode } from 'react';

/** What every document viewer is given. Each one is loaded only when a file of its kind opens. */
export type ViewerProps = {
  bytes: Uint8Array;
  path: string;
  name: string;
  /** Buttons for the right end of the viewer's bar. */
  actions?: ReactNode;
  /** The document cannot be drawn. The message is shown in its place, with a way to open it. */
  fail: (message: string) => void;
};
