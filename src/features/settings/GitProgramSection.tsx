import { useEffect, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import { isMac } from '../../lib/platform';

type GitProgramInfo = {
  chosen: string | null;
  found: string | null;
  version: string | null;
  problem: string | null;
};

/** Which git this PC's tabs run. WSL and servers each use the git on their own `PATH`. */
export function GitProgramSection() {
  const [info, setInfo] = useState<GitProgramInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call<GitProgramInfo>('git_program_info').then(setInfo, (e: unknown) => setError(errorText(e)));
  }, []);
  async function set(path: string | null) {
    setBusy(true);
    try {
      setInfo(await call<GitProgramInfo>('git_program_set', { path }));
      setError('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function pick() {
    try {
      const path = await call<string | null>('git_program_pick');
      if (path) await set(path);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const inUse = info?.chosen ?? info?.found;
  const missing = info && !inUse && !info.problem;
  return (
    <section className="dialog-section git-program" aria-label="Git 위치">
      <h3>Git 위치 (이 PC)</h3>
      <p>WSL과 서버는 각자의 PATH에 있는 git을 씁니다.</p>
      {info && (
        <dl className="git-program-facts">
          <dt>사용 중</dt>
          <dd>
            {inUse ? <code>{inUse}</code> : '없음'}
            {info.chosen ? ' (직접 지정)' : inUse ? ' (자동으로 찾음)' : ''}
          </dd>
          {info.version && (
            <>
              <dt>버전</dt>
              <dd>{info.version}</dd>
            </>
          )}
          {info.chosen && (
            <>
              <dt>자동으로 찾은 경로</dt>
              <dd>{info.found ? <code>{info.found}</code> : '없음'}</dd>
            </>
          )}
        </dl>
      )}
      {missing && (
        <p>
          이 PC에서 git을 찾지 못했습니다.{' '}
          {isMac ? (
            <>
              터미널에서 <code>xcode-select --install</code>로 명령줄 도구를 설치하세요.
            </>
          ) : (
            'Git for Windows를 설치한 뒤 다시 여세요.'
          )}
        </p>
      )}
      {info?.problem && <p role="alert">{info.problem}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="git-config-actions">
        <button type="button" disabled={busy} onClick={() => void pick()}>
          파일 선택…
        </button>
        {info?.chosen && (
          <button type="button" disabled={busy} onClick={() => void set(null)}>
            자동 찾기로 되돌리기
          </button>
        )}
      </div>
    </section>
  );
}
