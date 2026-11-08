import { useRef, useState, type FormEvent } from 'react';
import { call, errorText } from '../../lib/ipc';
import { CheckRows } from './CheckRows';
import {
  answerPorts,
  methodText,
  parsePortFilter,
  processText,
  unusedText,
  type Listener,
  type ListenerReport,
} from './portUse';
import { usePortCheck } from './usePortCheck';
import type { SourceControl } from './useSource';

const OUTSIDE_SECONDS = 3;

function ListenerRows({ listeners }: { listeners: Listener[] }) {
  return (
    <table className="tool-results">
      <thead>
        <tr>
          <th>포트</th>
          <th>프로토콜</th>
          <th>주소</th>
          <th>프로세스</th>
        </tr>
      </thead>
      <tbody>
        {listeners.map((listener) => (
          <tr key={`${listener.protocol}:${listener.address}:${listener.port}`}>
            <td>{listener.port}</td>
            <td>{listener.protocol.toUpperCase()}</td>
            <td>{listener.address}</td>
            <td className={listener.process.kind === 'known' ? undefined : 'tool-note'}>
              {processText(listener.process)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PortUseTool({ control }: { control: SourceControl }) {
  const { source, link, mode } = control;
  const [text, setText] = useState('');
  const [report, setReport] = useState<ListenerReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outside, setOutside] = useState<string | null>(null);
  const run = useRef(0);
  const check = usePortCheck();
  const filter = parsePortFilter(text);
  const asking = filter.ports.length > 0;
  const linkEnded = link.status === 'closed' || link.status === 'error';
  const canAskOutside = mode === 'remote' && !!link.profile && asking;
  const ready = !!source || (linkEnded && canAskOutside);

  /** SSH could not list the ports. The ports asked about can still be tried from this PC. */
  async function fromOutside(reason: string) {
    if (!canAskOutside || !link.profile) {
      setError(
        mode === 'remote'
          ? `${reason} 전체 목록은 낼 수 없습니다. 포트를 입력하면 이 PC에서 확인합니다.`
          : reason,
      );
      return;
    }
    setOutside(link.profile.host);
    setError('');
    await check.start({
      source: { kind: 'local' },
      targets: link.profile.host,
      ports: text,
      timeoutSeconds: OUTSIDE_SECONDS,
      confirmed: true,
    });
  }

  async function read() {
    const current = ++run.current;
    setBusy(true);
    setError('');
    setReport(null);
    setOutside(null);
    check.reset();
    try {
      if (source) {
        const answer = await call<ListenerReport>('net_listeners', { source });
        if (run.current === current) setReport(answer);
      } else {
        await fromOutside('SSH로 연결하지 못했습니다.');
      }
    } catch (e) {
      if (run.current !== current) return;
      if (source) await fromOutside(errorText(e)).catch((nested) => setError(errorText(nested)));
      else setError(errorText(e));
    } finally {
      if (run.current === current) setBusy(false);
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (filter.error) setError(filter.error);
    else void read();
  };
  const denied = report?.listeners.some((listener) => listener.process.kind === 'denied');
  const answer = report && asking ? answerPorts(report.listeners, filter.ports) : null;
  return (
    <>
      <form className="tool-form" onSubmit={submit}>
        <label>
          포트(비우면 전체)
          <input
            value={text}
            placeholder="22,80,8000-8100"
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button className="primary" type="submit" disabled={!ready || busy || check.state.running}>
          {busy ? '읽는 중…' : '확인'}
        </button>
      </form>
      {!ready && <p className="tool-pending">출발지 세션을 고르고 연결을 마치세요.</p>}
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      {report && !filter.error && (
        <div className="tool-summary">
          <span>
            {answer
              ? `사용 중 ${new Set(answer.used.map((l) => l.port)).size}개 · 사용 안 함 ${answer.unused.length}개`
              : `${report.listeners.length}개`}
            {' · '}읽은 방법: {methodText[report.method]}
          </span>
        </div>
      )}
      {report && denied && (
        <p className="tool-notice">권한 없음: 다른 계정의 프로세스 이름은 읽을 수 없습니다.</p>
      )}
      {report && !filter.error && (
        <>
          {(!answer || answer.used.length > 0) && (
            <ListenerRows listeners={answer ? answer.used : report.listeners} />
          )}
          {answer && answer.unused.length > 0 && (
            <p className="tool-unused">사용 안 함: {unusedText(answer.unused)}</p>
          )}
        </>
      )}
      {outside && (
        <section className="tool-outside" aria-label="외부에서 확인한 결과">
          <h3>외부에서 확인한 결과</h3>
          <p className="tool-note">
            서버 안의 목록을 읽지 못해 이 PC에서 {outside}로 연결해 보았습니다. 서버에 있어도 방화벽
            때문에 다르게 보일 수 있습니다.
          </p>
          {check.state.rows.length > 0 && <CheckRows rows={check.state.rows} />}
        </section>
      )}
    </>
  );
}
