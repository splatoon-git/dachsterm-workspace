import { VaultDialog } from './VaultDialog';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { JumpEditor } from './JumpEditor';
import { groupPath } from './model';
import type { SessionTemplate } from './SessionManager';
import { call, errorText, type Group, type Profile } from '../../lib/ipc';
export function SessionForm({
  initial,
  groups,
  profiles,
  close,
  saved,
}: {
  initial: Profile;
  groups: Group[];
  profiles: Profile[];
  close: () => void;
  saved: (profile: Profile, connect: boolean, secret: string | null) => void;
}) {
  const [vaultOpen, setVaultOpen] = useState<'manage' | 'reveal' | null>(null);
  const [profile, setProfile] = useState(initial);
  const [tags, setTags] = useState((initial.tags ?? []).join(', '));
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  useEffect(() => {
    call<SessionTemplate[]>('session_templates')
      .then(setTemplates)
      .catch(() => {});
  }, []);
  const [secretAction, setSecretAction] = useState('keep');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const secret = useRef<HTMLInputElement>(null);
  const field = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setProfile((p) => ({ ...p, [key]: value }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const connect =
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'connect';
    const value: string | null = secret.current?.value || null;
    if (secret.current) secret.current.value = '';
    try {
      const p = await call<Profile>('save_session', {
        profile: {
          ...profile,
          tags: tags
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
        },
        secretAction,
        secret: secretAction === 'replace' ? value : null,
      });
      saved(p, connect, value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={initial.id ? '세션 수정' : '새 연결'}
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          <label className="wide">
            공통 설정 템플릿
            <select
              value=""
              onChange={(e) => {
                const t = templates.find((t) => t.id === e.target.value);
                if (!t) return;
                const patch = Object.fromEntries(
                  Object.entries(t.options).filter(([, v]) => v !== null),
                );
                setProfile((p) => ({
                  ...p,
                  ...patch,
                  groupId:
                    t.options.groupId === undefined || t.options.groupId === null
                      ? p.groupId
                      : t.options.groupId || null,
                }));
                if (t.options.tags) setTags(t.options.tags.join(', '));
              }}
            >
              <option value="">템플릿 선택 · 암호는 복제하지 않음</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="wide">
            이름
            <input
              autoFocus
              required
              maxLength={200}
              value={profile.name}
              onChange={(e) => field('name', e.target.value)}
            />
          </label>
          <label>
            호스트
            <input
              required
              maxLength={253}
              placeholder="server.example.com"
              value={profile.host}
              onChange={(e) => field('host', e.target.value.trim())}
            />
          </label>
          <label>
            포트
            <input
              required
              type="number"
              min={1}
              max={65535}
              value={profile.port}
              onChange={(e) => field('port', Number(e.target.value))}
            />
          </label>
          <label>
            사용자
            <input
              required
              maxLength={256}
              value={profile.username}
              onChange={(e) => field('username', e.target.value)}
            />
          </label>
          <label>
            프로토콜
            <select
              value={profile.protocol ?? 'ssh'}
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  protocol: e.target.value as Profile['protocol'],
                  port: [21, 22].includes(p.port) ? (e.target.value === 'ssh' ? 22 : 21) : p.port,
                  auth: e.target.value === 'ssh' ? p.auth : 'password',
                  jumpIds: e.target.value === 'ssh' ? p.jumpIds : [],
                }))
              }
            >
              <option value="ssh">SSH + SFTP</option>
              <option value="ftps">FTPS · 명시적 TLS</option>
              <option value="ftp">FTP · 암호화 없음</option>
            </select>
          </label>
          {profile.protocol === 'ftp' && (
            <p className="muted wide">
              FTP는 로그인 정보와 파일을 암호화하지 않습니다. 서버가 지원하면 FTPS를 선택하세요.
            </p>
          )}
          {profile.protocol === 'ftps' && (
            <label className="wide">
              추가 CA 인증서 경로 (선택)
              <input
                value={profile.tlsCaPath ?? ''}
                onChange={(e) => field('tlsCaPath', e.target.value)}
                placeholder="기본값: OS 인증서 검증"
              />
              <small>인증서와 서버 이름을 검증하며 TLS 실패 시 FTP로 전환하지 않습니다.</small>
            </label>
          )}
          <label>
            인증 방식
            <select
              aria-label="인증 방식"
              disabled={!!profile.protocol && profile.protocol !== 'ssh'}
              value={profile.auth}
              onChange={(e) => {
                field('auth', e.target.value as Profile['auth']);
                if (secret.current) secret.current.value = '';
                if (['agent', 'interactive'].includes(e.target.value)) setSecretAction('forget');
              }}
            >
              <option value="password">비밀번호</option>
              <option value="key">개인키</option>
              <option value="agent">SSH agent · OS 인증 에이전트</option>
              <option value="interactive">서버 질문 · OTP / MFA</option>
            </select>
          </label>
          <label className="wide">
            {profile.protocol && profile.protocol !== 'ssh'
              ? 'FTP 파일명·명령 인코딩'
              : '터미널 인코딩'}
            <select
              value={profile.encoding ?? 'utf-8'}
              onChange={(e) => field('encoding', e.target.value)}
            >
              <option value="utf-8">UTF-8 (기본)</option>
              <option value="euc-kr">CP949 / EUC-KR · 한국어</option>
              <option value="shift_jis">Shift_JIS · 일본어</option>
              <option value="gbk">GBK · 중국어 간체</option>
              <option value="big5">Big5 · 중국어 번체</option>
              <option value="windows-1252">Windows-1252 · 서유럽</option>
            </select>
            <small>
              서버 로케일과 맞추세요. 송신·수신에 함께 적용되며 변경은 새 연결부터 적용됩니다. 파일
              전송 내용은 변환하지 않습니다.
            </small>
          </label>
          {profile.auth === 'key' && (
            <label className="wide">
              개인키 파일 경로
              <input
                required
                placeholder="C:\Users\…\.ssh\id_ed25519"
                value={profile.keyPath}
                onChange={(e) => field('keyPath', e.target.value)}
              />
            </label>
          )}
          {['agent', 'interactive'].includes(profile.auth) && (
            <p className="muted wide">
              에이전트는 등록된 키로 서명하며 개인키를 앱에 저장하지 않습니다. 서버의 OTP·추가 인증
              질문은 연결 중 표시되고 응답은 저장하지 않습니다. 키 인증 뒤 추가 MFA도 자동으로
              표시합니다.
            </p>
          )}
          {['key', 'password'].includes(profile.auth) && (
            <label className="wide">
              {profile.auth === 'key'
                ? 'Passphrase (암호화되지 않은 키는 비워 두세요)'
                : '비밀번호'}
              <input
                ref={secret}
                type="password"
                autoComplete="off"
                maxLength={16384}
                placeholder={
                  initial.hasSecret
                    ? 'OS 저장소에 저장됨 · 새 값 입력 시 대체 가능'
                    : '이번 연결에만 사용하거나 OS 저장소에 저장'
                }
              />
            </label>
          )}
          <div className="wide form-actions">
            <button type="button" onClick={() => setVaultOpen('manage')}>
              마스터 패스워드 · 잠금 해제
            </button>
            {initial.hasSecret && (
              <button type="button" onClick={() => setVaultOpen('reveal')}>
                저장된 암호 보기
              </button>
            )}
          </div>
          <label className="wide">
            인증정보 보관
            <select
              aria-label="인증정보 보관"
              disabled={['agent', 'interactive'].includes(profile.auth)}
              value={secretAction}
              onChange={(e) => setSecretAction(e.target.value)}
            >
              <option value="keep">
                {initial.hasSecret ? '기존 저장 정보 유지' : '저장하지 않음'}
              </option>
              <option value="replace">입력한 값을 암호화 보관</option>
              <option value="forget">저장된 인증정보 삭제 · 이번에만 사용</option>
            </select>
          </label>
          <label>
            그룹
            <select
              aria-label="그룹"
              value={profile.groupId ?? ''}
              onChange={(e) => field('groupId', e.target.value || null)}
            >
              <option value="">그룹 없음</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {groupPath(g.id, groups)}
                </option>
              ))}
            </select>
          </label>
          <label className="wide">
            태그 (쉼표 구분)
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <label>
            정렬 순서
            <input
              type="number"
              value={profile.sortOrder ?? 0}
              onChange={(e) => field('sortOrder', Number(e.target.value))}
            />
          </label>
          {profile.protocol === 'ssh' && (
            <JumpEditor
              profile={profile}
              profiles={profiles}
              change={(ids) => field('jumpIds', ids)}
            />
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={profile.favorite}
              onChange={(e) => field('favorite', e.target.checked)}
            />
            즐겨찾기
          </label>
          <label>
            접속 타임아웃 (초)
            <input
              type="number"
              required
              min={5}
              max={120}
              value={profile.timeout}
              onChange={(e) => field('timeout', Number(e.target.value))}
            />
          </label>
          <label>
            KeepAlive (초)
            <input
              type="number"
              required
              min={5}
              max={300}
              value={profile.keepalive}
              onChange={(e) => field('keepalive', Number(e.target.value))}
            />
          </label>
        </div>
        <p className="muted">
          비밀정보는 SQLite에 기록하지 않습니다. 저장소를 사용할 수 없으면 ‘저장하지 않음’으로
          연결하세요.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" disabled={busy} onClick={close}>
            취소
          </button>
          <button disabled={busy} type="submit" value="save">
            저장
          </button>
          <button className="primary" disabled={busy} type="submit" value="connect">
            저장 후 연결
          </button>
        </div>
      </form>
      {vaultOpen && (
        <VaultDialog
          close={() => setVaultOpen(null)}
          revealProfile={vaultOpen === 'reveal' ? initial : undefined}
        />
      )}
    </Dialog>
  );
}
