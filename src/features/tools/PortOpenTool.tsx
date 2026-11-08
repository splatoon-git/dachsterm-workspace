import { useState, type FormEvent } from 'react';
import { ContextMenu, type MenuRequest } from '../../components/ContextMenu';
import { Dialog, defaultChoice } from '../../components/Dialog';
import { errorText } from '../../lib/ipc';
import { CheckRows } from './CheckRows';
import { checkSummary, rowText, type CheckRow, type CheckStart } from './portCheck';
import { hostPort } from './serviceCheck';
import type { Source } from './sourceLink';
import { usePortCheck } from './usePortCheck';

type Confirmation = Extract<CheckStart, { state: 'needsConfirmation' }>;

/** A long list opens on the open ports, which is what such a check is for. */
const MANY_RESULTS = 16;

export function PortOpenTool({
  source,
  sourceName,
  viewService,
}: {
  source: Source | null;
  sourceName: string;
  viewService?: (target: string) => void;
}) {
  const [targets, setTargets] = useState('');
  const [ports, setPorts] = useState('');
  const [seconds, setSeconds] = useState('3');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const check = usePortCheck();
  const { state } = check;

  async function run(confirmed: boolean) {
    if (!source) return;
    const timeoutSeconds = Number(seconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 30) {
      setError('시간 초과는 1~30초입니다.');
      return;
    }
    setError('');
    setConfirmation(null);
    try {
      const answer = await check.start({ source, targets, ports, timeoutSeconds, confirmed });
      if (answer.state === 'needsConfirmation') setConfirmation(answer);
      else setShowAll(false);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function recheck(row: CheckRow) {
    if (!source) return;
    setError('');
    try {
      await check.start({
        source,
        targets: row.host,
        ports: String(row.port),
        timeoutSeconds: Number(seconds) || 3,
        confirmed: true,
        keep: true,
      });
    } catch (e) {
      setError(errorText(e));
    }
  }

  const openMenu = (row: CheckRow, at: MenuRequest['at']) =>
    setMenu({
      at,
      items: [
        {
          label: '복사',
          // Refused only without clipboard permission, and there is nothing to do about that here.
          run: () => void navigator.clipboard.writeText(rowText(row, sourceName)).catch(() => {}),
        },
        { label: '다시 점검', run: () => void recheck(row), disabled: state.running || !source },
        ...(viewService
          ? [{ label: '서비스 연결로 보기', run: () => viewService(hostPort(row.host, row.port)) }]
          : []),
      ],
    });

  const many = state.rows.length > MANY_RESULTS || state.total > MANY_RESULTS;
  const shown = many && !showAll ? state.rows.filter((row) => row.outcome === 'open') : state.rows;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (state.running) check.stop();
    else void run(false);
  };
  const summary = checkSummary(state);
  return (
    <>
      <form className="tool-form" noValidate onSubmit={submit}>
        <label>
          대상
          <input
            value={targets}
            placeholder="10.0.0.5, db.example, 10.0.0.0/24"
            spellCheck={false}
            onChange={(event) => setTargets(event.target.value)}
          />
        </label>
        <label>
          포트
          <input
            value={ports}
            placeholder="22,80,8000-8100"
            spellCheck={false}
            onChange={(event) => setPorts(event.target.value)}
          />
        </label>
        <label className="tool-seconds">
          시간 초과(초)
          <input
            type="number"
            min={1}
            max={30}
            value={seconds}
            onChange={(event) => setSeconds(event.target.value)}
          />
        </label>
        <button className="primary" type="submit" disabled={!state.running && !source}>
          {state.running ? '취소' : '점검'}
        </button>
      </form>
      {!source && <p className="tool-pending">출발지 세션을 고르고 연결을 마치세요.</p>}
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      {state.notice && <p className="tool-notice">{state.notice}</p>}
      {(summary || state.ended || state.cancelled) && (
        <div className="tool-summary" aria-live="polite">
          <span>
            {[summary, state.cancelled && '취소됨', state.ended].filter(Boolean).join(' · ')}
          </span>
          {many && !state.running && (
            <label>
              <input
                type="checkbox"
                checked={showAll}
                onChange={(event) => setShowAll(event.target.checked)}
              />
              전체 결과 보기
            </label>
          )}
        </div>
      )}
      {shown.length > 0 && <CheckRows rows={shown} menu={openMenu} />}
      {menu && (
        <ContextMenu at={menu.at} items={menu.items} label="결과" close={() => setMenu(null)} />
      )}
      {confirmation && (
        <Dialog title="여러 대상 점검" size="small" close={() => setConfirmation(null)}>
          <p>
            호스트 {confirmation.hosts}개 × 포트 {confirmation.ports}개, 모두{' '}
            <strong>{confirmation.attempts}회</strong> 연결을 시도합니다.
          </p>
          <p>허가된 망에서만 사용하세요. 접속 시도는 상대 장비의 로그에 남습니다.</p>
          <div className="form-actions">
            <button type="button" onClick={() => setConfirmation(null)}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              ref={defaultChoice}
              onClick={() => void run(true)}
            >
              {confirmation.attempts}회 점검
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
