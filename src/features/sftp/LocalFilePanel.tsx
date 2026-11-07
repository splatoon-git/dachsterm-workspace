import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import type { LocalTarget, TerminalSession } from '../terminal/session';
import { childPath, selectionAfterClick, withoutNested, type FileEntry } from './fileList';
import { ContextMenu, type MenuPoint } from '../../components/ContextMenu';
import { FileAction, FilePathBar, FileTreeRow, formatBytes, useFileTree } from './fileTree';
import { FollowControl, useDirectoryFollow } from './follow';
import {
  LocalFileDialog,
  saveEditor,
  savedEditor,
  savedEditorArgs,
  type LocalFileOperation,
} from './LocalFileDialog';

type Listing = { path: string; entries: FileEntry[] };
type Outcome = { completed: string[]; errors: string[] };
type Clipboard = { targetId: string; operation: 'copy' | 'move'; paths: string[] };

// The panel remounts per tab, and pasting into another tab's folder must still work.
let sharedClipboard: Clipboard | null = null;
const shareClipboard = (value: Clipboard | null) => {
  sharedClipboard = value;
};

export function LocalFilePanel({
  session,
  target,
}: {
  session: TerminalSession;
  target: LocalTarget;
}) {
  const targetId = target.id;
  const [listing, setListing] = useState<Listing>({ path: '', entries: [] });
  const [path, setPath] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('name');
  const [selection, setSelection] = useState<string[]>([]);
  const [clipboard, setClipboardState] = useState(sharedClipboard);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<LocalFileOperation | null>(null);
  const anchor = useRef('');
  const requestId = useRef(0);
  const [context, setContext] = useState<MenuPoint | null>(null);
  const load = useCallback(
    async (next: string) => {
      const request = ++requestId.current;
      setBusy(true);
      setError('');
      try {
        const data = await call<Listing>('local_files_list', { targetId, path: next });
        if (request !== requestId.current) return;
        setListing(data);
        setPath(data.path);
        setSelection([]);
        session.rememberFileLocation(data.path);
      } catch (e) {
        if (request === requestId.current) setError(errorText(e));
      } finally {
        if (request === requestId.current) setBusy(false);
      }
    },
    [session, targetId],
  );
  const { follow, setFollow } = useDirectoryFollow(session, load);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const start =
        session.fileLocation() ?? (await call<string>('local_files_home', { targetId }));
      // The terminal's own directory wins once it has reported one.
      if (alive && !(session.wantsDirectoryFollow() && session.snapshot().directory))
        await load(start);
    })().catch((e) => {
      if (alive) setError(errorText(e));
    });
    return () => {
      alive = false;
    };
  }, [load, session, targetId]);
  const view = useMemo(() => ({ showHidden, filter, sort }), [showHidden, filter, sort]);
  const listFolder = useCallback(
    (folder: string) => call<Listing>('local_files_list', { targetId, path: folder }),
    [targetId],
  );
  const { rows, toggle } = useFileTree(listing, view, listFolder);
  const selectedPaths = withoutNested(selection).map((name) => childPath(listing.path, name));
  const selected = selection.length === 1 ? rows.find((e) => e.name === selection[0]) : undefined;
  function setClipboard(value: Clipboard | null) {
    shareClipboard(value);
    setClipboardState(value);
  }
  async function runBatch(kind: 'copy' | 'move' | 'delete', paths: string[], source = targetId) {
    const result = await call<Outcome>('local_files_batch', {
      sourceTargetId: source,
      targetId,
      operation: kind,
      paths,
      directory: kind === 'delete' ? null : listing.path,
    });
    await load(listing.path);
    setError(result.errors.join('\n'));
    return result;
  }
  function remember(kind: 'copy' | 'move') {
    setContext(null);
    if (selection.length) setClipboard({ targetId, operation: kind, paths: selectedPaths });
  }
  async function paste() {
    setContext(null);
    if (!clipboard) return;
    const { operation: kind, paths, targetId: source } = clipboard;
    try {
      const result = await runBatch(kind, paths, source);
      if (kind === 'move') {
        const remaining = paths.filter((p) => !result.completed.includes(p));
        setClipboard(remaining.length ? { ...clipboard, paths: remaining } : null);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }
  function ask(next: LocalFileOperation) {
    setContext(null);
    setError('');
    setOperation(next);
  }
  function fileKey(event: React.KeyboardEvent) {
    if ((event.target as HTMLElement).closest('input,select,textarea')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && ['c', 'x', 'v', 'a'].includes(key)) {
      event.preventDefault();
      if (key === 'c') remember('copy');
      else if (key === 'x') remember('move');
      else if (key === 'v') void paste();
      else setSelection(rows.map((e) => e.name));
    } else if (event.key === 'Delete' && selection.length) {
      event.preventDefault();
      ask({ kind: 'delete' });
    } else if (event.key === 'F2' && selected) {
      event.preventDefault();
      ask({ kind: 'rename', value: selected.name });
    } else if (event.key === 'F5') {
      event.preventDefault();
      void load(listing.path);
    } else if (event.key === 'Escape') setContext(null);
  }
  async function perform(current: LocalFileOperation) {
    if (current.kind === 'delete')
      return (await runBatch('delete', selectedPaths)).errors.length === 0;
    if (current.kind === 'edit') {
      await call('local_files_edit', {
        targetId,
        path: selectedPaths[0],
        program: current.program,
        args: savedEditorArgs(),
      });
      saveEditor(current.program);
      return true;
    }
    const renaming = current.kind === 'rename';
    await call('local_files_change', {
      targetId,
      operation: current.kind,
      path: renaming ? selectedPaths[0] : childPath(listing.path, current.value),
      value: renaming ? childPath(listing.path, current.value) : null,
    });
    await load(listing.path);
    return true;
  }
  async function submit() {
    if (!operation) return;
    try {
      if (await perform(operation)) setOperation(null);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const editable = !!selected && !selected.directory;
  return (
    <aside className="files" aria-label="로컬 파일 탐색" onKeyDown={fileKey}>
      <div className="file-header" title={target.name}>
        <span className="status-dot online" />
        <span className="file-header-name">{target.name}</span>
        <span className="protocol">{target.kind === 'wsl' ? 'WSL' : 'LOCAL'}</span>
      </div>
      <FilePathBar
        label="로컬 경로"
        value={path}
        busy={busy}
        change={setPath}
        submit={() => void load(path)}
      />
      <div className="file-actions" role="group" aria-label="파일 작업">
        <FileAction
          label="상위 폴더"
          icon="up"
          onClick={() => void load(childPath(listing.path, '..'))}
        />
        <FileAction label="파일 새로 고침" icon="refresh" onClick={() => void load(listing.path)} />
        <span className="file-actions-gap" />
        <FileAction
          label="폴더"
          icon="folderPlus"
          onClick={() => ask({ kind: 'mkdir', value: '' })}
        />
        <FileAction
          label="새 파일"
          icon="filePlus"
          onClick={() => ask({ kind: 'newfile', value: '' })}
        />
        <span className="file-actions-gap" />
        <FileAction
          label="붙여넣기"
          icon="paste"
          disabled={!clipboard}
          onClick={() => void paste()}
        />
      </div>
      <div className="file-filter">
        <input
          aria-label="파일 이름 검색"
          placeholder="파일 찾기…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select aria-label="파일 정렬" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="name">이름순</option>
          <option value="date">최근 수정순</option>
          <option value="size">큰 파일순</option>
        </select>
      </div>
      <div className="file-options">
        <FollowControl session={session} follow={follow} setFollow={setFollow} />
        <label>
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          숨김 파일 표시
        </label>
      </div>
      {error && !operation && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      <div className="file-list" aria-busy={busy}>
        {rows.map((row) => (
          <FileTreeRow
            key={row.name}
            row={row}
            selected={selection.includes(row.name)}
            toggle={() => toggle(row.name)}
            onClick={(event) => {
              setSelection(
                selectionAfterClick(
                  rows.map((v) => v.name),
                  selection,
                  row.name,
                  anchor.current,
                  event,
                ),
              );
              anchor.current = row.name;
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!selection.includes(row.name)) setSelection([row.name]);
              setContext({ x: event.clientX, y: event.clientY });
            }}
            onDoubleClick={() => {
              if (row.directory) void load(childPath(listing.path, row.name));
              else {
                setSelection([row.name]);
                ask({ kind: 'edit', program: savedEditor() });
              }
            }}
            title={row.modified ? new Date(row.modified * 1000).toLocaleString() : undefined}
          />
        ))}
        {!busy && !rows.length && (
          <p className="muted file-list-empty">
            {filter && listing.entries.length
              ? '검색 결과가 없습니다.'
              : '이 폴더는 비어 있습니다.'}
          </p>
        )}
      </div>
      <div className="file-selection">
        <div className="file-selection-info">
          <strong>
            {selected?.label ??
              (selection.length ? `${selection.length}개 선택` : '파일을 선택하세요')}
          </strong>
          {editable && <small>{formatBytes(selected.size)}</small>}
        </div>
      </div>
      {context && (
        <ContextMenu
          label="파일 작업"
          at={context}
          close={() => setContext(null)}
          items={[
            {
              label: '외부 편집기로 열기',
              disabled: !editable,
              run: () => ask({ kind: 'edit', program: savedEditor() }),
            },
            {
              label: '이름 바꾸기',
              shortcut: 'F2',
              disabled: !selected,
              run: () => selected && ask({ kind: 'rename', value: selected.name }),
            },
            {
              label: '복사',
              shortcut: 'Ctrl+C',
              separated: true,
              run: () => remember('copy'),
            },
            { label: '잘라내기', shortcut: 'Ctrl+X', run: () => remember('move') },
            {
              label: '붙여넣기',
              shortcut: 'Ctrl+V',
              disabled: !clipboard,
              run: () => void paste(),
            },
            {
              label: '전체 경로 복사',
              run: () =>
                void navigator.clipboard
                  .writeText(selectedPaths.join('\n'))
                  .catch(() => setError('경로 복사 실패')),
            },
            {
              label: '삭제',
              shortcut: 'Delete',
              separated: true,
              danger: true,
              run: () => ask({ kind: 'delete' }),
            },
          ]}
        />
      )}
      {operation && (
        <LocalFileDialog
          operation={operation}
          selection={selection}
          error={error}
          change={setOperation}
          fail={setError}
          close={() => setOperation(null)}
          submit={() => void submit()}
        />
      )}
    </aside>
  );
}
