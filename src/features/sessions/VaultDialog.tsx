import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { call, errorText } from '../../lib/ipc';
import './vault.css';
export type VaultStatus = { enabled: boolean; unlocked: boolean; seconds: number };
type RevealProfile = { id: string; name: string };

export const vaultSummary =
  '서버 암호와 Passphrase는 OS 보안 저장소에 보관합니다. 마스터 패스워드를 정하면 한 번 더 암호화합니다.';

/** The master password as its own dialog: asked before a connection, or to show a saved secret. */
export function VaultDialog({
  close,
  revealProfile,
  unlocked,
}: {
  close: () => void;
  revealProfile?: RevealProfile;
  unlocked?: () => void;
}) {
  return (
    <Dialog
      title={revealProfile ? `${revealProfile.name} 저장된 암호 보기` : '마스터 패스워드'}
      description={
        revealProfile ? '암호를 볼 때마다 마스터 패스워드를 다시 확인합니다.' : vaultSummary
      }
      size="small"
      close={close}
    >
      <VaultPanel revealProfile={revealProfile} unlocked={unlocked} done={close} />
    </Dialog>
  );
}

/** Status, unlock, change and lock for the master password. Settings shows it in place. */
export function VaultPanel({
  revealProfile,
  unlocked,
  done,
}: {
  revealProfile?: RevealProfile;
  unlocked?: () => void;
  done?: () => void;
}) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [mode, setMode] = useState('unlock');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(false);
  const current = useRef<HTMLInputElement>(null);
  const next = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLInputElement>(null);
  const shown = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const revealEpoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function hide() {
    revealEpoch.current += 1;
    if (timer.current) clearTimeout(timer.current);
    if (shown.current) shown.current.value = '';
    setVisible(false);
  }
  useEffect(() => {
    alive.current = true;
    void call<VaultStatus>('vault_status')
      .then((s) => {
        if (alive.current) {
          setStatus(s);
          setMode(s.enabled ? 'unlock' : 'configure');
        }
      })
      .catch((e) => {
        if (alive.current) setError(errorText(e));
      });
    const blur = () => {
      revealEpoch.current += 1;
      if (shown.current) shown.current.value = '';
      setVisible(false);
    };
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', blur);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', blur);
    };
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    hide();
    const epoch = revealEpoch.current;
    setError('');
    setMessage('');
    const password = current.current?.value ?? '';
    const newPassword = next.current?.value ?? '';
    const confirmation = confirm.current?.value ?? '';
    if (current.current) current.current.value = '';
    if (next.current) next.current.value = '';
    if (confirm.current) confirm.current.value = '';
    if (mode === 'configure' && newPassword !== confirmation) {
      setError('새 마스터 패스워드가 일치하지 않습니다. 다시 입력하세요.');
      return;
    }
    setBusy(true);
    try {
      const action = mode === 'configure' ? 'configure' : revealProfile ? 'reveal' : 'unlock';
      const value = await call<string | null>('vault_action', {
        action,
        password,
        newPassword: mode === 'configure' ? newPassword : null,
        profileId: revealProfile?.id ?? null,
      });
      if (!alive.current) return;
      if (action === 'reveal' && value !== null) {
        if (epoch !== revealEpoch.current) return;
        if (shown.current) shown.current.value = value;
        setVisible(true);
        timer.current = setTimeout(hide, 30000);
      } else if (action === 'unlock' && unlocked) {
        unlocked();
        done?.();
      } else {
        setMessage(
          action === 'configure'
            ? '마스터 패스워드를 저장했습니다.'
            : '5분 동안 잠금을 해제했습니다.',
        );
        setMode('unlock');
      }
      const s = await call<VaultStatus>('vault_status');
      if (alive.current) setStatus(s);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function lock() {
    hide();
    try {
      await call('vault_lock');
      setStatus(await call<VaultStatus>('vault_status'));
      setMessage('암호 보관함을 잠갔습니다.');
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <div className="vault-panel">
      {status && (
        <p className={`vault-state ${status.unlocked ? 'open' : ''}`} role="status">
          <Icon name="lock" size={14} />
          {status.enabled
            ? status.unlocked
              ? '잠금 해제됨 · 5분이 지나면 자동으로 잠깁니다'
              : '잠김 · 연결할 때 마스터 패스워드를 묻습니다'
            : '마스터 패스워드 없음 · OS 보안 저장소만 사용합니다'}
        </p>
      )}
      {status && (
        <form onSubmit={(e) => void submit(e)}>
          {(status.enabled || mode !== 'configure') && (
            <label>
              현재 마스터 패스워드
              <input ref={current} type="password" required autoComplete="off" maxLength={1024} />
            </label>
          )}
          {mode === 'configure' && (
            <>
              <label>
                새 마스터 패스워드
                <input
                  ref={next}
                  type="password"
                  required
                  minLength={12}
                  maxLength={1024}
                  autoComplete="new-password"
                />
              </label>
              <label>
                새 마스터 패스워드 확인
                <input
                  ref={confirm}
                  type="password"
                  required
                  minLength={12}
                  maxLength={1024}
                  autoComplete="new-password"
                />
              </label>
              <p className="field-help">
                12자 이상으로 정하세요. 잊어버리면 저장된 암호를 되살릴 수 없습니다. 이미 저장된
                서버 암호도 함께 암호화됩니다.
              </p>
            </>
          )}
          {revealProfile && mode !== 'configure' && (
            <p className="field-help">30초가 지나거나 다른 창으로 옮기면 다시 숨깁니다.</p>
          )}
          <div className="form-actions">
            {status.enabled && !revealProfile && (
              <button
                type="button"
                className="start"
                disabled={busy}
                onClick={() => {
                  hide();
                  setMode(mode === 'configure' ? 'unlock' : 'configure');
                }}
              >
                {mode === 'configure' ? '잠금 해제로 돌아가기' : '마스터 패스워드 변경'}
              </button>
            )}
            {status.unlocked && (
              <button type="button" disabled={busy} onClick={() => void lock()}>
                지금 잠금
              </button>
            )}
            <button className="primary" disabled={busy}>
              {busy
                ? '처리 중…'
                : mode === 'configure'
                  ? '마스터 패스워드 저장'
                  : revealProfile
                    ? '확인 후 암호 표시'
                    : '잠금 해제'}
            </button>
          </div>
        </form>
      )}
      <div hidden={!visible} className="secret-reveal">
        <label>
          저장된 암호
          <input
            ref={shown}
            readOnly
            autoComplete="off"
            spellCheck={false}
            aria-label="저장된 암호"
          />
        </label>
        <button onClick={hide}>암호 숨기기</button>
      </div>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
