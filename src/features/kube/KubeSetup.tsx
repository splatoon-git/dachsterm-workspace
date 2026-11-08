import { useState } from 'react';
import { setupGuide, setupStep, type DetectRequest, type Detection } from './kubeModel';

/** The first connection's detection, permission guidance and context choice, inside the tab. */
export function KubeSetup({
  detection,
  busy,
  error,
  note,
  recheck,
  chooseContext,
  start,
  copy,
}: {
  detection: Detection;
  busy: boolean;
  error: string;
  /** Why the copy could not be typed, or what to do next in the terminal. */
  note: string;
  recheck: (request: DetectRequest) => void;
  chooseContext: (context: string) => void;
  start: (context: string, namespace: string) => void;
  copy: (command: string) => void;
}) {
  const step = setupStep(detection);
  const guide = setupGuide(detection.state);
  return (
    <div className="kube-setup">
      <div className="kube-setup-card">
        <h2>{guide?.title ?? '쿠버네티스 연결 설정'}</h2>
        {guide && <p>{guide.body}</p>}
        <dl className="kube-setup-found">
          <dt>kubectl</dt>
          <dd>{detection.kubectl || '찾지 못함'}</dd>
          <dt>kubeconfig</dt>
          <dd>{detection.kubeconfig || '찾지 못함'}</dd>
        </dl>
        {step === 'choose' && (
          <ContextForm detection={detection} busy={busy} choose={chooseContext} start={start} />
        )}
        {step === 'copy' && (
          <div className="form-actions">
            <button
              className="primary"
              disabled={busy || !detection.copyCommand}
              onClick={() => detection.copyCommand && copy(detection.copyCommand)}
            >
              터미널에서 설정 복사
            </button>
            <button disabled={busy} onClick={() => recheck({ mode: 'scan' })}>
              다시 확인
            </button>
          </div>
        )}
        {step === 'copy' && !detection.copyCommand && (
          <p className="muted">복사할 원본을 찾지 못했습니다. 관리자에게 설정 파일을 받으세요.</p>
        )}
        {step === 'manual' && (
          <ManualForm key={detection.kubectl} detection={detection} busy={busy} recheck={recheck} />
        )}
        {step === 'retry' && (
          <div className="form-actions">
            <button disabled={busy} onClick={() => recheck({ mode: 'scan' })}>
              다시 확인
            </button>
          </div>
        )}
        {note && <p className="kube-setup-note">{note}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}

function ContextForm({
  detection,
  busy,
  choose,
  start,
}: {
  detection: Detection;
  busy: boolean;
  choose: (context: string) => void;
  start: (context: string, namespace: string) => void;
}) {
  const [namespace, setNamespace] = useState('');
  return (
    <form
      className="kube-setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        start(detection.context, namespace);
      }}
    >
      <label>
        context
        <select
          aria-label="context"
          value={detection.context}
          disabled={busy}
          onChange={(event) => {
            setNamespace('');
            choose(event.target.value);
          }}
        >
          {detection.contexts.map((context) => (
            <option key={context} value={context}>
              {context}
            </option>
          ))}
        </select>
      </label>
      {detection.namespacesForbidden ? (
        <label>
          namespace
          <input
            aria-label="namespace"
            value={namespace}
            maxLength={63}
            pattern="[a-z0-9]([\-a-z0-9]*[a-z0-9])?"
            placeholder="비워 두면 전체"
            onChange={(event) => setNamespace(event.target.value)}
          />
          <small>이 계정은 namespace 목록을 볼 수 없어 직접 입력합니다.</small>
        </label>
      ) : (
        <label>
          namespace
          <select
            aria-label="namespace"
            value={namespace}
            disabled={busy}
            onChange={(event) => setNamespace(event.target.value)}
          >
            <option value="">전체</option>
            {detection.namespaces.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="form-actions">
        <button className="primary" disabled={busy} type="submit">
          시작
        </button>
      </div>
    </form>
  );
}

function ManualForm({
  detection,
  busy,
  recheck,
}: {
  detection: Detection;
  busy: boolean;
  recheck: (request: DetectRequest) => void;
}) {
  const [kubectl, setKubectl] = useState(detection.kubectl);
  const [kubeconfig, setKubeconfig] = useState(detection.kubeconfig);
  return (
    <form
      className="kube-setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        recheck({ mode: 'manual', kubectl: kubectl.trim(), kubeconfig: kubeconfig.trim() });
      }}
    >
      <label>
        kubectl 명령
        <input
          aria-label="kubectl 명령"
          required
          value={kubectl}
          maxLength={4096}
          placeholder="/usr/local/bin/kubectl 또는 microk8s kubectl"
          onChange={(event) => setKubectl(event.target.value)}
        />
      </label>
      <label>
        kubeconfig 경로
        <input
          aria-label="kubeconfig 경로"
          value={kubeconfig}
          maxLength={4096}
          placeholder="명령이 자체 설정을 쓰면 비워 두세요"
          onChange={(event) => setKubeconfig(event.target.value)}
        />
      </label>
      <div className="form-actions">
        <button type="button" disabled={busy} onClick={() => recheck({ mode: 'scan' })}>
          다시 찾기
        </button>
        <button className="primary" disabled={busy} type="submit">
          확인
        </button>
      </div>
    </form>
  );
}
