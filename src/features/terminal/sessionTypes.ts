import type { DirectoryHookStatus } from './directoryHook';
import type { GuideProgram } from './guideData';

export type PodTreeLaunch = {
  location: { kind: 'ssh' | 'local'; id: string };
  context: string;
  namespace: string;
  operational: boolean;
};
export type LocalTarget = {
  id: string;
  name: string;
  kind: 'shell' | 'wsl';
  follow: 'launch' | 'typed' | 'none';
};
export type LocalCatalog = { targets: LocalTarget[]; warning: string | null };
type HostKey = {
  type: 'hostKey';
  challenge: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
};
export type AuthPrompt = {
  type: 'authPrompt';
  challenge: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
};
export type SessionEvent =
  | { type: 'replay'; active: boolean }
  | AuthPrompt
  | HostKey
  | { type: 'state'; status: string; message: string }
  | { type: 'data'; seq: number; bytes: number[] };
export type SessionState = {
  status: string;
  message: string;
  hostKey: HostKey | null;
  authPrompt?: AuthPrompt | null;
  directory?: string | null;
  directoryHook?: DirectoryHookStatus;
  guideEnabled?: boolean;
  guideProgram?: GuideProgram | null;
  guideRun?: number;
  replaying?: boolean;
  /** A server's own address the user asked to open, waiting for their choice. */
  serverLink?: string;
};
