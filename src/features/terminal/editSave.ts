import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { call, desktop, errorText } from '../../lib/ipc';
import type { ExternalEdit } from '../../lib/externalEdit';
import { sessionKind } from './sessionKind';
import type { TerminalSession } from './session';
import { programNotifier } from './terminalNotify';

export type EditSaveAnswer =
  | { action: 'upload' | 'cancel' | 'connectionAuto' | 'overwrite' | 'reload' }
  | { action: 'saveAs'; path: string };

type Owner = {
  readonly connectionId: string;
  readonly profile: { id: string };
  notice: (message: string) => void;
};

const pollMs = 1000;
const choices = {
  upload: 'retry',
  cancel: 'pause',
  overwrite: 'overwrite',
  reload: 'reload',
  saveAs: 'saveAs',
} as const;

/** `manual` was the user's own choice not to be asked, so only `ask` gets a card for a save. */
export const asksOnCard = (edit: ExternalEdit) =>
  edit.status === 'conflict' || (edit.status === 'pending' && edit.uploadMode === 'ask');

export const editFileName = (edit: ExternalEdit) => edit.remote.split('/').pop() ?? edit.remote;

/**
 * Edits waiting for an answer on a terminal tab, for the whole window.
 *
 * Not `AgentSignQueue`, though the card looks the same: a signature request arrives once on one
 * connection, is answered once, and is refused by the backend after a timeout. A saved edit has no
 * timeout and outlives its connection, so the backend's state is the only truth and this class
 * keeps reading it. A second press or a late poll must not bring an answered card back.
 */
export class EditSaveQueue {
  private latest: readonly ExternalEdit[] = [];
  private shown: readonly ExternalEdit[] = [];
  private listeners = new Set<() => void>();
  private answering = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private run = 0;
  private requested = 0;
  private applied = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.poll(++this.run);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.run++;
      clearTimeout(this.timer);
    };
  };
  snapshot = () => this.shown;
  private publish() {
    const shown = this.latest
      .filter((edit) => asksOnCard(edit) && !this.answering.has(edit.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(shown) === JSON.stringify(this.shown)) return;
    this.shown = shown;
    this.listeners.forEach((listener) => listener());
  }
  /** Waits for each answer before the next request, so a slow backend is not asked twice. */
  private async poll(run: number) {
    await this.refresh();
    if (run === this.run && desktop) this.timer = setTimeout(() => void this.poll(run), pollMs);
  }
  private async refresh() {
    if (!desktop) return;
    const request = ++this.requested;
    try {
      const edits = await call<ExternalEdit[]>('edit_list');
      // An older response than one already applied can only bring an answered card back.
      if (request < this.applied) return;
      this.applied = request;
      this.latest = edits;
      this.publish();
    } catch {
      /* A closed app has nothing to show; the next poll tries again. */
    }
  }
  /** The card leaves at once and returns only if the backend still has a question after this. */
  async answer(edit: ExternalEdit, answer: EditSaveAnswer, owner: Owner) {
    this.answering.add(edit.id);
    this.publish();
    const args = {
      id: edit.id,
      connectionId: owner.connectionId,
      profileId: owner.profile.id,
    };
    let failure: { error: unknown } | null = null;
    try {
      if (answer.action === 'connectionAuto') await call('edit_session_auto', args);
      else
        await call('edit_resolve', {
          ...args,
          choice: choices[answer.action],
          path: answer.action === 'saveAs' ? answer.path : null,
        });
    } catch (error) {
      failure = { error };
    }
    await this.refresh();
    this.answering.delete(edit.id);
    this.publish();
    // A new conflict is an outcome the backend recorded, and the card now asks about it.
    const conflict = this.latest.find((e) => e.id === edit.id)?.status === 'conflict';
    if (failure && (edit.status === 'conflict' || !conflict))
      owner.notice(errorText(failure.error));
  }
}

export const editSaves = new EditSaveQueue();

/**
 * The tab that shows an edit: the one on its connection. Once that connection has ended the edit
 * cannot name a tab, so any connected tab of the same session may answer and take it over.
 */
export function editForPane(
  edits: readonly ExternalEdit[],
  connectionId: string,
  profileId: string,
) {
  return (
    edits.find((edit) => edit.connectionId === connectionId) ??
    edits.find((edit) => !edit.connectionLive && edit.profileId === profileId) ??
    null
  );
}

const editDetail = (edit: ExternalEdit) =>
  `${edit.status === 'conflict' ? '서버 파일 변경 확인' : '업로드 확인'} · ${editFileName(edit)}`;

type NotifyHost = Pick<TerminalSession, 'terminal' | 'profile' | 'notice'>;

/** Only when the app is in the background; in front, the card itself is what the user sees. */
export function editNotifier(session: NotifyHost) {
  const notify = programNotifier({
    terminal: session.terminal,
    sessionName: () => session.profile.name,
    replaying: () => false,
    notice: (message) => session.notice(message),
  });
  return (edit: ExternalEdit) => {
    if (!document.hasFocus()) notify('blocked', editDetail(edit));
  };
}

const noSubscription = () => () => {};

export function useEditSavePrompt(session: TerminalSession) {
  // Other tab kinds have no server files to edit, so they do not start the polling.
  const remote = sessionKind(session) === 'ssh';
  const edits = useSyncExternalStore(
    remote ? editSaves.subscribe : noSubscription,
    editSaves.snapshot,
  );
  const edit = remote ? editForPane(edits, session.connectionId, session.profile.id) : null;
  const notify = useMemo(() => editNotifier(session), [session]);
  const asked = edit && `${edit.id}:${edit.status}`;
  useEffect(() => {
    if (asked && edit) notify(edit);
    // Once per question, not on each change of the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, notify]);
  return edit;
}
