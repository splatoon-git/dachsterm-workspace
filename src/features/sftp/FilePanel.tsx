import { TransferQueue, type Transfer } from './TransferQueue';
import { EditorPicker } from './EditorPicker';
import { PermissionEditor } from './PermissionEditor';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { call, desktop, errorText } from '../../lib/ipc';
import { TerminalSession } from '../terminal/session';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { selectionAfterClick, withoutNested, type FileEntry } from './fileList';
import { ContextMenu, type MenuPoint } from '../../components/ContextMenu';
import { FileAction, FilePathBar, FileTreeRow, useFileTree } from './fileTree';
import { FollowControl, useDirectoryFollow } from './follow';
import { operationText } from './fileOperation';
type FileClipboard = { sourceId: string; operation: 'copy' | 'move'; paths: string[] };
type BatchOutcome = { completed: string[]; errors: string[] };
type Entry = FileEntry;
type Listing = { path: string; entries: Entry[] };
type Edit = {
  uploadMode: string;
  id: string;
  profileId: string;
  remote: string;
  local: string;
  status: string;
  message: string;
};
export function FilePanel({ session }: { session?: TerminalSession }) {
  if (!session)
    return (
      <aside className="files" aria-label="SFTP 파일 탐색">
        <div className="panel-title">
          <h2>
            <Icon name="folder" /> 원격 파일
          </h2>
          <span className="protocol">SFTP</span>
        </div>
        <div className="file-empty">
          <Icon name="folder" size={38} />
          <h3>서버의 파일을 바로 곁에</h3>
          <p>
            SSH에 연결하면 폴더와 파일이
            <br />
            이곳에 표시됩니다.
          </p>
          <div className="empty-capabilities">
            <span>파일 전송</span>
            <span>외부 편집</span>
            <span>권한 관리</span>
          </div>
        </div>
      </aside>
    );
  return <ConnectedFiles key={session.connectionId} session={session} />;
}
function ConnectedFiles({ session }: { session: TerminalSession }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const id = session.connectionId;
  const isFtp = !!session.profile.protocol && session.profile.protocol !== 'ssh';
  const [listing, setListing] = useState<Listing>({ path: '.', entries: [] });
  const [path, setPath] = useState('.');
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null);
  const [context, setContext] = useState<MenuPoint | null>(null);
  const anchor = useRef('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('name');
  const [archiveFormat, setArchiveFormat] = useState('zip');
  const [archiveEncoding, setArchiveEncoding] = useState('auto');
  const [archiveLimit, setArchiveLimit] = useState(2048);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [conflict, setConflict] = useState('skip');
  const [pendingDrop, setPendingDrop] = useState<string[]>([]);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [trayChoice, setTrayChoice] = useState<boolean | null>(null);
  const [operation, setOperation] = useState('');
  const [value, setValue] = useState('');
  const [uploadMode, setUploadMode] = useState(
    () => localStorage.getItem('dachsterm.uploadMode') ?? 'ask',
  );
  const requestId = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const [fileEncoding, setFileEncoding] = useState('original');
  const [editorArgs, setEditorArgs] = useState(
    () => localStorage.getItem('dachsterm.editorArgs') ?? '[]',
  );
  const [editor, setEditor] = useState(() => localStorage.getItem('dachsterm.editor') ?? 'code');
  const load = useCallback(
    async (next: string) => {
      const request = ++requestId.current;
      setBusy(true);
      setError('');
      try {
        const data = await call<Listing>('sftp_list', { id, path: next });
        if (request !== requestId.current) return;
        setListing(data);
        setPath(data.path);
        setSelected(null);
        setSelection([]);
      } catch (e) {
        if (request === requestId.current) setError(errorText(e));
      } finally {
        if (request === requestId.current) setBusy(false);
      }
    },
    [id, setError],
  );
  useEffect(() => {
    // Synchronize the remote filesystem when the SSH state becomes ready.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state.status === 'connected') void load('.');
  }, [state.status, load]);
  const { follow, setFollow } = useDirectoryFollow(session, load, isFtp || working);
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    async function poll() {
      try {
        const [t, e, c] = await Promise.all([
          call<Transfer[]>('transfer_list'),
          call<Edit[]>('edit_list'),
          call<FileClipboard | null>('file_clipboard', { action: 'get', value: null }),
        ]);
        if (alive) {
          setTransfers(t);
          setEdits(e);
          setClipboard(c);
        }
      } catch {
        /* A closed app cannot update its view. */
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!desktop || state.status !== 'connected') return;
    let off: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'drop') {
          const bounds = panel.current?.getBoundingClientRect();
          const x = event.payload.position.x / window.devicePixelRatio,
            y = event.payload.position.y / window.devicePixelRatio;
          if (!bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom)
            return;
          setPendingDrop(event.payload.paths);
        }
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else off = unlisten;
      });
    return () => {
      disposed = true;
      off?.();
    };
  }, [id, listing.path, state.status]);
  const view = useMemo(() => ({ showHidden: hidden, filter, sort }), [hidden, filter, sort]);
  const listFolder = useCallback(
    (folder: string) => call<Listing>('sftp_list', { id, path: folder }),
    [id],
  );
  const { rows: visible, toggle, folderMenu } = useFileTree(listing, view, listFolder);
  const base = listing.path.replace(/\/$/, '');
  const selectedPaths = withoutNested(selection).map((name) => `${base}/${name}`);
  // Past transfers stay out of the way. Unfinished work opens the tray until the user closes it.
  const trayOpen =
    trayChoice ??
    (edits.some((e) => e.profileId === session.profile.id) ||
      transfers.some((t) => t.profileId === session.profile.id && t.status !== 'completed'));
  function choose(entry: Entry, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    setSelected(entry);
    setSelection(
      selectionAfterClick(
        visible.map((e) => e.name),
        selection,
        entry.name,
        anchor.current,
        event,
      ),
    );
    anchor.current = entry.name;
  }
  async function copySelection(operation: 'copy' | 'move') {
    if (!selection.length) return;
    try {
      setClipboard(
        await call<FileClipboard>('file_clipboard', {
          action: 'set',
          value: { sourceId: id, operation, paths: selectedPaths },
        }),
      );
      setContext(null);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function batch(
    operation: string,
    paths: string[],
    sourceId = id,
    directory = listing.path,
  ) {
    setWorking(true);
    setContext(null);
    try {
      const result = await call<BatchOutcome>('file_batch', {
        id,
        sourceId,
        operation,
        paths,
        directory,
      });
      if (operation === 'move' && clipboard) {
        const remaining = clipboard.paths.filter((p) => !result.completed.includes(p));
        setClipboard(
          await call<FileClipboard | null>('file_clipboard', {
            action: remaining.length ? 'set' : 'clear',
            value: remaining.length ? { ...clipboard, paths: remaining } : null,
          }),
        );
      }
      await load(listing.path);
      setError(result.errors.join('\n'));
      return result.errors.length === 0;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setWorking(false);
    }
  }
  function archive(operation: 'compress' | 'extract') {
    setContext(null);
    setOperation(operation);
    setValue(
      `${listing.path}/${operation === 'compress' ? 'archive.zip' : (selected?.name ?? 'archive') + ' 추출'}`,
    );
  }
  async function paste() {
    if (clipboard) await batch(clipboard.operation, clipboard.paths, clipboard.sourceId);
  }
  function fileKey(event: React.KeyboardEvent) {
    if ((event.target as HTMLElement).closest('input,select,textarea') || working) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      ['c', 'x', 'v', 'a'].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      const key = event.key.toLowerCase();
      if (key === 'c' || key === 'x') void copySelection(key === 'c' ? 'copy' : 'move');
      else if (key === 'v') void paste();
      else {
        setSelection(visible.map((e) => e.name));
        setSelected(visible[0] ?? null);
      }
    } else if (event.key === 'Delete' && selection.length) {
      event.preventDefault();
      setOperation('delete');
    } else if (event.key === 'F2' && selection.length === 1 && selected) {
      event.preventDefault();
      setValue(selected.name);
      setOperation('rename');
    } else if (event.key === 'F5') {
      event.preventDefault();
      void load(listing.path);
    } else if (event.key === 'Escape') setContext(null);
  }
  const target = selected ? `${base}/${selected.name}` : listing.path;
  async function run(command: string, args: Record<string, unknown>) {
    try {
      await call(command, args);
      setError('');
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }
  async function resolve(edit: Edit, choice: string, newPath?: string) {
    await run('edit_resolve', {
      id: edit.id,
      connectionId: id,
      profileId: session.profile.id,
      choice,
      path: newPath ?? null,
    });
  }
  return (
    <aside
      ref={panel}
      className="files"
      aria-label={`${isFtp ? 'FTP' : 'SFTP'} 파일 탐색`}
      onKeyDown={fileKey}
      aria-busy={working}
    >
      <div
        className="file-header"
        title={`${session.profile.name} · ${session.profile.username}@${session.profile.host}`}
      >
        <span className={`status-dot ${state.status === 'connected' ? 'online' : ''}`} />
        <span className="file-header-name">
          {session.profile.name} · {session.profile.host}
        </span>
        <span className="protocol">{isFtp ? session.profile.protocol.toUpperCase() : 'SFTP'}</span>
      </div>
      <FilePathBar
        label="원격 경로"
        value={path}
        busy={busy}
        change={setPath}
        submit={() => void load(path)}
      />
      <div className="file-actions" role="group" aria-label="파일 작업">
        <FileAction label="상위 폴더" icon="up" onClick={() => void load(`${listing.path}/..`)} />
        <FileAction label="파일 새로 고침" icon="refresh" onClick={() => void load(listing.path)} />
        <span className="file-actions-gap" />
        <FileAction
          label="폴더"
          icon="folderPlus"
          onClick={() => {
            setOperation('mkdir');
            setValue('');
          }}
        />
        <FileAction
          label="새 파일"
          icon="filePlus"
          disabled={working}
          onClick={() => {
            setOperation('newfile');
            setValue('');
          }}
        />
        <span className="file-actions-gap" />
        <FileAction
          label="파일 업로드"
          icon="upload"
          onClick={() =>
            void run('transfer_batch', {
              id,
              path: listing.path,
              mode: 'files',
              paths: [],
              conflict,
            })
          }
        />
        <FileAction
          label="폴더 업로드"
          icon="uploadFolder"
          onClick={() =>
            void run('transfer_batch', {
              id,
              path: listing.path,
              mode: 'folders',
              paths: [],
              conflict,
            })
          }
        />
        <span className="file-actions-gap" />
        <FileAction
          label="붙여넣기"
          icon="paste"
          disabled={!clipboard || working}
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
        {!isFtp && <FollowControl session={session} follow={follow} setFollow={setFollow} />}
        <label>
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          숨김 파일 표시
        </label>
      </div>
      {pendingDrop.length > 0 && (
        <div className="transfer-policy" role="group" aria-label="드롭 전송 확인">
          <strong>
            {pendingDrop.length}개 파일·폴더 → {listing.path}
          </strong>
          <span>전송 및 편집의 충돌 정책을 드롭한 전체에 적용합니다.</span>
          <button
            onClick={async () => {
              if (
                await run('transfer_batch', {
                  id,
                  path: listing.path,
                  mode: 'drop',
                  paths: pendingDrop,
                  conflict,
                })
              )
                setPendingDrop([]);
            }}
          >
            큐에 추가
          </button>
          <button onClick={() => setPendingDrop([])}>취소</button>
        </div>
      )}
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      <div className="file-list" aria-busy={busy}>
        {visible.map((e) => (
          <FileTreeRow
            key={e.name}
            row={e}
            selected={selection.includes(e.name)}
            toggle={() => toggle(e.name)}
            disabled={working}
            onClick={(event) => choose(e, event)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!selection.includes(e.name)) {
                setSelected(e);
                setSelection([e.name]);
              }
              setContext({ x: event.clientX, y: event.clientY });
            }}
            onDoubleClick={() => {
              if (e.directory || e.symlink) void load(`${listing.path}/${e.name}`);
              else if (!isFtp) {
                setSelected(e);
                setSelection([e.name]);
                setOperation('edit');
              }
            }}
            title={`${e.modified ? new Date(e.modified * 1000).toLocaleString() : '시각 없음'} · 권한 ${e.permissions?.toString(8).slice(-3) ?? '—'}`}
          />
        ))}
        {!busy && !visible.length && (
          <p className="muted file-list-empty">
            {filter && listing.entries.length
              ? '검색 결과가 없습니다.'
              : state.status === 'connected'
                ? '이 폴더는 비어 있습니다.'
                : '연결 후 파일을 불러옵니다.'}
          </p>
        )}
      </div>
      <div className="file-selection">
        <div className="file-selection-info">
          <strong>
            {selection.length > 1
              ? `${selection.length}개 선택`
              : selection.length
                ? selected?.name
                : '파일을 선택하세요'}
          </strong>
          {selection.length === 1 && selected && (
            <small>
              {selected.modified ? new Date(selected.modified * 1000).toLocaleDateString() : ''}{' '}
              {selected.permissions?.toString(8).slice(-3)}
            </small>
          )}
        </div>
      </div>
      <details
        className="transfer-tray"
        open={trayOpen}
        onToggle={(e) => setTrayChoice(e.currentTarget.open)}
      >
        <summary className="tray-heading">
          <span>전송 및 편집</span>
          <small>
            {
              transfers.filter((t) => t.profileId === session.profile.id && t.status === 'running')
                .length
            }{' '}
            진행 중
          </small>
        </summary>
        <label className="transfer-policy">
          새 전송 묶음의 동명 파일
          <select
            aria-label="전송 충돌 정책"
            value={conflict}
            onChange={(e) => setConflict(e.target.value)}
          >
            <option value="skip">건너뛰기</option>
            <option value="rename">이름 변경</option>
            <option value="overwrite">덮어쓰기 (선택 전체)</option>
          </select>
          <small>같은 이름의 폴더는 합칩니다. 기존 다른 파일은 보존합니다.</small>
          {conflict === 'overwrite' && (
            <strong>다음에 선택한 파일·폴더 전체의 동명 파일을 교체합니다.</strong>
          )}
        </label>
        <div className="encoding-note">
          파일명 {isFtp ? session.profile.encoding : 'UTF-8'} · 전송 내용은 원본 바이트 유지
          {isFtp && (
            <span>
              {' '}
              · 패시브(PASV) 모드 / Binary
              {session.profile.protocol === 'ftp' ? ' · TLS 없음' : ' · TLS 인증서 검증'}
            </span>
          )}
        </div>
        <TransferQueue
          transfers={transfers.filter((t) => t.profileId === session.profile.id)}
          connectionId={id}
          profileId={session.profile.id}
          run={run}
          discard={(id) => setOperation(`discard:${id}`)}
        />
        {edits
          .filter((e) => e.profileId === session.profile.id)
          .map((edit) => (
            <div className="edit-item" key={edit.id}>
              <strong>{edit.remote.split('/').pop()}</strong>
              <small role={edit.status === 'pending' ? 'status' : undefined}>{edit.message}</small>
              {edit.status === 'pending' && (
                <div className="file-toolbar">
                  <button className="primary" onClick={() => void resolve(edit, 'retry')}>
                    지금 업로드
                  </button>
                  <button onClick={() => void resolve(edit, 'pause')}>취소 · 수정본 보존</button>
                </div>
              )}
              {edit.status === 'uploading' && (
                <button onClick={() => void resolve(edit, 'pause')}>업로드 취소</button>
              )}
              <details>
                <summary>수정본 · 복구</summary>
                <code>{edit.local}</code>
                <label>
                  저장 후 동작
                  <select
                    value={edit.uploadMode}
                    disabled={edit.status === 'uploading' || edit.status === 'committing'}
                    onChange={(e) => void run('edit_mode', { id: edit.id, mode: e.target.value })}
                  >
                    <option value="ask">업로드 확인</option>
                    <option value="auto">자동 업로드</option>
                    <option value="manual">수동 업로드</option>
                  </select>
                </label>
                <div className="file-toolbar">
                  <button onClick={() => void resolve(edit, 'retry')}>재시도</button>
                  <button onClick={() => void resolve(edit, 'pause')}>감지 중지</button>
                  <button onClick={() => void run('edit_close', { id: edit.id })}>
                    동기화된 파일 정리
                  </button>
                </div>
                {edit.status !== 'watching' && (
                  <div className="file-toolbar">
                    <button
                      onClick={() => {
                        setOperation(`overwrite:${edit.id}`);
                      }}
                    >
                      덮어쓰기
                    </button>
                    <button onClick={() => void resolve(edit, 'reload')}>다시 받기</button>
                    <button
                      onClick={() => {
                        setOperation(`saveAs:${edit.id}`);
                        setValue(`${edit.remote}.copy`);
                      }}
                    >
                      다른 이름
                    </button>
                  </div>
                )}
              </details>
            </div>
          ))}
        {!transfers.length && !edits.length && (
          <p className="muted">파일을 이 파일 패널에 끌어 놓아 업로드하세요.</p>
        )}
      </details>
      {working && (
        <p role="status" className="encoding-note">
          파일 작업 중… 완료된 항목은 유지됩니다.
        </p>
      )}
      {context && selection.length > 0 && (
        <ContextMenu
          label="파일 작업"
          at={context}
          close={() => setContext(null)}
          items={[
            {
              label: '다운로드',
              disabled: working,
              run: () =>
                void (selection.length === 1 && !selected?.directory
                  ? run('transfer_pick', { id, path: target, upload: false })
                  : run('transfer_batch', {
                      id,
                      path: listing.path,
                      mode: 'download',
                      paths: selectedPaths,
                      conflict,
                    })),
            },
            {
              label: '외부 편집기로 열기',
              disabled: isFtp || selection.length !== 1 || !!selected?.directory,
              run: () => setOperation('edit'),
            },
            {
              label: '이름 바꾸기',
              shortcut: 'F2',
              separated: true,
              disabled: selection.length !== 1 || working,
              run: () => {
                setValue(selected?.name ?? '');
                setOperation('rename');
              },
            },
            {
              label: '권한…',
              disabled: working,
              run: () => {
                setValue(selected?.permissions?.toString(8).slice(-3) ?? '644');
                setOperation('chmod');
              },
            },
            {
              label: '복사',
              shortcut: 'Ctrl+C',
              separated: true,
              run: () => void copySelection('copy'),
            },
            { label: '잘라내기', shortcut: 'Ctrl+X', run: () => void copySelection('move') },
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
            ...folderMenu(selection.length === 1 && selected?.directory ? target : undefined),
            {
              label: '압축하기…',
              separated: true,
              disabled: isFtp,
              run: () => archive('compress'),
            },
            {
              label: '압축 해제…',
              disabled: isFtp || selection.length !== 1 || !!selected?.directory,
              run: () => archive('extract'),
            },
            {
              label: '삭제',
              shortcut: 'Delete',
              separated: true,
              danger: true,
              run: () => setOperation('delete'),
            },
          ]}
        />
      )}
      {operation && (
        <Dialog
          title={operationText(operation, selection.length).title}
          size={operation === 'edit' ? 'medium' : 'small'}
          close={() => setOperation('')}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void (async () => {
                let ok: boolean;
                if (operation === 'edit') {
                  localStorage.setItem('dachsterm.editor', editor);
                  localStorage.setItem('dachsterm.uploadMode', uploadMode);
                  let args: unknown;
                  try {
                    args = JSON.parse(editorArgs);
                    if (!Array.isArray(args) || !args.every((v) => typeof v === 'string'))
                      throw new Error();
                  } catch {
                    setError('편집기 인자는 JSON 문자열 배열이어야 합니다.');
                    return;
                  }
                  localStorage.setItem('dachsterm.editorArgs', editorArgs);
                  ok = await run('edit_start', {
                    id,
                    profileId: session.profile.id,
                    path: target,
                    program: editor,
                    args,
                    encoding: fileEncoding,
                    uploadMode,
                  });
                } else if (operation.startsWith('discard:')) {
                  ok = await run('transfer_discard', {
                    id: operation.split(':')[1],
                    connectionId: id,
                  });
                } else if (operation.includes(':')) {
                  const [choice, editId] = operation.split(':');
                  ok = await run('edit_resolve', {
                    id: editId,
                    connectionId: id,
                    profileId: session.profile.id,
                    choice,
                    path: value,
                  });
                } else if (operation === 'compress' || operation === 'extract') {
                  setWorking(true);
                  ok = await run('archive_run', {
                    id,
                    request: {
                      operation,
                      paths: selectedPaths,
                      target: value,
                      format: archiveFormat,
                      encoding: archiveEncoding,
                      limitMb: archiveLimit,
                    },
                  });
                  setWorking(false);
                  if (ok) await load(listing.path);
                } else if (operation === 'delete') {
                  ok = await batch('delete', selectedPaths);
                } else if (operation === 'chmod' && selection.length > 1) {
                  ok = true;
                  for (const path of selectedPaths) {
                    if (!(await run('sftp_change', { id, operation: 'chmod', path, value }))) {
                      ok = false;
                      break;
                    }
                  }
                  if (ok) await load(listing.path);
                } else {
                  ok = await run('sftp_change', {
                    id,
                    operation:
                      operation === 'delete'
                        ? selected?.directory
                          ? 'rmdir'
                          : 'delete'
                        : operation,
                    path: ['mkdir', 'newfile'].includes(operation)
                      ? `${listing.path}/${value}`
                      : target,
                    value: operation === 'rename' ? `${listing.path}/${value}` : value,
                  });
                  if (ok) await load(listing.path);
                }
                if (ok) setOperation('');
              })();
            }}
          >
            {operation === 'edit' ? (
              <>
                <EditorPicker value={editor} change={setEditor} fail={setError} />
                <label>
                  저장 후 동작
                  <select value={uploadMode} onChange={(e) => setUploadMode(e.target.value)}>
                    <option value="ask">업로드할지 확인 (기본)</option>
                    <option value="auto">저장할 때 자동 업로드</option>
                    <option value="manual">수동 업로드</option>
                  </select>
                </label>
                <label>
                  추가 인자 (JSON 배열)
                  <input
                    value={editorArgs}
                    onChange={(e) => setEditorArgs(e.target.value)}
                    placeholder='["--new-window"]'
                  />
                </label>
                <label>
                  원격 파일 내용 인코딩
                  <select value={fileEncoding} onChange={(e) => setFileEncoding(e.target.value)}>
                    <option value="original">원본 바이트 유지 · 편집기에서 인코딩 선택</option>
                    <option value="utf-8">UTF-8</option>
                    <option value="euc-kr">CP949 / EUC-KR</option>
                    <option value="shift_jis">Shift_JIS</option>
                    <option value="gbk">GBK</option>
                    <option value="big5">Big5</option>
                    <option value="windows-1252">Windows-1252</option>
                  </select>
                  <small>
                    원본 유지 외의 옵션은 로컬 UTF-8로 열고 저장할 때 선택한 인코딩으로 변환합니다.
                    표현 불가능한 문자는 업로드하지 않습니다.
                  </small>
                </label>
                <p className="field-help">
                  편집기에서 저장하면 고른 방식으로 업로드합니다. 충돌하거나 취소한 수정본은 로컬에
                  남깁니다.
                </p>
              </>
            ) : operation === 'compress' || operation === 'extract' ? (
              <>
                <label>
                  {operation === 'compress' ? '새 압축 파일 경로' : '새로 만들 추출 폴더'}
                  <input required value={value} onChange={(e) => setValue(e.target.value)} />
                </label>
                {operation === 'compress' ? (
                  <label>
                    압축 형식
                    <select
                      value={archiveFormat}
                      onChange={(e) => {
                        setArchiveFormat(e.target.value);
                        setValue(
                          (v) => v.replace(/\.(zip|tar\.gz|tar)$/, '') + '.' + e.target.value,
                        );
                      }}
                    >
                      <option value="zip">ZIP · 파일명 UTF-8</option>
                      <option value="tar">TAR</option>
                      <option value="tar.gz">TAR.GZ</option>
                    </select>
                  </label>
                ) : (
                  <label>
                    ZIP 파일명 인코딩
                    <select
                      value={archiveEncoding}
                      onChange={(e) => setArchiveEncoding(e.target.value)}
                    >
                      <option value="auto">자동 · UTF-8 플래그 / CP437</option>
                      <option value="cp949">CP949 · 한국어</option>
                      <option value="cp932">CP932 · 일본어</option>
                      <option value="gbk">GBK · 중국어 간체</option>
                      <option value="big5">Big5 · 중국어 번체</option>
                      <option value="cp437">CP437</option>
                    </select>
                  </label>
                )}
                <label>
                  처리할 원본 / 압축 해제 크기 제한 (MiB)
                  <input
                    type="number"
                    min={1}
                    max={16384}
                    required
                    value={archiveLimit}
                    onChange={(e) => setArchiveLimit(Number(e.target.value))}
                  />
                </label>
                <p className="field-help">
                  서버의 Python 3와 Linux 지원을 사용합니다. ZIP 파일명 인코딩 지정은 Python 3.11
                  이상이 필요합니다. 파일 내용은 변환하지 않습니다. 링크·장치·경로 이탈 항목은
                  거부하며 기존 대상에 덮어쓰지 않습니다.
                </p>
              </>
            ) : operation.startsWith('discard:') ? (
              <p>
                큐 기록과 이 전송의 부분 파일을 삭제합니다. 완료된 파일과 생성한 빈 폴더는
                보존합니다.
              </p>
            ) : operation === 'delete' || operation.startsWith('overwrite') ? (
              <p>
                {operation === 'delete'
                  ? `${selection.length}개 항목과 폴더 안의 모든 내용을 삭제합니다. 되돌릴 수 없습니다.\n${selection.join(', ')}`
                  : '현재 서버의 파일을 로컬 수정본으로 교체합니다.'}
              </p>
            ) : (
              <label>
                {operation === 'chmod' ? '권한 (000~777)' : '이름 또는 경로'}
                <input required value={value} onChange={(e) => setValue(e.target.value)} />
              </label>
            )}
            {operation === 'chmod' && <PermissionEditor value={value} change={setValue} />}
            <div className="form-actions">
              <button type="button" onClick={() => setOperation('')}>
                취소
              </button>
              <button
                disabled={working}
                className={operationText(operation, selection.length).danger ? 'danger' : 'primary'}
              >
                {working ? '처리 중…' : operationText(operation, selection.length).action}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </aside>
  );
}
