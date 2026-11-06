import { TransferQueue, type Transfer } from './TransferQueue';
import { PermissionEditor } from './PermissionEditor';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { call, desktop, errorText } from '../../lib/ipc';
import { TerminalSession } from '../terminal/session';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { directoryHook, useTerminalPreferences } from '../terminal/preferences';
type FileClipboard = { sourceId: string; operation: 'copy' | 'move'; paths: string[] };
type BatchOutcome = { completed: string[]; errors: string[] };
type Entry = {
  name: string;
  directory: boolean;
  symlink: boolean;
  size: number | null;
  modified: number | null;
  permissions: number | null;
};
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
export const bytes = (n: number | null) =>
  n === null
    ? '—'
    : n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;
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
  const preferences = useTerminalPreferences();
  const [follow, setFollow] = useState(session.followDirectory ?? preferences.followDirectory);
  const lastDirectory = useRef<string | null>(null);
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const id = session.connectionId;
  const isFtp = !!session.profile.protocol && session.profile.protocol !== 'ssh';
  const [listing, setListing] = useState<Listing>({ path: '.', entries: [] });
  const [path, setPath] = useState('.');
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
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
  const [trayOpen, setTrayOpen] = useState(true);
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
        setContext(null);
      } catch (e) {
        if (request === requestId.current) setError(errorText(e));
      } finally {
        if (request === requestId.current) setBusy(false);
      }
    },
    [id],
  );
  useEffect(() => {
    // Synchronize the remote filesystem when the SSH state becomes ready.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state.status === 'connected') void load('.');
  }, [state.status, load]);
  useEffect(() => {
    if (
      !isFtp &&
      follow &&
      !working &&
      state.status === 'connected' &&
      state.directory &&
      state.directory !== lastDirectory.current
    ) {
      lastDirectory.current = state.directory;
      void load(state.directory);
    }
  }, [follow, isFtp, load, state.directory, state.status, working]);
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
  useEffect(() => {
    if (!context) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setContext(null);
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [context]);
  const visible = listing.entries
    .filter(
      (e) =>
        (hidden || !e.name.startsWith('.')) &&
        e.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        (sort === 'size'
          ? (b.size ?? 0) - (a.size ?? 0)
          : sort === 'date'
            ? (b.modified ?? 0) - (a.modified ?? 0)
            : a.name.localeCompare(b.name)),
    );
  const selectedPaths = selection.map((name) => `${listing.path.replace(/\/$/, '')}/${name}`);
  function choose(entry: Entry, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    setSelected(entry);
    if (event.shiftKey && anchor.current) {
      const a = visible.findIndex((e) => e.name === anchor.current),
        b = visible.findIndex((e) => e.name === entry.name);
      setSelection(
        visible.slice(Math.min(a < 0 ? b : a, b), Math.max(a, b) + 1).map((e) => e.name),
      );
    } else if (event.ctrlKey || event.metaKey)
      setSelection((names) =>
        names.includes(entry.name) ? names.filter((n) => n !== entry.name) : [...names, entry.name],
      );
    else setSelection([entry.name]);
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
  const target = selected ? `${listing.path.replace(/\/$/, '')}/${selected.name}` : listing.path;
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
      <div className="panel-title">
        <h2>
          <Icon name="folder" /> 원격 파일
        </h2>
        <span className="protocol">{isFtp ? session.profile.protocol.toUpperCase() : 'SFTP'}</span>
      </div>
      <div
        className="file-server"
        title={`${session.profile.name} · ${session.profile.username}@${session.profile.host}`}
      >
        <span className={`status-dot ${state.status === 'connected' ? 'online' : ''}`} />
        {session.profile.name} · {session.profile.host}
      </div>
      <form
        className="path-form"
        onSubmit={(e) => {
          e.preventDefault();
          void load(path);
        }}
      >
        <input aria-label="원격 경로" value={path} onChange={(e) => setPath(e.target.value)} />
        <button aria-label="경로 이동" disabled={busy}>
          <Icon name="arrow" size={16} />
        </button>
      </form>
      {!isFtp && (
        <div className="file-follow">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => {
                lastDirectory.current = null;
                session.setFollowDirectory(e.target.checked);
                setFollow(e.target.checked);
              }}
            />
            터미널 경로 따라가기
          </label>
          {follow && !state.directory && (
            <>
              <small>셸 경로 알림 대기 · Bash/Zsh에서 연결 가능</small>
              <button
                aria-label="셸 경로 알림 연결"
                disabled={state.status !== 'connected'}
                title="현재 셸의 프롬프트에 경로 알림을 추가합니다. 서버 설정 파일은 변경하지 않습니다. 명령 실행 중에는 완료 후 누르세요."
                onClick={() => {
                  session.send(directoryHook + '\r');
                  session.terminal.focus();
                }}
              >
                연결
              </button>
            </>
          )}
        </div>
      )}
      <div className="file-toolbar file-navigation" role="group" aria-label="폴더 및 전송">
        <button title="상위 폴더" onClick={() => void load(`${listing.path}/..`)}>
          ↑
        </button>
        <button aria-label="파일 새로 고침" onClick={() => void load(listing.path)}>
          <Icon name="refresh" size={15} />
        </button>
        <button
          onClick={() => {
            setOperation('mkdir');
            setValue('');
          }}
        >
          <Icon name="plus" size={14} />
          폴더
        </button>
        <button
          onClick={() =>
            void run('transfer_batch', {
              id,
              path: listing.path,
              mode: 'files',
              paths: [],
              conflict,
            })
          }
        >
          <Icon name="upload" size={14} />
          파일 업로드
        </button>
        <button
          onClick={() =>
            void run('transfer_batch', {
              id,
              path: listing.path,
              mode: 'folders',
              paths: [],
              conflict,
            })
          }
        >
          폴더 업로드
        </button>
      </div>
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
      {pendingDrop.length > 0 && (
        <div className="transfer-policy" role="group" aria-label="드롭 전송 확인">
          <strong>
            {pendingDrop.length}개 파일·폴더 → {listing.path}
          </strong>
          <span>위 충돌 정책을 드롭한 전체에 적용합니다.</span>
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
      <div className="file-toolbar file-clipboard" role="group" aria-label="파일 및 클립보드">
        <button
          disabled={working}
          onClick={() => {
            setOperation('newfile');
            setValue('');
          }}
        >
          새 파일
        </button>
        <button disabled={!selection.length || working} onClick={() => void copySelection('copy')}>
          복사
        </button>
        <button disabled={!selection.length || working} onClick={() => void copySelection('move')}>
          잘라내기
        </button>
        <button disabled={!clipboard || working} onClick={() => void paste()}>
          붙여넣기
        </button>
      </div>
      {clipboard && (
        <div className="encoding-note">
          {clipboard.operation === 'copy' ? '복사' : '이동'} 대기 · {clipboard.paths.length}개 항목
        </div>
      )}
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
      <label className="hidden-toggle">
        <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
        숨김 파일 표시
      </label>
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
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
      <div className="file-list" aria-busy={busy}>
        <div className="file-columns">
          <span>이름</span>
          <span>크기</span>
        </div>
        {visible.map((e) => (
          <button
            key={e.name}
            className={`file-row ${selection.includes(e.name) ? 'selected' : ''}`}
            aria-pressed={selection.includes(e.name)}
            disabled={working}
            onClick={(event) => choose(e, event)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!selection.includes(e.name)) {
                setSelected(e);
                setSelection([e.name]);
              }
              setContext({
                x: Math.min(event.clientX, window.innerWidth - 210),
                y: Math.min(event.clientY, window.innerHeight - 330),
              });
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
          >
            <Icon name={e.directory ? 'folder' : 'file'} size={17} />
            <span>
              {e.name}
              {e.symlink ? ' ↗' : ''}
            </span>
            <small>{e.directory ? '폴더' : bytes(e.size)}</small>
          </button>
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
      {selected && selection.length > 0 ? (
        <div className="file-selection">
          <strong>{selection.length > 1 ? `${selection.length}개 선택` : selected.name}</strong>
          <small>
            {selected.modified ? new Date(selected.modified * 1000).toLocaleString() : ''} ·{' '}
            {selected.permissions?.toString(8).slice(-3)}
          </small>
          <div className="file-toolbar">
            <button
              disabled={working}
              onClick={() =>
                void run('transfer_batch', {
                  id,
                  path: listing.path,
                  mode: 'download',
                  paths: selection.map((name) => `${listing.path.replace(/\/$/, '')}/${name}`),
                  conflict,
                })
              }
            >
              선택 다운로드
            </button>
            {selection.length === 1 && !selected.directory && (
              <>
                <button
                  onClick={() => void run('transfer_pick', { id, path: target, upload: false })}
                >
                  다운로드
                </button>
                <button
                  disabled={isFtp}
                  title={isFtp ? '외부 편집은 SSH/SFTP 연결에서 지원합니다.' : undefined}
                  onClick={() => setOperation('edit')}
                >
                  편집
                </button>
              </>
            )}
            <button
              disabled={selection.length !== 1 || working}
              onClick={() => {
                setValue(selected.name);
                setOperation('rename');
              }}
            >
              이름
            </button>
            <button
              disabled={working}
              onClick={() => {
                setValue(selected.permissions?.toString(8).slice(-3) ?? '644');
                setOperation('chmod');
              }}
            >
              권한
            </button>
            <button
              disabled={isFtp || !selection.length || working}
              onClick={() => archive('compress')}
            >
              압축
            </button>
            <button
              disabled={isFtp || selection.length !== 1 || selected.directory || working}
              onClick={() => archive('extract')}
            >
              압축 해제
            </button>
            <button disabled={!selection.length || working} onClick={() => setOperation('delete')}>
              삭제
            </button>
          </div>
        </div>
      ) : (
        <div className="file-selection file-selection-empty">
          <strong>파일을 선택하세요</strong>
          <small>Ctrl/Cmd로 여러 항목 선택 · 더블클릭으로 열기</small>
        </div>
      )}
      <details
        className="transfer-tray"
        open={trayOpen}
        onToggle={(e) => setTrayOpen(e.currentTarget.open)}
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
      {context && (
        <div
          ref={menu}
          role="menu"
          className="file-context"
          style={{ left: context.x, top: context.y }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setContext(null);
          }}
        >
          <button role="menuitem" onClick={() => void copySelection('copy')}>
            복사 <kbd>Ctrl+C</kbd>
          </button>
          <button role="menuitem" onClick={() => void copySelection('move')}>
            잘라내기 <kbd>Ctrl+X</kbd>
          </button>
          <button role="menuitem" disabled={!clipboard} onClick={() => void paste()}>
            붙여넣기 <kbd>Ctrl+V</kbd>
          </button>
          <button
            role="menuitem"
            disabled={isFtp || selection.length !== 1 || selected?.directory}
            onClick={() => {
              setContext(null);
              setOperation('edit');
            }}
          >
            다른 프로그램으로 편집
          </button>
          <button
            role="menuitem"
            onClick={() => {
              void navigator.clipboard
                .writeText(selectedPaths.join('\n'))
                .catch(() => setError('경로 복사 실패'));
              setContext(null);
            }}
          >
            전체 경로 복사
          </button>
          <button role="menuitem" disabled={isFtp} onClick={() => archive('compress')}>
            압축하기…
          </button>
          <button
            role="menuitem"
            disabled={isFtp || selection.length !== 1 || selected?.directory}
            onClick={() => archive('extract')}
          >
            압축 해제…
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setContext(null);
              setOperation('delete');
            }}
          >
            삭제 <kbd>Delete</kbd>
          </button>
        </div>
      )}
      {operation && (
        <Dialog
          title={
            operation === 'edit'
              ? '외부 편집기'
              : operation.startsWith('overwrite')
                ? '원격 파일 덮어쓰기'
                : '파일 작업'
          }
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
                <label>
                  프로그램 경로
                  <input
                    list="editors"
                    value={editor}
                    onChange={(e) => setEditor(e.target.value)}
                    required
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    void call<string | null>('editor_pick')
                      .then((p) => {
                        if (p) setEditor(p);
                      })
                      .catch((e) => setError(errorText(e)))
                  }
                >
                  프로그램 찾아보기…
                </button>
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
                <datalist id="editors">
                  <option value="code" />
                  <option value="cursor" />
                  <option value="subl" />
                </datalist>
                <p className="muted">
                  편집기에서 저장한 뒤 선택한 방식으로 업로드합니다. 충돌하거나 취소한 수정본은
                  로컬에 보존됩니다.
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
                <p className="muted">
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
              <button disabled={working} className="primary">
                {working ? '처리 중…' : operation === 'edit' ? '편집 시작' : '적용'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </aside>
  );
}
