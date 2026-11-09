import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { ResizeHandle } from '../../components/ResizeHandle';
import type { IngressController } from './ingressTypes';
import { LogBoardPicker } from './LogBoardPicker';
import { LogLines, type LineTag } from './LogLines';
import {
  FONT_SIZES,
  MAX_BOARD_SOURCES,
  shortPodName,
  toneColor,
  visibleLines,
  type BoardLine,
  type BoardSource,
} from './logBoardModel';
import { includedWords } from './logSearchModel';
import type { SnapshotStore } from './polling';
import type { LogBoardHandle } from './useLogBoard';
import './logBoard.css';

const NO_ITEMS: never[] = [];
type Layout = 'split' | 'merged';

function Pane({
  title,
  detail,
  tone,
  errors,
  note,
  zoomed,
  toggleZoom,
  actions,
  children,
}: {
  title: string;
  detail?: string;
  tone: number | null;
  errors: number;
  note?: string;
  zoomed: boolean;
  toggleZoom: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="kube-board-pane" aria-label={title}>
      <header onDoubleClick={toggleZoom}>
        {tone !== null && (
          <i className="kube-board-tone" style={{ background: toneColor(tone) }} aria-hidden />
        )}
        <strong title={title}>{title}</strong>
        {detail && <span title={detail}>{detail}</span>}
        {errors > 0 && <em title="오류로 보이는 줄">오류 {errors.toLocaleString('en-US')}</em>}
        <div className="kube-board-pane-actions">
          {actions}
          <button
            aria-label={zoomed ? `${title} 원래 크기` : `${title} 크게 보기`}
            title={zoomed ? '원래 크기' : '크게 보기'}
            onClick={toggleZoom}
          >
            <Icon name={zoomed ? 'collapse' : 'expand'} size={13} />
          </button>
        </div>
      </header>
      {note && <p className="kube-board-pane-note">{note}</p>}
      {children}
    </section>
  );
}

/** Follows many pods at once, side by side or as one timeline. */
export function LogBoard({
  board,
  store,
  controllers,
}: {
  board: LogBoardHandle;
  store: SnapshotStore;
  controllers: IngressController[];
}) {
  const { sources, entries, prefs, version, ended } = board;
  const [layout, setLayout] = useState<Layout>('split');
  const [query, setQuery] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const pods = store.pods.data ?? NO_ITEMS;
  const services = store.services.data ?? NO_ITEMS;

  const view = useMemo(
    () => ({ query, errorsOnly, upTo: pausedAt }),
    [query, errorsOnly, pausedAt],
  );
  const words = useMemo(() => includedWords(query), [query]);
  const tones = useMemo(() => new Map(sources.map((s) => [s.key, s])), [sources]);
  const tagOf = (line: BoardLine): LineTag | null => {
    const source = tones.get(line.key);
    return source ? { text: shortPodName(source.pod), color: toneColor(source.tone) } : null;
  };

  const lane = (name: BoardSource['lane']) => sources.filter((source) => source.lane === name);
  const ingress = lane('ingress');
  const backends = lane('pods');
  const ingressKeys = new Set(ingress.map((source) => source.key));
  const ingressEntry = entries.find((entry) => entry.scope.kind === 'controller');
  const mergedAll = useMemo(
    () => visibleLines(board.store.all(), view),
    // `version` stands for the store's contents, which change in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, view, board.store],
  );
  const lines = (key: string) => visibleLines(board.store.lines(key), view);
  const ingressLines = mergedAll.filter((line) => ingressKeys.has(line.key));

  const toggleZoom = (id: string) => setZoom((now) => (now === id ? null : id));
  const logs = (id: string, label: string, shown: BoardLine[], tagged: boolean) => (
    <LogLines
      key={id}
      lines={shown}
      version={version}
      tagOf={tagged ? tagOf : null}
      words={words}
      fontSize={prefs.fontSize}
      wrap={prefs.wrap}
      label={label}
    />
  );

  const ingressPane = () => (
    <Pane
      title="인그레스 컨트롤러"
      detail={ingressEntry?.filter ? `${ingressEntry.filter} 요청만` : '모든 요청'}
      tone={null}
      errors={ingress.reduce((sum, source) => sum + board.store.errorCount(source.key), 0)}
      zoomed={zoom === 'ingress'}
      toggleZoom={() => toggleZoom('ingress')}
      actions={
        ingressEntry?.filter ? (
          <button
            className="text"
            title="컨트롤러의 모든 요청을 봅니다"
            onClick={() => board.clearFilter(ingressEntry.id)}
          >
            전체 요청
          </button>
        ) : undefined
      }
    >
      {logs('ingress', '인그레스 컨트롤러 로그', ingressLines, ingress.length > 1)}
    </Pane>
  );
  const sourcePane = (source: BoardSource) => {
    const end = ended[source.key];
    return (
      <Pane
        key={source.key}
        title={source.pod}
        detail={source.node || source.container}
        tone={source.tone}
        errors={board.store.errorCount(source.key)}
        note={end?.note}
        zoomed={zoom === source.key}
        toggleZoom={() => toggleZoom(source.key)}
        actions={
          <button
            aria-label={`${source.pod} 빼기`}
            title="보드에서 빼기"
            onClick={() => board.excludeSource(source.key)}
          >
            <Icon name="close" size={13} />
          </button>
        }
      >
        {logs(source.key, `${source.pod} 로그`, lines(source.key), false)}
      </Pane>
    );
  };
  const mergedPane = () => (
    <Pane
      title="합친 로그"
      detail={`${sources.length}개 시간순`}
      tone={null}
      errors={sources.reduce((sum, source) => sum + board.store.errorCount(source.key), 0)}
      zoomed={false}
      toggleZoom={() => setLayout('split')}
    >
      {logs('merged', '합친 로그', mergedAll, true)}
    </Pane>
  );

  const zoomedSource = sources.find((source) => source.key === zoom);
  const content = () => {
    if (layout === 'merged') return mergedPane();
    if (zoom === 'ingress' && ingress.length) return ingressPane();
    if (zoomedSource) return sourcePane(zoomedSource);
    return (
      <>
        {ingress.length > 0 && (
          <>
            <div
              style={{ height: backends.length ? prefs.ingressHeight : undefined }}
              className="kube-board-lane"
            >
              {ingressPane()}
            </div>
            {backends.length > 0 && (
              <ResizeHandle
                horizontal
                value={prefs.ingressHeight}
                min={80}
                max={900}
                onChange={(ingressHeight) => board.setPrefs({ ingressHeight })}
                label="인그레스 로그 높이"
              />
            )}
          </>
        )}
        {backends.length > 0 && <div className="kube-board-grid">{backends.map(sourcePane)}</div>}
      </>
    );
  };

  const statusText =
    board.phase === 'live'
      ? pausedAt !== null
        ? '일시정지'
        : `실시간 ${sources.length}개`
      : board.phase === 'ended'
        ? '중지됨'
        : '';
  const picker = (
    <LogBoardPicker
      pods={pods}
      services={services}
      controllers={controllers}
      chosen={entries}
      add={(entry) => board.watch([entry])}
    />
  );

  if (!entries.length)
    return (
      <div className="kube-board" role="tabpanel" aria-label="실시간 로그">
        <div className="kube-board-start">
          <h2>보고 싶은 대상을 고르세요</h2>
          <p>
            서비스나 노드를 고르면 파드마다 로그가 나란히 흐릅니다. 인그레스 화면에서 호스트를
            우클릭하면 컨트롤러 로그와 뒤쪽 파드를 함께 엽니다.
          </p>
          {picker}
        </div>
      </div>
    );

  return (
    <div className="kube-board" role="tabpanel" aria-label="실시간 로그">
      <div className="kube-board-tools">
        <div className="kube-board-chips">
          {entries.map((entry) => (
            <span key={entry.id} className="kube-board-chip">
              {entry.label}
              <button
                aria-label={`${entry.label} 빼기`}
                onClick={() => board.removeEntry(entry.id)}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
          <button
            className="kube-board-add"
            aria-expanded={picking}
            onClick={() => setPicking((now) => !now)}
          >
            <Icon name="plus" size={12} /> 추가
          </button>
          {picking && (
            <div
              className="kube-board-popover"
              onKeyDown={(event) => {
                if (event.key === 'Escape') setPicking(false);
              }}
            >
              {picker}
            </div>
          )}
        </div>
        <input
          type="search"
          aria-label="로그 필터"
          placeholder="필터: 공백은 AND, !단어는 제외"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="kube-board-check">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(event) => setErrorsOnly(event.target.checked)}
          />
          경고·오류만
        </label>
        <div className="kube-board-segment" role="group" aria-label="보기 방식">
          <button aria-pressed={layout === 'split'} onClick={() => setLayout('split')}>
            나눠 보기
          </button>
          <button aria-pressed={layout === 'merged'} onClick={() => setLayout('merged')}>
            합쳐 보기
          </button>
        </div>
        <div className="kube-board-buttons">
          <button
            aria-label="글자 작게"
            title="글자 작게"
            disabled={prefs.fontSize <= FONT_SIZES.min}
            onClick={() => board.setPrefs({ fontSize: prefs.fontSize - 1 })}
          >
            가-
          </button>
          <button
            aria-label="글자 크게"
            title="글자 크게"
            disabled={prefs.fontSize >= FONT_SIZES.max}
            onClick={() => board.setPrefs({ fontSize: prefs.fontSize + 1 })}
          >
            가+
          </button>
          <button
            aria-label="줄바꿈"
            title="줄바꿈"
            aria-pressed={prefs.wrap}
            onClick={() => board.setPrefs({ wrap: !prefs.wrap })}
          >
            <Icon name="wrapLines" size={14} />
          </button>
          <button
            aria-label={pausedAt === null ? '일시정지' : '이어서 보기'}
            title={pausedAt === null ? '화면 멈추기 (로그는 계속 받습니다)' : '이어서 보기'}
            aria-pressed={pausedAt !== null}
            onClick={() => setPausedAt((now) => (now === null ? board.store.lastSeq : null))}
          >
            <Icon name={pausedAt === null ? 'pause' : 'play'} size={14} />
          </button>
          <button aria-label="지우기" title="화면 지우기" onClick={board.clearLines}>
            <Icon name="trash" size={14} />
          </button>
        </div>
        <span className={`kube-board-status ${board.phase}`} role="status">
          {statusText}
          {board.phase === 'ended' && (
            <button className="text" onClick={board.restart}>
              다시 연결
            </button>
          )}
        </span>
      </div>
      {(board.error || board.omitted > 0 || board.dropped > 0) && (
        <div className="kube-board-notes" role="alert">
          {board.error && <span>{board.error}</span>}
          {board.omitted > 0 && (
            <span>
              한 번에 {MAX_BOARD_SOURCES}개까지 따라갑니다. {board.omitted}개는 제외했습니다.
            </span>
          )}
          {board.dropped > 0 && (
            <span>
              로그가 너무 빨라 {board.dropped.toLocaleString('en-US')}줄을 건너뛰었습니다.
            </span>
          )}
        </div>
      )}
      <div className="kube-board-body">
        {sources.length === 0 ? (
          <p className="kube-board-hint">이 대상에서 실행 중인 파드를 찾지 못했습니다.</p>
        ) : (
          content()
        )}
      </div>
    </div>
  );
}
