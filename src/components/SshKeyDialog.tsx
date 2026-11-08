import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { call, errorText } from '../lib/ipc';
import { Dialog } from './Dialog';
import './sshKeyDialog.css';

/** What `ssh_key_generate` returns. The private key stays in its file. */
export interface GeneratedKey {
  path: string;
  publicKey: string;
  fingerprint: string;
}
interface KeyDefaults {
  folder: string;
  comment: string;
}

function Finished({ made, close }: { made: GeneratedKey; close: () => void }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  function copy() {
    setError('');
    void call('clipboard_write_text', { text: made.publicKey }).then(
      () => setCopied(true),
      (e: unknown) => setError(errorText(e)),
    );
  }
  return (
    <>
      <p>서버의 ~/.ssh/authorized_keys에 아래 공개키를 추가하면 이 키로 접속할 수 있습니다.</p>
      <dl className="ssh-key-result">
        <dt>저장 위치</dt>
        <dd>{made.path}</dd>
        <dt>지문</dt>
        <dd>{made.fingerprint}</dd>
      </dl>
      <label>
        공개키
        <textarea
          className="ssh-key-public"
          readOnly
          rows={3}
          spellCheck={false}
          value={made.publicKey}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" onClick={close}>
          닫기
        </button>
        <button type="button" className="primary" onClick={copy}>
          {copied ? '복사했습니다' : '공개키 복사'}
        </button>
      </div>
    </>
  );
}

/**
 * Makes an Ed25519 key pair. Rendered on `body` because it also opens from inside the session
 * form, and a form cannot hold another; React still bubbles through the portal, so the submit
 * stops here. Passphrases stay in uncontrolled inputs and are not kept in state.
 */
export default function SshKeyDialog({
  close,
  created,
}: {
  close: () => void;
  /** Runs once the files exist, before the result is shown. */
  created?: (key: GeneratedKey) => void;
}) {
  const [name, setName] = useState('id_ed25519');
  const [comment, setComment] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<GeneratedKey | null>(null);
  const passphrase = useRef<HTMLInputElement>(null);
  const repeated = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let current = true;
    call<KeyDefaults>('ssh_key_defaults').then(
      (defaults) => {
        if (!current) return;
        setFolder((value) => value || defaults.folder);
        setComment((value) => value || defaults.comment);
      },
      (e: unknown) => {
        if (current) setError(errorText(e));
      },
    );
    return () => {
      current = false;
    };
  }, []);
  function pickFolder() {
    setError('');
    call<string | null>('ssh_key_pick_folder').then(
      (picked) => {
        if (picked) setFolder(picked);
      },
      (e: unknown) => setError(errorText(e)),
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const secret = passphrase.current?.value ?? '';
    if (secret !== (repeated.current?.value ?? ''))
      return setError('두 Passphrase가 서로 다릅니다.');
    setBusy(true);
    setError('');
    try {
      const key = await call<GeneratedKey>('ssh_key_generate', {
        name: name.trim(),
        comment: comment.trim(),
        passphrase: secret,
        folder: folder.trim(),
      });
      created?.(key);
      setMade(key);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const leave = () => {
    if (!busy) close();
  };
  return createPortal(
    <Dialog
      title="SSH 키 만들기"
      description="Ed25519 키 한 쌍을 이 PC에 만듭니다. 개인키는 이 PC를 떠나지 않습니다."
      close={leave}
    >
      {made ? (
        <Finished made={made} close={leave} />
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <div className="form-grid">
            <label>
              파일 이름
              <input
                required
                maxLength={128}
                spellCheck={false}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              주석
              <input
                maxLength={256}
                spellCheck={false}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </label>
            <label>
              Passphrase (선택)
              <input ref={passphrase} type="password" autoComplete="off" maxLength={16384} />
            </label>
            <label>
              Passphrase 확인
              <input ref={repeated} type="password" autoComplete="off" maxLength={16384} />
            </label>
            <div className="wide ssh-key-folder">
              <label>
                저장 폴더
                <input
                  required
                  spellCheck={false}
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                />
              </label>
              <button type="button" disabled={busy} onClick={pickFolder}>
                찾아보기…
              </button>
            </div>
          </div>
          {error && <p role="alert">{error}</p>}
          <div className="form-actions">
            <button type="button" disabled={busy} onClick={close}>
              취소
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? '만드는 중…' : '만들기'}
            </button>
          </div>
        </form>
      )}
    </Dialog>,
    document.body,
  );
}
