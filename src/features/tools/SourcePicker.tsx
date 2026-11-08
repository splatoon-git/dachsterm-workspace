import { useEffect, useId, useRef, useState } from 'react';
import { AuthPromptCard, HostKeyCard } from '../../components/ConnectionCards';
import { Icon } from '../../components/Icon';
import type { Profile } from '../../lib/ipc';
import { filterSessions } from './sourceLink';
import type { SourceControl } from './useSource';

function SessionSelect({
  profiles,
  live,
  selected,
  pick,
}: {
  profiles: Profile[];
  live: (profileId: string) => boolean;
  selected: Profile | null;
  pick: (profile: Profile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const shown = open ? filterSessions(profiles, query) : [];
  return (
    <div
      className="tool-session"
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        setOpen(false);
        root.current?.querySelector('button')?.focus();
      }}
    >
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        {selected?.name ?? '세션 선택'}
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div className="tool-session-list">
          <input
            type="search"
            aria-label="세션 검색"
            placeholder="이름·주소·계정"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {shown.map((profile) => (
            <button
              key={profile.id}
              onClick={() => {
                setOpen(false);
                setQuery('');
                pick(profile);
              }}
            >
              <strong>{profile.name}</strong>
              <span>
                {profile.username}@{profile.host}:{profile.port}
              </span>
              <small>{live(profile.id) ? '연결됨' : '미연결'}</small>
            </button>
          ))}
          {!shown.length && <p>찾은 SSH 세션이 없습니다.</p>}
        </div>
      )}
    </div>
  );
}

/** 출발지: this PC or a registered SSH session, with that session's login questions. */
export function SourcePicker({
  source,
  profiles,
  live,
}: {
  source: SourceControl;
  profiles: Profile[];
  live: (profileId: string) => boolean;
}) {
  const group = useId();
  const { link, mode } = source;
  const ended = link.status === 'closed' || link.status === 'error';
  return (
    <>
      <fieldset className="tool-source">
        <legend>출발지</legend>
        <label>
          <input
            type="radio"
            name={group}
            checked={mode === 'local'}
            onChange={source.chooseLocal}
          />
          로컬
        </label>
        <label>
          <input
            type="radio"
            name={group}
            checked={mode === 'remote'}
            onChange={source.chooseRemote}
          />
          리모트
        </label>
        {mode === 'remote' && (
          <SessionSelect
            profiles={profiles}
            live={live}
            selected={link.profile}
            pick={source.pick}
          />
        )}
        {mode === 'remote' && link.message && (
          <span className="tool-source-state" role="status">
            {link.message}
          </span>
        )}
        {mode === 'remote' && ended && <button onClick={source.retry}>다시 연결</button>}
      </fieldset>
      {link.hostKey && <HostKeyCard request={link.hostKey} answer={source.trust} />}
      {link.authPrompt && (
        <AuthPromptCard
          key={link.authPrompt.challenge}
          host={link.profile?.host ?? ''}
          prompt={link.authPrompt}
          reply={source.reply}
          cancel={source.cancel}
        />
      )}
    </>
  );
}
