import { createContext, useContext } from 'react';
import type { WorkerCell, WorkerSummary, WorkerWatch } from './workers';

/**
 * Worker watching as the screens see it. A context rather than props because the tree is memoized
 * and redraws only for new tree data, while this changes on its own schedule.
 */
export type Workers = {
  summaries: WorkerSummary[];
  cells: Map<string, WorkerCell>;
  /** Pods left out by the limit on how many are read. */
  capped: number;
  watchOf: (key: string) => WorkerWatch | null;
  setWatch: (watch: WorkerWatch) => void;
  removeWatch: (key: string) => void;
  pinsOf: (key: string) => string[];
  togglePin: (key: string, selector: string) => void;
  hasConsent: (key: string) => boolean;
  grantConsent: (key: string) => void;
};

const nobody: Workers = {
  summaries: [],
  cells: new Map(),
  capped: 0,
  watchOf: () => null,
  setWatch: () => undefined,
  removeWatch: () => undefined,
  pinsOf: () => [],
  togglePin: () => undefined,
  hasConsent: () => false,
  grantConsent: () => undefined,
};

export const WorkersContext = createContext<Workers>(nobody);
export const useWorkers = () => useContext(WorkersContext);
