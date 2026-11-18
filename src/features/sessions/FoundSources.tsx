import { useEffect, useState } from 'react';
import { call, desktop, errorText } from '../../lib/ipc';
import { requestSettings, type ImportSource } from '../../lib/settingsRequest';
import { dismissOffer, foundText, importable, offerDismissed, type Found } from './localImport';
import './transfer.css';

/** Looks for other programs' sessions on this PC once, and again on `refresh`. */
function useFound(enabled: boolean) {
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    call<Found[]>('config_detect').then(
      (list) => {
        if (!live) return;
        setFound(list);
        setError('');
      },
      (e) => {
        if (!live) return;
        setFound([]);
        setError(errorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, round]);
  return { found, error, refresh: () => setRound((n) => n + 1) };
}

/**
 * The empty connection list's offer to bring in sessions found on this PC. It shows only when
 * something was found, and stays away once dismissed.
 */
export function ImportOffer() {
  const [hidden, setHidden] = useState(offerDismissed);
  const { found } = useFound(desktop && !hidden);
  const usable = (found ?? []).filter(importable);
  if (hidden || !usable.length) return null;
  return (
    <div className="import-offer" role="group" aria-label="이 PC에서 찾은 세션">
      <p>이 PC에서 다른 프로그램의 세션을 찾았습니다. 가져올까요?</p>
      {usable.map((f) => (
        <button
          key={f.source}
          className="link-button"
          title={f.place}
          onClick={() => requestSettings({ section: 'transfer', importFrom: f.source })}
        >
          {foundText(f)} 가져오기…
        </button>
      ))}
      <button
        className="link-button import-offer-dismiss"
        onClick={() => {
          dismissOffer();
          setHidden(true);
        }}
      >
        다시 보지 않기
      </button>
    </div>
  );
}

/** The import settings' list of sources found on this PC, each opening its preview. */
export function FoundList({
  busy,
  preview,
}: {
  busy: boolean;
  preview: (source: ImportSource) => void;
}) {
  const { found, error, refresh } = useFound(desktop);
  if (!desktop) return null;
  return (
    <fieldset className="found-sources">
      <legend>이 PC에서 찾은 설정</legend>
      {found === null ? (
        <p className="muted">찾는 중…</p>
      ) : found.length ? (
        found.map((f) => (
          <div className="found-source" key={f.source}>
            <span>
              {foundText(f)}
              <small>{f.problem ?? f.place}</small>
            </span>
            <button disabled={busy || !importable(f)} onClick={() => preview(f.source)}>
              미리보기
            </button>
          </div>
        ))
      ) : (
        <p className="muted">
          PuTTY 레지스트리, 세션 북마크 파일, ~/.ssh/config에서 세션을 찾지 못했습니다.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={refresh}>
        다시 찾기
      </button>
    </fieldset>
  );
}
