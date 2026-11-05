import type { Profile } from '../../lib/ipc';
import { routeNames } from './model';

export function JumpEditor({
  profile,
  profiles,
  change,
}: {
  profile: Profile;
  profiles: Profile[];
  change: (ids: string[]) => void;
}) {
  const ids = profile.jumpIds ?? [];
  return (
    <fieldset className="wide">
      <legend>점프 호스트 · 순서대로 경유</legend>
      <ol>
        {ids.map((id, i) => (
          <li key={`${id}-${i}`}>
            {profiles.find((p) => p.id === id)?.name ?? '없는 경유지'}
            <button
              type="button"
              disabled={i === 0}
              aria-label={`${i + 1}번 경유지 위로`}
              onClick={() => {
                const next = [...ids];
                [next[i - 1], next[i]] = [next[i], next[i - 1]];
                change(next);
              }}
            >
              ↑
            </button>
            <button type="button" onClick={() => change(ids.filter((_, n) => n !== i))}>
              제거
            </button>
          </li>
        ))}
      </ol>
      <label>
        경유 프로필 추가
        <select
          value=""
          disabled={ids.length >= 4}
          onChange={(e) => {
            if (e.target.value) change([...ids, e.target.value]);
          }}
        >
          <option value="">직접 연결 / 경유지 선택</option>
          {profiles
            .filter((p) => p.protocol === 'ssh' && p.id !== profile.id && !ids.includes(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.host}:{p.port}
              </option>
            ))}
        </select>
      </label>
      <p className="muted">{routeNames(profile, profiles).join(' → ')}</p>
      <small>
        경유 프로필의 경로도 포함해 최대 4홉입니다. 변경은 새 연결부터 적용되며, 참조 중인 경유지는
        삭제할 수 없습니다. 각 홉에서 인증과 호스트키를 확인합니다.
      </small>
    </fieldset>
  );
}
