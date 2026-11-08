import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { UnsavedDialog } from '../features/editor/FileDialogs';
import { FilePane } from '../features/editor/FilePane';
import { GitDiffPane } from '../features/editor/GitDiffPane';
import { diffTabTitle, type GitDiffTarget } from '../features/editor/gitFileDiff';
import type { CommitFileOrigin } from '../features/git/commitGraphModel';
import type { DiffFile } from '../features/git/gitDiff';
import { repoFilePath, type GitRow } from '../features/git/gitViewModel';
import { FileStatusItems } from '../features/editor/FileStatusItems';
import { fileDocument, unsavedFileIds, useFileDirty } from '../features/editor/fileDocuments';
import type { TerminalSession } from '../features/terminal/session';
import { sessionKind, sessionSource } from '../features/terminal/sessionKind';
import { errorText } from '../lib/ipc';
import { sameSource, type Source } from '../lib/source';
import type { AppShortcut } from './appShortcuts';
import { chooseDocument, type PickedDocument } from './documentPicker';
import { commitDiffTarget, diffTargetOf, sameDiffTarget } from './gitDiffTabs';
import { PlainTab } from './GroupTabBar';
import type { Workspace } from './useWorkspaceLayout';
import { tabKey, type TabRef } from './workspaceLayout';
import { replacedPreview, type DocumentPlacement, type DocumentRef } from './workspaceTabs';

/** The terminal a file tab was opened from. A document from the tools menu has none. */
type FileOwner =
  { kind: 'terminal'; sessionTabId: string; connectionId: string } | { kind: 'none' };

/** A file open in a tab, and who it belongs to. */
type FileTab = {
  id: string;
  source: Source;
  path: string;
  name: string;
  owner: FileOwner;
  /** Present on a diff tab: what its two sides are. */
  diff?: GitDiffTarget;
};

/** Files waiting on the save question. `settle` answers a window close instead of closing tabs. */
type Closing = { ids: string[]; busy: boolean; settle?: (closed: boolean) => void };

const ownedBy = (session: TerminalSession): FileOwner => ({
  kind: 'terminal',
  sessionTabId: session.tabId,
  connectionId: session.connectionId,
});
const refOf = (file: FileTab): DocumentRef => ({ kind: file.diff ? 'diff' : 'file', id: file.id });
const keyOf = (file: FileTab) => tabKey(refOf(file));
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

function FileCell({
  file,
  owner,
  pin,
  renamed,
}: {
  file: FileTab;
  owner?: TerminalSession;
  pin: () => void;
  renamed: (path: string) => void;
}) {
  const snapshot = useSyncExternalStore(
    owner?.subscribe ?? noSubscribe,
    owner?.snapshot ?? noStatus,
  );
  // A tab with no terminal has no connection to lose, and a local file does not depend on the
  // terminal. A server file needs the very connection it came from: a reconnected tab has a new one.
  const live =
    file.owner.kind === 'none' ||
    file.source.kind === 'local' ||
    (owner?.connectionId === file.owner.connectionId && snapshot?.status === 'connected');
  if (file.diff)
    return (
      <GitDiffPane
        id={file.id}
        source={file.source}
        target={file.diff}
        path={file.path}
        name={file.name}
        live={live}
        pin={pin}
      />
    );
  return (
    <FilePane
      id={file.id}
      source={file.source}
      path={file.path}
      name={file.name}
      live={live}
      pin={pin}
      renamed={renamed}
    />
  );
}

function FileTabHeader({
  file,
  italic,
  active,
  select,
  close,
  pin,
}: {
  file: FileTab;
  italic?: boolean;
  active: boolean;
  select: () => void;
  close: () => void;
  pin: () => void;
}) {
  const dirty = useFileDirty(file.id);
  return (
    <PlainTab
      tabKey={keyOf(file)}
      title={file.diff ? diffTabTitle(file.name, file.diff.compare) : file.name}
      hint={file.path}
      italic={italic}
      dirty={dirty}
      active={active}
      select={select}
      close={close}
      onDoubleClick={pin}
    />
  );
}

/** File tabs (GE.5), and where the file panels meet the workspace. */
export type FileTabOpeners = Pick<
  ReturnType<typeof useFileTabs>,
  'open' | 'openDiff' | 'openCommitFile'
>;

export function useFileTabs({
  workspace,
  sessions,
  narrow,
  fail,
}: {
  workspace: Workspace;
  sessions: TerminalSession[];
  narrow: boolean;
  /** Reports what kept the tools menu from opening a document. */
  fail: (message: string) => void;
}) {
  const [files, setFiles] = useState<FileTab[]>([]);
  const [closing, setClosing] = useState<Closing | null>(null);
  /** Set once the user chose to leave unsaved work, so a reload is not refused after that. */
  const leaving = useRef(false);
  const find = (id: string) => files.find((file) => file.id === id);
  const fileOf = (key: string) => files.find((item) => keyOf(item) === key);
  const sessionOf = ({ owner }: FileTab) =>
    owner.kind === 'terminal'
      ? sessions.find((session) => session.tabId === owner.sessionTabId)
      : undefined;
  const openedFile = (source: Source, path: string) =>
    files.find(
      (file) =>
        !file.diff && sameSource(file.source, source) && comparable(file.path) === comparable(path),
    );
  const focused = fileOf(workspace.focusedGroup.active);
  const focusedId = focused?.id;
  /** A diff is tied to its file in the repository, so Ctrl+Shift+S keeps its usual meaning there. */
  const savesAs = !!focused && !focused.diff;

  useEffect(() => {
    if (!focusedId) return;
    // On the window, not the editor, so it also works from a Markdown preview or the tab header.
    const onKey = (e: KeyboardEvent) => {
      const save = e.code === 'KeyS' && (e.ctrlKey || e.metaKey) && !e.altKey;
      if (!save || document.querySelector('dialog[open]') || (e.shiftKey && !savesAs)) return;
      e.preventDefault();
      const document_ = fileDocument(focusedId);
      if (e.shiftKey) document_?.saveAs();
      else void document_?.save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedId, savesAs]);

  const show = (tab: DocumentRef, placement: DocumentPlacement, file: FileTab) => {
    const replaced = replacedPreview(workspace.layout, tab, placement);
    setFiles((old) => [...old.filter((item) => keyOf(item) !== replaced), file]);
    workspace.openDocument(tab, placement);
  };
  const showExisting = (file: FileTab, pinned: boolean) => {
    workspace.openDocument(refOf(file));
    if (pinned) workspace.pinDocument(keyOf(file));
  };
  const open = (session: TerminalSession, path: string, pinned: boolean) => {
    const source = sessionSource(session);
    if (!source) return;
    const existing = openedFile(source, path);
    if (existing) return showExisting(existing, pinned);
    const id = crypto.randomUUID();
    const tab: DocumentRef = { kind: 'file', id, preview: !pinned };
    // An FTP tab is its own file list, which a click must not cover.
    const placement: DocumentPlacement =
      sessionKind(session) === 'ftp' && !narrow
        ? { keepVisible: tabKey({ kind: 'session', tabId: session.tabId }) }
        : {};
    show(tab, placement, { id, source, path, name: nameOf(path), owner: ownedBy(session) });
  };
  /** A deliberate choice in the OS picker, so it is pinned rather than a preview. */
  const openPicked = ({ source, path }: PickedDocument) => {
    const existing = openedFile(source, path);
    if (existing) return showExisting(existing, true);
    const id = crypto.randomUUID();
    // macOS gives a Korean name decomposed. The path stays as it is, since it names the real file.
    const name = nameOf(path).normalize('NFC');
    show(
      { kind: 'file', id, preview: false },
      {},
      { id, source, path, name, owner: { kind: 'none' } },
    );
  };
  // The picker can stay open for a long time, and the tabs can change while it does.
  const latestOpenPicked = useRef(openPicked);
  useEffect(() => {
    latestOpenPicked.current = openPicked;
  });
  const pickDocument = () => {
    chooseDocument().then(
      (picked) => {
        if (picked) latestOpenPicked.current(picked);
      },
      (e: unknown) => fail(errorText(e)),
    );
  };
  const showDiff = (session: TerminalSession, diff: GitDiffTarget | null, pinned: boolean) => {
    const source = sessionSource(session);
    if (!source || !diff) return;
    const existing = files.find(
      (file) => file.diff && sameSource(file.source, source) && sameDiffTarget(file.diff, diff),
    );
    if (existing) return showExisting(existing, pinned);
    const id = crypto.randomUUID();
    show(
      { kind: 'diff', id, preview: !pinned },
      {},
      {
        id,
        source,
        path: repoFilePath(diff.folder, diff.path),
        name: nameOf(diff.path),
        owner: ownedBy(session),
        diff,
      },
    );
  };
  /** Opens what a Git view row compares. A row with no diff, such as a conflict, opens nothing. */
  const openDiff = (session: TerminalSession, row: GitRow, root: string, pinned: boolean) =>
    showDiff(session, diffTargetOf(row, root), pinned);
  const openCommitFile = (
    session: TerminalSession,
    file: DiffFile,
    origin: CommitFileOrigin,
    root: string,
    pinned: boolean,
  ) => showDiff(session, commitDiffTarget(file, origin, root), pinned);
  const closeTabs = (ids: string[]) => {
    const closed = files.filter((item) => ids.includes(item.id));
    setFiles((old) => old.filter((item) => !ids.includes(item.id)));
    closed.forEach((file) => workspace.close(keyOf(file)));
  };
  const close = (key: string) => {
    const file = fileOf(key);
    if (!file) return false;
    if (!fileDocument(file.id)?.dirty) {
      closeTabs([file.id]);
      return true;
    }
    // Asked once for several tabs, as "close other tabs" closes them one by one.
    setClosing((old) =>
      old ? { ...old, ids: [...old.ids, file.id] } : { ids: [file.id], busy: false },
    );
    return true;
  };
  const answerClosing = (done: Closing, closed: boolean, tabs: string[]) => {
    setClosing(null);
    if (done.settle) done.settle(closed);
    else closeTabs(tabs);
  };
  const saveClosing = async (current: Closing) => {
    setClosing({ ...current, busy: true });
    const outcomes = await Promise.all(
      current.ids.map((id) => fileDocument(id)?.save() ?? Promise.resolve('failed' as const)),
    );
    const saved = current.ids.filter((_, index) => outcomes[index] === 'saved');
    const failed = current.ids.filter((id) => !saved.includes(id));
    answerClosing(current, !failed.length, saved);
    // A conflict or an error is shown on the tab itself.
    const firstFailed = find(failed[0]);
    if (firstFailed) workspace.openDocument(refOf(firstFailed));
  };
  const closingNames = closing?.ids.map((id) => find(id)?.name ?? '');
  const dialog = closing && closingNames && (
    <UnsavedDialog
      names={closingNames}
      canSave={closing.ids.every((id) => fileDocument(id)?.canSave)}
      busy={closing.busy}
      save={() => void saveClosing(closing)}
      discard={() => {
        if (closing.settle) leaving.current = true;
        answerClosing(closing, true, closing.ids);
      }}
      cancel={() => answerClosing(closing, false, [])}
    />
  );
  return {
    open,
    pickDocument,
    openDiff,
    openCommitFile,
    close,
    dialog,
    /** Asks about unsaved files before the window closes. */
    confirmWindowClose: () => {
      const ids = unsavedFileIds();
      if (!ids.length) return Promise.resolve(true);
      return new Promise<boolean>((settle) => setClosing({ ids, busy: false, settle }));
    },
    hasUnsaved: () => !leaving.current && unsavedFileIds().length > 0,
    /** Ctrl+Shift+S is "save as" while a file tab has the focus. */
    keepsShortcut: (shortcut: AppShortcut) => shortcut.name === 'commands' && savesAs,
    reloadable: (key: string) => !!fileOf(key) && !!fileDocument(fileOf(key)!.id),
    reload: (key: string) => {
      const file = fileOf(key);
      if (file) fileDocument(file.id)?.reload();
    },
    order: files.map((file): TabRef => refOf(file)),
    /** The terminal a focused file tab came from, so the sidebar stays on its connection. */
    owner: (key: string) => {
      const file = fileOf(key);
      return file && sessionOf(file);
    },
    status: (tab: TabRef | undefined) =>
      tab?.kind === 'file' ? <FileStatusItems id={tab.id} /> : undefined,
    renderTab: (tab: DocumentRef, active: boolean, select: () => void) => {
      const file = find(tab.id);
      const key = tabKey(tab);
      return (
        file && (
          <FileTabHeader
            file={file}
            italic={tab.preview}
            active={active}
            select={select}
            close={() => close(key)}
            pin={() => workspace.pinDocument(key)}
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
            owner={sessionOf(file)}
            pin={() => workspace.pinDocument(tabKey(tab))}
            renamed={(path) =>
              setFiles((old) =>
                old.map((item) =>
                  item.id === file.id ? { ...item, path, name: nameOf(path) } : item,
                ),
              )
            }
          />
        )
      );
    },
  };
}
