import { useState, useSyncExternalStore } from 'react';
import { Dialog } from '../../components/Dialog';
import { commands, guideHook, guideKeys, type GuideProgram } from './guideData';
import type { TerminalSession } from './session';
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
      <details>
        <summary>Bash에서 프로그램 조작표 자동 표시 연결</summary>
        <p>
          터미널의 조작표에서 “실행 알림 사용”을 켜고 아래 코드를 직접 검토·실행하세요. 현재 Bash
          세션에만 vi/vim/less/tail/cat 함수를 만들며 명령 인자·입력·이력은 수집하지 않습니다. 기존
          별칭/함수가 있으면 적용하지 않습니다. 셸 설정 파일은 바꾸지 않습니다. command vim처럼
          함수를 우회하면 자동 표시되지 않습니다.
        </p>
        <pre>{guideHook}</pre>
        <button onClick={() => void copy(guideHook, 'Bash 실행 알림 연결')}>
          Bash 연동 코드 복사
        </button>
        <p>
          연동 해제는 현재 셸을 종료하고 새 셸을 여세요. 화면 알림만 끄려면 조작표의 “끄기”를
          누르세요. 파이프/백그라운드/중첩 실행은 수동 선택·고정을 사용하세요. 알림은 안내용이며
          현재 편집 모드를 판별하지 않습니다.
        </p>
      </details>
    </Dialog>
  );
}
export function ProgramGuide({ session }: { session: TerminalSession }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const [open, setOpen] = useState(false);
  const [dismissedRun, setDismissedRun] = useState<number | undefined>(undefined);
  const [manual, setManual] = useState<GuideProgram | ''>('');
  const program = manual || (state.guideEnabled ? state.guideProgram : null);
  const expanded =
    open ||
    (!!state.guideEnabled && !!state.guideProgram && !manual && dismissedRun !== state.guideRun);
  return (
    <aside className="program-guide" aria-label="프로그램 조작표">
      <div className="guide-controls">
        <button
          aria-expanded={expanded}
          onClick={() => {
            setOpen(!expanded);
            if (expanded) setDismissedRun(state.guideRun);
          }}
        >
          조작표 {program ? `· ${program}` : ''} {expanded ? '접기' : '열기'}
        </button>
        {expanded && (
          <>
            <select
              aria-label="조작표 선택·고정"
              value={manual}
              onChange={(e) => setManual(e.target.value as GuideProgram | '')}
            >
              <option value="">자동 · 고정 해제</option>
              {Object.keys(guideKeys).map((p) => (
                <option key={p} value={p}>
                  {p} · 고정
                </option>
              ))}
            </select>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!!state.guideEnabled}
                onChange={(e) => session.enableGuide(e.target.checked)}
              />
              실행 알림 사용
            </label>
            <button
              onClick={() => {
                setManual('');
                session.enableGuide(false);
                setOpen(false);
              }}
            >
              끄기
            </button>
          </>
        )}
      </div>
      {expanded && (
        <div className="guide-content">
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
              <p className="muted">
                {program === 'vi' || program === 'vim'
                  ? '현재 모드는 추정하지 않습니다. 먼저 Esc를 누르세요. gg는 vim 기준이며 전통 vi는 1G를 사용합니다.'
                  : program === 'tail' || program === 'cat'
                    ? '자체 검색·페이지 키는 없습니다. 터미널 스크롤백 또는 less를 사용하세요.'
                    : '안내용입니다. 이 패널은 서버에 키를 보내지 않습니다.'}
              </p>
            </>
          ) : (
            <p className="muted">
              프로그램을 직접 선택·고정하세요. 자동 표시는 Bash 연동의 명시적 실행 알림이
              필요합니다. 도구 → 기본 명령·로그 필터에서 연결 방법을 볼 수 있습니다.
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
