import { useEffect, useRef, useState, type ReactNode } from 'react';
import face from '../../assets/brand/dachshund-face.png';
import { ContextMenu, type MenuItem, type MenuPoint } from '../../components/ContextMenu';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { call, errorText } from '../../lib/ipc';
import { BasicDetail } from './BasicDetail';
import { basicSections, snippetBody, snippetSections } from './commandItems';
import type { CommandExample } from './guideData';
import type { TerminalSession } from './session';
import { SnippetEditor } from './SnippetEditor';
import { SnippetRun } from './SnippetRun';
import { emptySnippet, type Library, type Snippet } from './snippets';
import './commandPanel.css';

type Tab = 'snippets' | 'basics';
type Mode =
  | { kind: 'view' }
  | { kind: 'edit'; snippet: Snippet; isNew: boolean }
  | { kind: 'delete'; snippet: Snippet };

const TAB_KEY = 'dachsterm.commands.tab';
function readTab(): Tab {
  try {
    return localStorage.getItem(TAB_KEY) === 'basics' ? 'basics' : 'snippets';
  } catch {
    // Blocked storage opens the snippets, the default.
    return 'snippets';
  }
}

/**
 * Saved snippets and the built-in basic commands in one place. The list on the left is searched
 * from the box at the top, which also moves through it with the arrow keys; the right side shows
 * the chosen item with everything needed to use it.
 */
export function CommandPanel({
  sessions,
  active,
  close,
}: {
  sessions: TerminalSession[];
  active?: string;
  close: () => void;
}) {
  const [tab, setTab] = useState<Tab>(readTab);
  const [query, setQuery] = useState('');
  const [library, setLibrary] = useState<Library | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<{ at: MenuPoint; snippet: Snippet } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    call<Library>('snippet_list')
      .then(setLibrary)
      .catch((e) => setNotice(errorText(e)));
  }, []);

  const items = library?.items ?? [];
  const snippets = snippetSections(items, query);
  const basics = basicSections(query);
  const order =
    tab === 'snippets'
      ? snippets.flatMap((s) => s.items.map((i) => i.id))
      : basics.flatMap((s) => s.items.map((c) => c.title));
  const current = picked && order.includes(picked) ? picked : (order[0] ?? null);
  const snippet = items.find((s) => s.id === current);
  const basic = basics.flatMap((s) => s.items).find((c) => c.title === current);
  useEffect(() => {
    list.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
  }, [current, tab]);

  const switchTab = (next: Tab, nextMode: Mode = { kind: 'view' }) => {
    setTab(next);
    setPicked(null);
    setMode(nextMode);
    setNotice('');
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Only the next opening's tab is lost.
    }
  };
  const editNew = (s: Snippet) => switchTab('snippets', { kind: 'edit', snippet: s, isNew: true });
  const fromBasic = (c: CommandExample) =>
    editNew({
      ...emptySnippet(),
      name: c.title,
      group: c.group,
      description: c.note ?? '',
      body: snippetBody(c.command),
    });
  const duplicate = (s: Snippet) =>
    editNew({ ...s, id: crypto.randomUUID(), name: `${s.name} 복사` });
  async function save(next: Snippet[], select: string | null) {
    if (!library) return;
    setBusy(true);
    try {
      setLibrary(await call<Library>('snippet_save', { revision: library.revision, items: next }));
      setPicked(select);
      setMode({ kind: 'view' });
      setNotice('');
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const snippetMenu = (s: Snippet): MenuItem[] => [
    { label: '수정…', run: () => setMode({ kind: 'edit', snippet: s, isNew: false }) },
    { label: '복제', run: () => duplicate(s) },
    {
      label: '삭제…',
      danger: true,
      separated: true,
      run: () => setMode({ kind: 'delete', snippet: s }),
    },
  ];

  let detail: ReactNode;
  if (mode.kind === 'edit')
    detail = (
      <SnippetEditor
        key={mode.snippet.id}
        initial={mode.snippet}
        isNew={mode.isNew}
        groups={[...new Set(items.map((s) => s.group).filter(Boolean))]}
        busy={busy}
        save={(s) => void save([...items.filter((old) => old.id !== s.id), s], s.id)}
        cancel={() => setMode({ kind: 'view' })}
      />
    );
  else if (mode.kind === 'delete')
    detail = (
      <div className="cmd-detail cmd-delete" role="group" aria-label="스니펫 삭제">
        <h3>“{mode.snippet.name}”을 삭제할까요?</h3>
        <p className="cmd-hint">저장된 스니펫을 지웁니다. 되돌릴 수 없습니다.</p>
        <footer className="cmd-actions">
          <span className="cmd-message" />
          <button disabled={busy} onClick={() => setMode({ kind: 'view' })}>
            취소
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              void save(
                items.filter((s) => s.id !== mode.snippet.id),
                null,
              )
            }
          >
            삭제
          </button>
        </footer>
      </div>
    );
  else if (tab === 'basics')
    detail = basic ? (
      <BasicDetail key={basic.title} command={basic} toSnippet={() => fromBasic(basic)} />
    ) : (
      <p className="cmd-empty-line">검색 결과가 없습니다.</p>
    );
  else if (!library) detail = !notice && <p className="cmd-empty-line">불러오는 중…</p>;
  else if (!items.length)
    detail = (
      <div className="cmd-empty">
        <img src={face} alt="" width="56" height="56" />
        <h3>저장된 스니펫이 없습니다</h3>
        <p>자주 쓰는 명령을 저장해 두면 값만 바꿔 터미널에 바로 넣을 수 있습니다.</p>
        <div className="cmd-empty-actions">
          <button className="primary" onClick={() => editNew(emptySnippet())}>
            새 스니펫
          </button>
          <button onClick={() => switchTab('basics')}>기본 명령에서 고르기</button>
        </div>
      </div>
    );
  else
    detail = snippet ? (
      <SnippetRun
        key={snippet.id}
        snippet={snippet}
        sessions={sessions}
        active={active}
        edit={() => setMode({ kind: 'edit', snippet, isNew: false })}
        duplicate={() => duplicate(snippet)}
        remove={() => setMode({ kind: 'delete', snippet })}
      />
    ) : (
      <p className="cmd-empty-line">검색 결과가 없습니다.</p>
    );

  const item = (id: string, name: string, body: string, s?: Snippet) => (
    <button
      key={id}
      className="cmd-item"
      aria-current={id === current && mode.kind === 'view' ? 'true' : undefined}
      onClick={() => {
        setPicked(id);
        setMode({ kind: 'view' });
      }}
      onContextMenu={(e) => {
        if (!s) return;
        e.preventDefault();
        setPicked(id);
        setMenu({ at: { x: e.clientX, y: e.clientY }, snippet: s });
      }}
    >
      <span className="cmd-item-name">{name}</span>
      <code className="cmd-item-body">{body.split('\n')[0]}</code>
    </button>
  );

  return (
    <Dialog
      title="명령"
      className="command-panel"
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="cmd-bar">
        <div className="cmd-tabs" role="tablist" aria-label="명령 종류">
          {(
            [
              ['snippets', '내 스니펫', library ? String(items.length) : ''],
              ['basics', '기본 명령', ''],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              aria-controls="command-list"
              onClick={() => switchTab(id)}
            >
              {label}
              {count && <small>{count}</small>}
            </button>
          ))}
        </div>
        <label className="cmd-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            aria-label="명령 검색"
            placeholder={tab === 'snippets' ? '이름·그룹·태그·명령 검색' : '명령·설명 검색'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const at = current ? order.indexOf(current) : -1;
                const next = order[at + (e.key === 'ArrowDown' ? 1 : -1)];
                if (next) {
                  setPicked(next);
                  setMode({ kind: 'view' });
                }
              } else if (e.key === 'Enter' && current) {
                e.preventDefault();
                pane.current
                  ?.querySelector<HTMLElement>('input:not([type="checkbox"]), button.primary')
                  ?.focus();
              }
            }}
          />
        </label>
        <button className="cmd-new" disabled={!library} onClick={() => editNew(emptySnippet())}>
          <Icon name="plus" size={14} />새 스니펫
        </button>
      </div>
      <div className="cmd-body">
        <div className="cmd-list" id="command-list" role="tabpanel" ref={list}>
          {tab === 'snippets'
            ? snippets.map((section) => (
                <div
                  key={section.title}
                  className="cmd-section"
                  role="group"
                  aria-label={section.title}
                >
                  <div className="cmd-section-title">{section.title}</div>
                  {section.items.map((s) => item(s.id, s.name, s.body, s))}
                </div>
              ))
            : basics.map((section) => (
                <div
                  key={section.title}
                  className="cmd-section"
                  role="group"
                  aria-label={section.title}
                >
                  <div className="cmd-section-title">{section.title}</div>
                  {section.items.map((c) => item(c.title, c.title, c.command))}
                </div>
              ))}
          {tab === 'snippets' && library && !order.length && (
            <p className="cmd-empty-line">
              {items.length ? '일치하는 스니펫이 없습니다.' : '아직 저장한 스니펫이 없습니다.'}
            </p>
          )}
        </div>
        <div className="cmd-pane" ref={pane}>
          {notice && (
            <p role="alert" className="cmd-notice">
              {notice}
            </p>
          )}
          {detail}
        </div>
      </div>
      <p className="cmd-foot">
        <kbd>↑</kbd>
        <kbd>↓</kbd> 고르기 · <kbd>Enter</kbd> 사용 · <kbd>Esc</kbd> 닫기 · 스니펫에는 인증정보를
        저장하지 마세요.
      </p>
      {menu && (
        <ContextMenu
          label={`${menu.snippet.name} 스니펫 작업`}
          at={menu.at}
          items={snippetMenu(menu.snippet)}
          close={() => setMenu(null)}
        />
      )}
    </Dialog>
  );
}
