import { useState, useSyncExternalStore } from 'react';
import { FilePane } from '../features/editor/FilePane';
import { FileStatusItems } from '../features/editor/FileStatusItems';
import type { TerminalSession } from '../features/terminal/session';
import { sessionKind, sessionSource } from '../features/terminal/sessionKind';
import { sameSource, type Source } from '../lib/source';
import { PlainTab } from './GroupTabBar';
import type { Workspace } from './useWorkspaceLayout';
import { tabKey, type TabRef } from './workspaceLayout';
import { replacedPreview, type DocumentPlacement, type DocumentRef } from './workspaceTabs';

/** A file open in a tab, and the terminal tab it was opened from. */
type FileTab = {
  id: string;
  source: Source;
  path: string;
  name: string;
  sessionTabId: string;
  connectionId: string;
};

const keyOf = (id: string) => tabKey({ kind: 'file', id });
/** Only a Windows path uses a backslash as a separator; elsewhere it is part of a file name. */
const windowsPath = (path: string) => /^([A-Za-z]:|\\\\)/.test(path);
/**
 * A folder tree and a listing can spell one Windows path with different slashes, and macOS can
 * give the same Korean name in either Unicode form.
 */
const comparable = (path: string) =>
  (windowsPath(path) ? path.replaceAll('\\', '/') : path).normalize('NFC');
const nameOf = (path: string) => path.split(windowsPath(path) ? /[\\/]/ : '/').pop() || path;

const noSubscribe = () => () => {};
const noStatus = () => undefined;

function FileCell({ file, owner }: { file: FileTab; owner?: TerminalSession }) {
  const snapshot = useSyncExternalStore(
    owner?.subscribe ?? noSubscribe,
    owner?.snapshot ?? noStatus,
  );
  // A local file does not depend on the terminal. A server file needs the very connection it
  // came from: a reconnected tab has a new one.
  const live =
    file.source.kind === 'local' ||
    (owner?.connectionId === file.connectionId && snapshot?.status === 'connected');
  return (
    <FilePane id={file.id} source={file.source} path={file.path} name={file.name} live={live} />
  );
}

/** File tabs (GE.5), and where the file panels meet the workspace. */
export function useFileTabs({
  workspace,
  sessions,
  narrow,
}: {
  workspace: Workspace;
  sessions: TerminalSession[];
  narrow: boolean;
}) {
  const [files, setFiles] = useState<FileTab[]>([]);
  const find = (id: string) => files.find((file) => file.id === id);
  const open = (session: TerminalSession, path: string, pinned: boolean) => {
    const source = sessionSource(session);
    if (!source) return;
    const existing = files.find(
      (file) => sameSource(file.source, source) && comparable(file.path) === comparable(path),
    );
    if (existing) {
      workspace.openDocument({ kind: 'file', id: existing.id });
      if (pinned) workspace.pinDocument(keyOf(existing.id));
      return;
    }
    const id = crypto.randomUUID();
    const tab: DocumentRef = { kind: 'file', id, preview: !pinned };
    // An FTP tab is its own file list, which a click must not cover.
    const placement: DocumentPlacement =
      sessionKind(session) === 'ftp' && !narrow
        ? { keepVisible: tabKey({ kind: 'session', tabId: session.tabId }) }
        : {};
    const replaced = replacedPreview(workspace.layout, tab, placement);
    setFiles((old) => [
      ...old.filter((file) => keyOf(file.id) !== replaced),
      {
        id,
        source,
        path,
        name: nameOf(path),
        sessionTabId: session.tabId,
        connectionId: session.connectionId,
      },
    ]);
    workspace.openDocument(tab, placement);
  };
  const close = (key: string) => {
    const file = files.find((item) => keyOf(item.id) === key);
    if (!file) return false;
    setFiles((old) => old.filter((item) => item !== file));
    workspace.close(key);
    return true;
  };
  return {
    open,
    close,
    order: files.map((file): TabRef => ({ kind: 'file', id: file.id })),
    /** The terminal a focused file tab came from, so the sidebar stays on its connection. */
    owner: (key: string) => {
      const file = files.find((item) => keyOf(item.id) === key);
      return file && sessions.find((session) => session.tabId === file.sessionTabId);
    },
    status: (tab: TabRef | undefined) =>
      tab?.kind === 'file' ? <FileStatusItems id={tab.id} /> : undefined,
    renderTab: (tab: DocumentRef, active: boolean, select: () => void) => {
      const file = find(tab.id);
      const key = tabKey(tab);
      return (
        file && (
          <PlainTab
            tabKey={key}
            title={file.name}
            hint={file.path}
            italic={tab.preview}
            active={active}
            select={select}
            close={() => close(key)}
            onDoubleClick={() => workspace.pinDocument(key)}
          />
        )
      );
    },
    renderCell: (tab: DocumentRef) => {
      const file = find(tab.id);
      return (
        file && (
          <FileCell
            file={file}
            owner={sessions.find((session) => session.tabId === file.sessionTabId)}
          />
        )
      );
    },
  };
}
