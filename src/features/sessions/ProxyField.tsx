import { useState, type MutableRefObject } from 'react';
import type { Profile, Proxy } from '../../lib/ipc';
import { withProxyKind, type ProxySecret } from './proxy';

/** The proxy of an SSH session (CG.1). The password goes to the secure store, never the form. */
export function ProxyField({
  profile,
  field,
  passwordRef,
}: {
  profile: Profile;
  field: (key: 'proxy', value: Proxy | null) => void;
  passwordRef: MutableRefObject<ProxySecret>;
}) {
  const [action, setAction] = useState<ProxySecret['action']>('keep');
  const proxy = profile.proxy ?? null;
  const jumps = (profile.jumpIds?.length ?? 0) > 0;
  const saved = !!proxy?.secretRef;
  const choose = (next: ProxySecret['action']) => {
    setAction(next);
    passwordRef.current = { ...passwordRef.current, action: next };
  };
  const change = (patch: Partial<Proxy>) => proxy && field('proxy', { ...proxy, ...patch });
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
        </select>
      </label>
      {jumps && (
        <small>
          경유지가 있으면 첫 경유지가 TCP 연결을 엽니다. 프록시는 첫 경유지 세션에 지정하세요.
        </small>
      )}
      {proxy && (
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
            터미널·SFTP·터널·모니터링이 모두 이 프록시를 거칩니다. 프록시 주소나 사용자를 바꾸면
            저장된 프록시 암호는 지워집니다.
          </small>
        </div>
      )}
    </fieldset>
  );
}
