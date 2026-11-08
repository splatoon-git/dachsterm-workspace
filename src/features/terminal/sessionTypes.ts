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
/** A server asks the local agent to sign. Every text field is already plain and short. */
export type AgentSignRequest = {
  type: 'agentSign';
  request: string;
  session: string;
  key: string;
  fingerprint: string;
  loginUser: string | null;
  namespace: string | null;
  hostKey: string | null;
  /** `app`: a key file the app signs with. `system`: this PC's SSH agent signs. */
  source: 'app' | 'system';
  /** The key file is encrypted: allowing asks for its Passphrase on the card. */
  passphrase: boolean;
  seconds: number;
};
/** The server's git asks for an HTTPS credential. Every text field is already plain and short. */
export type GitCredentialRequest = {
  type: 'gitCredential';
  request: string;
  session: string;
  host: string;
  path: string | null;
  username: string | null;
  /** The server user's own Git helpers, which may keep the value after a push. */
  serverHelpers: string[];
  seconds: number;
};
export type SessionEvent =
  | { type: 'replay'; active: boolean }
  | AuthPrompt
  | AgentSignRequest
  | GitCredentialRequest
  | { type: 'agentNotice'; message: string }
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
  guideProgram?: GuideProgram | null;
  guideRun?: number;
  replaying?: boolean;
  /** A server's own address the user asked to open, waiting for their choice. */
  serverLink?: string;
};
