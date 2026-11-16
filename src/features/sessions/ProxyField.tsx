import { useState, type MutableRefObject } from 'react';
import type { NetworkProxy, Profile, Proxy } from '../../lib/ipc';
import { withProxyKind, type ProxySecret } from './proxy';

/** The proxy of an SSH session: HTTP or SOCKS5 (CG.1), or a command (CG.2). The password goes
 *  to the secure store, never the form; a command typed here is the user's own approval. */
export function ProxyField({
  profile,
  field,
  passwordRef,
}: {
  profile: Profile;
  field: (key: 'proxy', value: Proxy | null) => void;
  passwordRef: MutableRefObject<ProxySecret>;
}) {
  const proxy = profile.proxy ?? null;
  const jumps = (profile.jumpIds?.length ?? 0) > 0;
  return (
    <fieldset className="wide">
      <legend>프록시</legend>
      <label>
        종류
        <select
          aria-label="프록시 종류"
          value={proxy?.kind ?? ''}
          disabled={jumps && !proxy}
          onChange={(e) => field('proxy', withProxyKind(proxy, e.target.value))}
        >
          <option value="">사용 안 함 · 직접 연결</option>
          <option value="http">HTTP CONNECT</option>
          <option value="socks5">SOCKS5</option>
          <option value="command">명령 (ProxyCommand)</option>
        </select>
      </label>
      {jumps && (
        <small>
          경유지가 있으면 첫 경유지가 TCP 연결을 엽니다. 프록시는 첫 경유지 세션에 지정하세요.
        </small>
      )}
      {proxy?.kind === 'command' && (
        <label className="wide">
          프록시 명령
          <input
            required
            className="mono"
            maxLength={4096}
            spellCheck={false}
            autoComplete="off"
            placeholder="ssh -W %h:%p jump.example.com"
            value={proxy.command}
            onChange={(e) => field('proxy', { ...proxy, command: e.target.value })}
          />
          <small>
            연결할 때 이 PC에서 실행하고 표준 입출력으로 SSH를 주고받습니다. %h 호스트, %p 포트, %r
            사용자, %n 원래 호스트 이름, %% 퍼센트 기호를 바꿔 넣습니다. 믿는 명령만 넣으세요.
          </small>
        </label>
      )}
      {proxy && proxy.kind !== 'command' && (
        <NetworkProxyFields
          proxy={proxy}
          change={(patch) => field('proxy', { ...proxy, ...patch })}
          passwordRef={passwordRef}
        />
      )}
    </fieldset>
  );
}

function NetworkProxyFields({
  proxy,
  change,
  passwordRef,
}: {
  proxy: NetworkProxy;
  change: (patch: Partial<NetworkProxy>) => void;
  passwordRef: MutableRefObject<ProxySecret>;
}) {
  const [action, setAction] = useState<ProxySecret['action']>('keep');
  const saved = !!proxy.secretRef;
  const choose = (next: ProxySecret['action']) => {
    setAction(next);
    passwordRef.current = { ...passwordRef.current, action: next };
  };
  return (
    <div className="form-grid">
      <label>
        프록시 호스트
        <input
          required
          maxLength={253}
          value={proxy.host}
          onChange={(e) => change({ host: e.target.value.trim() })}
        />
      </label>
      <label>
        프록시 포트
        <input
          required
          type="number"
          min={1}
          max={65535}
          value={proxy.port}
          onChange={(e) => change({ port: Number(e.target.value) })}
        />
      </label>
      <label className="wide">
        프록시 사용자 (선택)
        <input
          maxLength={255}
          autoComplete="off"
          placeholder="비워 두면 인증 없이 연결합니다"
          value={proxy.username}
          onChange={(e) => change({ username: e.target.value })}
        />
      </label>
      {proxy.username && (
        <>
          <label>
            프록시 암호
            <input
              type="password"
              autoComplete="off"
              maxLength={255}
              placeholder={saved ? '보안 저장소에 저장됨' : '비워 두면 연결할 때 묻습니다'}
              onChange={(e) => {
                passwordRef.current = { ...passwordRef.current, value: e.target.value };
                if (e.target.value && action === 'keep') choose('replace');
              }}
            />
          </label>
          <label>
            프록시 암호 보관
            <select
              aria-label="프록시 암호 보관"
              value={action}
              onChange={(e) => choose(e.target.value as ProxySecret['action'])}
            >
              <option value="keep">{saved ? '기존 저장 암호 유지' : '저장하지 않음'}</option>
              <option value="replace">입력한 암호를 보안 저장소에 저장</option>
              {saved && <option value="forget">저장된 암호 삭제</option>}
            </select>
          </label>
        </>
      )}
      <small className="wide">
        터미널·SFTP·터널·모니터링이 모두 이 프록시를 거칩니다. 프록시 주소나 사용자를 바꾸면 저장된
        프록시 암호는 지워집니다.
      </small>
    </div>
  );
}
