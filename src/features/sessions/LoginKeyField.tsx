import { NewSshKeyButton } from '../../components/NewSshKey';

/** The private key a session logs in with: a path, or a key made on the spot. */
export function LoginKeyField({
  value,
  change,
}: {
  value: string;
  change: (path: string) => void;
}) {
  return (
    <div className="wide login-key-field">
      <label>
        개인키 파일 경로
        <input
          required
          placeholder="C:\Users\…\.ssh\id_ed25519"
          value={value}
          onChange={(e) => change(e.target.value)}
        />
      </label>
      <NewSshKeyButton created={(key) => change(key.path)} />
    </div>
  );
}
