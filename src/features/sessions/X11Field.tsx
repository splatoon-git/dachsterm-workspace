import type { Profile } from '../../lib/ipc';

/** X11 forwarding (CG.9): only relays to an X server the user already runs. */
export function X11Field({
  profile,
  field,
}: {
  profile: Profile;
  field: <K extends 'forwardX11' | 'x11Display'>(key: K, value: Profile[K]) => void;
}) {
  return (
    <div className="wide">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!profile.forwardX11}
          onChange={(e) => field('forwardX11', e.target.checked)}
        />
        X11 포워딩 (외부 X 서버 필요)
      </label>
      <p className="field-help">
        서버에서 띄운 그래픽 프로그램 창을 이 PC의 X 서버(XQuartz, VcXsrv 등)에 띄웁니다. 앱이 X
        서버를 대신하지는 않습니다. 서버에는 임시 인증 값만 보내고, 이 PC의 X 서버 인증 값은 보내지
        않습니다.
      </p>
      {profile.forwardX11 && (
        <label>
          X 디스플레이 (선택)
          <input
            maxLength={255}
            spellCheck={false}
            placeholder="비워 두면 DISPLAY 또는 localhost:0.0"
            value={profile.x11Display ?? ''}
            onChange={(e) => field('x11Display', e.target.value.trim())}
          />
        </label>
      )}
    </div>
  );
}
