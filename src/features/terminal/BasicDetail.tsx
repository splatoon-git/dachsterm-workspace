import { useState } from 'react';
import { placeholders } from './commandItems';
import type { CommandExample } from './guideData';

/** A built-in command: shown with the parts to replace, copied as is, never typed in for the user. */
export function BasicDetail({
  command,
  toSnippet,
}: {
  command: CommandExample;
  toSnippet: () => void;
}) {
  const [message, setMessage] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(command.command);
      setMessage('복사했습니다. 터미널에 붙여넣고 강조된 부분을 바꿔 실행하세요.');
    } catch {
      setMessage('클립보드에 복사하지 못했습니다. 명령을 직접 선택해 복사하세요.');
    }
  }
  return (
    <div className="cmd-detail">
      <header className="cmd-detail-head">
        <div>
          <h3>{command.title}</h3>
          <div className="cmd-chips">
            <span className="cmd-chip">{command.group}</span>
            <span className="cmd-chip">GNU/Linux</span>
          </div>
        </div>
      </header>
      <section className="cmd-block" aria-label="명령">
        <h4>명령</h4>
        <pre className="cmd-code">
          {command.command
            .split(placeholders)
            .map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}
        </pre>
        <p className="cmd-hint">
          강조된 부분을 바꿔서 실행하세요. 복사에는 Enter가 들어가지 않습니다.
        </p>
        {command.note && <p className="cmd-note">{command.note}</p>}
      </section>
      <details className="cmd-help">
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
      <footer className="cmd-actions">
        <p role="status" className="cmd-message">
          {message}
        </p>
        <button onClick={toSnippet}>내 스니펫으로 저장</button>
        <button
          className="primary"
          aria-label={`${command.title} 복사`}
          onClick={() => void copy()}
        >
          복사
        </button>
      </footer>
    </div>
  );
}
