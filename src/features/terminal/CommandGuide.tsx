import { useCallback, useState, useSyncExternalStore } from 'react';
import type { Terminal } from '@xterm/xterm';
import { Dialog } from '../../components/Dialog';
import { isMac } from '../../lib/platform';
import { commands, guideKeys, type GuideProgram } from './guideData';
import type { TerminalSession } from './session';
import { usePaneView } from './paneView';
import { useTerminalPreferences } from './preferences';
import './assistant.css';
const placeholders = /(파일명|프로그램명|검색어|제외어|문구1|문구2|경로|원본|대상|호스트)/g;
export function CommandCatalog({ close }: { close: () => void }) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('전체');
  const [message, setMessage] = useState('');
  async function copy(text: string, name: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`${name} 복사 완료`);
    } catch {
      setMessage('클립보드에 복사하지 못했습니다. 명령을 직접 선택해 복사하세요.');
    }
  }
  return (
    <Dialog title="기본 명령·로그 필터" close={close} className="assistant-dialog">
      <p>
        GNU/Linux 예제입니다. 강조된 부분을 바꾸고 직접 붙여넣어 실행하세요. 복사는 Enter를 포함하지
        않습니다.
      </p>
      <div className="assistant-filters">
        <input
          aria-label="기본 명령 검색"
          placeholder="명령·설명 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select aria-label="명령 분류" value={group} onChange={(e) => setGroup(e.target.value)}>
          {['전체', ...new Set(commands.map((c) => c.group))].map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
      </div>
      <p role="status">{message}</p>
      <div className="command-list">
        {commands
          .filter(
            (c) =>
              (group === '전체' || c.group === group) &&
              `${c.title} ${c.command} ${c.note ?? ''}`
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
          )
          .map((c) => (
            <article key={c.title}>
              <div>
                <strong>{c.title}</strong>
                <button
                  aria-label={`${c.title} 복사`}
                  onClick={() => void copy(c.command, c.title)}
                >
                  복사
                </button>
              </div>
              <code>
                {c.command
                  .split(placeholders)
                  .map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}
              </code>
              {c.note && <p className="muted">{c.note}</p>}
            </article>
          ))}
      </div>
      <details>
        <summary>인용·필터 결과·지원 환경 도움말</summary>
        <p>
          작은따옴표 안은 문자 그대로 전달됩니다. 검색어에 작은따옴표가 있으면 따옴표를 닫고
          이스케이프한 뒤 다시 여세요: <code>{`grep -F -- 'it'\\''s' '파일명'`}</code>. 큰따옴표
          안의 $·백틱은 셸에서 해석될 수 있습니다.
        </p>
        <p>
          출력이 없으면 일치 항목 없음, 파일 경로, 읽기 권한을 확인하세요. 실시간 필터는 새 줄이
          들어올 때 출력합니다. 로그 교체는 tail -F, 종료는 Ctrl+C입니다. --line-buffered, readlink
          -f와 Linux 전용 도구는 macOS/BSD에서 동일하게 동작한다고 보장하지 않습니다.
        </p>
      </details>
    </Dialog>
  );
}
/** Keys shown in the status bar itself; the rest are in the full table. */
const INLINE_KEYS = 5;
const guideNote = (program: GuideProgram) =>
  program === 'vi' || program === 'vim'
    ? '현재 모드는 추정하지 않습니다. 먼저 Esc를 누르세요. gg는 vim 기준이며 전통 vi는 1G를 사용합니다.'
    : program === 'tail' || program === 'cat'
      ? '자체 검색·페이지 키는 없습니다. 터미널 스크롤백 또는 less를 사용하세요.'
      : '안내용입니다. 이 표는 서버에 키를 보내지 않습니다.';

const autoNote =
  '자동 표시는 Bash·Zsh에서 vi, vim, less, tail을 실행하면 나타나고 끝나면 사라집니다. 설정 → 터미널에서 끌 수 있습니다. sudo·command를 앞에 붙인 실행, 파이프, tmux 안, 다른 셸에서는 직접 고르세요.';

/** Whether a full-screen program such as vim or top has switched to the alternate screen. */
function useAlternateScreen(terminal: Terminal) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscription = terminal.buffer.onBufferChange(listener);
      return () => subscription.dispose();
    },
    [terminal],
  );
  return useSyncExternalStore(subscribe, () => terminal.buffer.active.type === 'alternate');
}

/**
 * The program guide in the status bar. It shows a few keys while a known program runs and opens
 * the full table on request. A full-screen program it cannot name gets a general notice, since a
 * name is never guessed from the screen. It only displays keys; it never sends or intercepts them.
 */
export function ProgramGuide({ session }: { session: TerminalSession }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const view = usePaneView(session.view);
  const { programGuide } = useTerminalPreferences();
  const alternate = useAlternateScreen(session.terminal);
  const program = view.pinned ?? (programGuide ? state.guideProgram : null);
  const fullScreen = !program && programGuide && alternate;
  const close = () => session.view.set({ guide: false });
  return (
    <div className="program-guide" role="group" aria-label="프로그램 조작표">
      {fullScreen && (
        <span className="guide-inline">
          <strong>전체 화면 프로그램 실행 중</strong>
          {/* xterm forces a selection with Shift elsewhere; on a Mac it needs an Option setting. */}
          {!isMac && (
            <span className="guide-key">
              <kbd>Shift+드래그</kbd> 텍스트 선택
            </span>
          )}
        </span>
      )}
      {program && (
        <span className="guide-inline">
          <strong>{program}</strong>
          {guideKeys[program].slice(0, INLINE_KEYS).map(([name, key]) => (
            <span key={name} className="guide-key">
              <kbd>{key}</kbd> {name}
            </span>
          ))}
        </span>
      )}
      {(program || fullScreen) && (
        <button aria-expanded={view.guide} onClick={() => session.view.set({ guide: !view.guide })}>
          전체 보기
        </button>
      )}
      {view.pinned && <button onClick={() => session.view.set({ pinned: null })}>고정 해제</button>}
      {view.guide && (
        <section
          className="guide-popover"
          aria-label="조작표 전체 보기"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          <div className="guide-controls">
            <strong>조작표{program ? ` · ${program}` : ''}</strong>
            <select
              aria-label="조작표 선택·고정"
              value={view.pinned ?? ''}
              onChange={(e) =>
                session.view.set({ pinned: (e.target.value || null) as GuideProgram })
              }
            >
              <option value="">자동 · 고정 해제</option>
              {Object.keys(guideKeys).map((p) => (
                <option key={p} value={p}>
                  {p} · 고정
                </option>
              ))}
            </select>
            <button aria-label="조작표 닫기" onClick={close}>
              ×
            </button>
          </div>
          {program ? (
            <>
              <dl>
                {guideKeys[program].map(([name, key]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>
                      <kbd>{key}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="muted">{guideNote(program)}</p>
            </>
          ) : (
            <p className="muted">프로그램을 직접 선택·고정하세요. {autoNote}</p>
          )}
        </section>
      )}
    </div>
  );
}
