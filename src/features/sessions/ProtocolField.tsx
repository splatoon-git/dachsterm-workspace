import type { Profile } from '../../lib/ipc';
import type { Protocol } from './protocol';

/** The protocol choice and what the user must know about the one chosen. */
export function ProtocolField({
  value,
  change,
}: {
  value: Profile['protocol'] | undefined;
  change: (protocol: Protocol) => void;
}) {
  return (
    <>
      <label>
        프로토콜
        <select value={value ?? 'ssh'} onChange={(e) => change(e.target.value as Protocol)}>
          <option value="ssh">SSH + SFTP</option>
          <option value="ftps">FTPS · 명시적 TLS</option>
          <option value="ftp">FTP · 암호화 없음</option>
          <option value="telnet">Telnet · 암호화 없음</option>
        </select>
      </label>
      {value === 'ftp' && (
        <p className="muted wide">
          FTP는 로그인 정보와 파일을 암호화하지 않습니다. 서버가 지원하면 FTPS를 선택하세요.
        </p>
      )}
      {value === 'telnet' && (
        <p className="muted wide" role="note">
          Telnet은 암호를 포함한 모든 입력을 암호화하지 않고 보냅니다. 암호는 저장하지 않으며,
          로그인은 연결된 터미널에서 직접 입력합니다. 장비가 지원하면 SSH를 쓰세요.
        </p>
      )}
    </>
  );
}
