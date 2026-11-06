import type { Group, Profile } from '../../lib/ipc';

export function groupPath(id: string | null | undefined, groups: Group[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const g = groups.find((g) => g.id === id);
    if (!g) break;
    names.unshift(g.name);
    id = g.parentId;
  }
  return names.join(' / ');
}
/** 경유 경로, 인코딩, CA처럼 연결 동작을 바꾸는 값은 고급 옵션에 접어 두지 않는다. */
export function hasConnectionOverrides(p: Profile) {
  return (p.jumpIds?.length ?? 0) > 0 || (p.encoding ?? 'utf-8') !== 'utf-8' || !!p.tlsCaPath;
}
export function inGroup(p: Profile, id: string, groups: Group[]) {
  let current = p.groupId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === id) return true;
    seen.add(current);
    current = groups.find((g) => g.id === current)?.parentId ?? null;
  }
  return false;
}
export function matchesSession(p: Profile, query: string, groups: Group[]) {
  return query
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .every((term) => {
      const [prefix, ...parts] = term.split(':');
      const value = parts.join(':');
      const fields: Record<string, string> = {
        tag: (p.tags ?? []).join(' '),
        host: p.host,
        user: p.username,
        group: groupPath(p.groupId, groups),
        protocol: p.protocol,
      };
      const text =
        value && prefix in fields
          ? fields[prefix]
          : `${p.name} ${p.host} ${p.username} ${(p.tags ?? []).join(' ')} ${groupPath(p.groupId, groups)}`;
      return text.toLocaleLowerCase().includes(value && prefix in fields ? value : term);
    });
}
export function routeNames(p: Profile, profiles: Profile[], seen = new Set<string>()): string[] {
  if (seen.has(p.id)) return ['순환 참조'];
  seen.add(p.id);
  return [
    ...(p.jumpIds ?? []).flatMap((id) => {
      const hop = profiles.find((p) => p.id === id);
      return hop ? routeNames(hop, profiles, seen) : ['없는 경유지'];
    }),
    `${p.name || '최종 서버'} (${p.host}:${p.port})`,
  ];
}
export function importSelection<
  T extends {
    profiles: Profile[];
    groups: Group[];
    tunnels: { profileId: string }[];
    templates?: { options: { groupId?: string | null } }[];
  },
>(bundle: T, selected: string[]): T {
  const ids = new Set(selected);
  function add(id: string) {
    const p = bundle.profiles.find((p) => p.id === id);
    for (const hop of p?.jumpIds ?? [])
      if (!ids.has(hop)) {
        ids.add(hop);
        add(hop);
      }
  }
  selected.forEach(add);
  const groups = new Set<string>();
  function addGroup(id: string | null | undefined) {
    if (!id || groups.has(id)) return;
    groups.add(id);
    addGroup(bundle.groups.find((g) => g.id === id)?.parentId);
  }
  bundle.profiles.filter((p) => ids.has(p.id)).forEach((p) => addGroup(p.groupId));
  bundle.templates?.forEach((t) => addGroup(t.options.groupId));
  return {
    ...bundle,
    profiles: bundle.profiles.filter((p) => ids.has(p.id)),
    groups: bundle.groups.filter((g) => groups.has(g.id)),
    tunnels: bundle.tunnels.filter((t) => ids.has(t.profileId)),
  };
}
