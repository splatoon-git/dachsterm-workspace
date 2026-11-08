import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { RouteTraceSection } from './RouteTraceSection';
import type { ServiceHandoff } from './catalog';
import {
  formatChoices,
  hostPort,
  serviceSteps,
  serviceSummary,
  type ServiceFormat,
} from './serviceCheck';
import type { Source } from './sourceLink';
import { useServiceCheck } from './useServiceCheck';

/** Connects to one target from the chosen source and shows what actually answers. */
export function ServiceTool({
  source,
  sourceName,
  handoff,
}: {
  source: Source | null;
  sourceName: string;
  /** A target sent here from the port check, once its source is in place. */
  handoff: ServiceHandoff | null;
}) {
  const [target, setTarget] = useState('');
  const [format, setFormat] = useState<ServiceFormat>('auto');
  const { running, checked, error, cancelled, start, stop } = useServiceCheck();

  const run = (text: string, chosen: ServiceFormat) => {
    if (source) void start(source, sourceName, text, chosen);
  };
  const consumed = useRef<ServiceHandoff | null>(null);
  const receive = useEffectEvent((next: ServiceHandoff) => {
    consumed.current = next;
    setTarget(next.target);
    setFormat('auto');
    run(next.target, 'auto');
  });
  useEffect(() => {
    if (handoff && consumed.current !== handoff) receive(handoff);
  }, [handoff]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (running) stop();
    else run(target, format);
  };
  const steps = checked ? serviceSteps(checked.report) : [];
  return (
    <>
      <form className="tool-form" noValidate onSubmit={submit}>
        <label>
          대상
          <input
            value={target}
            placeholder="api.example.com:443, https://api.example.com/health"
            spellCheck={false}
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>
        <label className="tool-format">
          형식
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value as ServiceFormat)}
          >
            {formatChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" type="submit" disabled={!running && !source}>
          {running ? '취소' : '점검'}
        </button>
      </form>
      {!source && <p className="tool-pending">출발지 세션을 고르고 연결을 마치세요.</p>}
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      {running && <p className="tool-pending">점검 중…</p>}
      {cancelled && <p className="tool-pending">취소됨</p>}
      {checked && (
        <details className="service-result" key={checked.id}>
          <summary>
            <span className="service-route">
              {checked.sourceName} → {hostPort(checked.report.host, checked.report.port)}
            </span>
            <span className={`tool-outcome ${checked.report.outcome}`}>
              {serviceSummary(checked.report)}
            </span>
          </summary>
          <dl className="service-steps">
            {steps.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <RouteTraceSection
            checkedFrom={checked.source}
            source={source}
            host={checked.report.host}
            port={checked.report.port}
          />
        </details>
      )}
    </>
  );
}
