import { useCallback, useSyncExternalStore } from 'react';
import type { Terminal } from '@xterm/xterm';
import { isMac } from '../../lib/platform';
import { guideKeys, type GuideProgram } from './guideData';
import type { TerminalSession } from './session';
import { usePaneView } from './paneView';
import { useTerminalPreferences } from './preferences';
import './assistant.css';
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
            <>
              <p>
                지금 실행 중인 프로그램을 알아보지 못했습니다. 위에서 프로그램을 고르면 이 탭에
                고정되어 상태바에 계속 보입니다.
              </p>
              <p className="muted guide-auto">{autoNote}</p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
