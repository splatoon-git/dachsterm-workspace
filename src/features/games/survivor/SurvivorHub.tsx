import { useState, useSyncExternalStore } from 'react';
import {
  GOLD_CAP,
  UNLOCKS,
  UNLOCK_IDS,
  UPGRADES,
  UPGRADE_IDS,
  purchaseQuote,
  refundAmount,
  type Purchase,
} from './profile';
import { SurvivorProfileStore } from './profileStore';
import './hub.css';

/** Standalone hub; G.8.5 owns the tab/session lifetime and supplies start callbacks. */
export function SurvivorHub({
  store,
  onStart,
  onTemporaryStart,
}: {
  store: SurvivorProfileStore;
  onStart: (revision: number) => void;
  onTemporaryStart: () => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const p = state.profile;
  const [refund, setRefund] = useState<{ revision: number; amount: number } | null>(null);
  const [retry, setRetry] = useState<(() => boolean) | null>(null);
  const [notice, setNotice] = useState('');
  const writable = state.mode === 'owner' && !p.checkpoint;
  const execute = (action: () => boolean, message: string) => {
    if (action()) {
      setRetry(null);
      setRefund(null);
      setNotice(message);
    } else {
      setRetry(() => action);
      setNotice('변경이 저장되지 않았습니다.');
    }
  };
  const purchase = (item: Purchase) =>
    execute(
      () => store.purchase(item, p.revision),
      '구매를 저장했습니다. 다음 도전부터 적용됩니다.',
    );
  return (
    <section
      className="survivor-hub"
      aria-label="닥스의 서바이버 쉼터"
      onKeyDownCapture={(e) => {
        if (
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          e.repeat &&
          (e.key === 'Enter' || e.key === ' ') &&
          e.target instanceof HTMLButtonElement
        )
          e.preventDefault();
      }}
    >
      <h2>닥스의 서바이버 · 쉼터</h2>
      <p>
        골드 <strong data-testid="survivor-balance">{p.gold.toLocaleString()}</strong> · 강화를
        준비하고 새로운 도전을 시작하세요.
      </p>
      <p role="status">{state.error ?? notice}</p>
      {state.mode === 'loading' && <p>저장 소유권을 확인하고 있습니다.</p>}
      {state.mode === 'readonly' && (
        <p>
          다른 창에서 사용 중입니다. 이 쉼터는 읽기 전용입니다.{' '}
          <button onClick={() => void store.connect()}>소유권 다시 확인</button>
        </p>
      )}
      {(state.mode === 'temporary' || state.mode === 'blocked' || (writable && state.error)) && (
        <div>
          <p>임시 플레이는 기본 능력으로 시작하며 보상·기록을 저장하지 않습니다.</p>
          <button onClick={onTemporaryStart}>저장 없이 임시 플레이</button>
        </div>
      )}
      {state.mode === 'owner' && p.checkpoint && (
        <p>
          이전 중단 판의 정산이 남아 있습니다.{' '}
          <button onClick={() => store.recover()}>정산 저장 재시도</button>
        </p>
      )}
      {retry && writable && (
        <button onClick={() => execute(retry, '변경을 저장했습니다.')}>저장 재시도</button>
      )}
      <button disabled={!writable} onClick={() => onStart(p.revision)}>
        새 도전 시작
      </button>
      <h3>영구 강화</h3>
      <div className="survivor-shop">
        {UPGRADE_IDS.map((id) => {
          const spec = UPGRADES[id],
            q = purchaseQuote(p, { kind: 'upgrade', id });
          return (
            <article key={id} aria-label={spec.name}>
              <h4>
                {spec.name}{' '}
                <small>
                  {q.rank}/{spec.costs.length}
                </small>
              </h4>
              <p>
                {spec.effect} +{q.rank * spec.perRank}%
                {q.cost !== undefined && ` → +${(q.rank + 1) * spec.perRank}%`}
              </p>
              <p>
                {q.cost === undefined
                  ? '최대 단계'
                  : `${q.cost} 골드 · 구매 후 ${q.balanceAfter < 0 ? '잔액 부족' : `${q.balanceAfter.toLocaleString()} 골드`}`}
              </p>
              <button
                disabled={!writable || !q.available}
                onClick={(e) => {
                  if (e.detail <= 1) purchase({ kind: 'upgrade', id });
                }}
              >
                {spec.name} 강화
              </button>
            </article>
          );
        })}
      </div>
      <h3>무기와 다시 뽑기 해금</h3>
      <div className="survivor-shop">
        {UNLOCK_IDS.map((id) => {
          const spec = UNLOCKS[id],
            q = purchaseQuote(p, { kind: 'unlock', id });
          return (
            <article key={id} aria-label={spec.name}>
              <h4>{spec.name}</h4>
              <p>{spec.effect}</p>
              <p>
                {q.rank
                  ? '해금 완료'
                  : `${spec.cost} 골드 · 구매 후 ${q.balanceAfter < 0 ? '잔액 부족' : `${q.balanceAfter.toLocaleString()} 골드`}`}
              </p>
              <button
                disabled={!writable || !q.available}
                onClick={(e) => {
                  if (e.detail <= 1) purchase({ kind: 'unlock', id });
                }}
              >
                {spec.name} 해금
              </button>
            </article>
          );
        })}
      </div>
      <p>무기는 도전 중 카드로 장착합니다. 무기·다시 뽑기 해금은 환불되지 않습니다.</p>
      <button
        disabled={!writable || !UPGRADE_IDS.some((id) => p.upgrades[id].rank)}
        onClick={() => setRefund({ revision: p.revision, amount: refundAmount(p) })}
      >
        영구 강화 전액 환불
      </button>
      {refund && (
        <div className="survivor-refund" role="group" aria-label="환불 확인">
          <p>
            강화 4종을 초기화하고 실제 지불액 {refund.amount.toLocaleString()} 골드를 돌려받습니다.
            환불 후 잔액 {Math.min(GOLD_CAP, p.gold + refund.amount).toLocaleString()} 골드. 잔액
            상한 {GOLD_CAP.toLocaleString()}을 넘는 금액은 버립니다.
          </p>
          <button
            disabled={!writable || refund.revision !== p.revision}
            onClick={() =>
              execute(() => store.refund(refund.revision), '강화 환불을 저장했습니다.')
            }
          >
            환불 확정
          </button>
          <button onClick={() => setRefund(null)}>취소</button>
        </div>
      )}
      <h3>기록</h3>
      <p>
        최고 통과 {p.records.highestCompletedStage} · 최고 도달 {p.records.highestReachedStage} ·
        최장 전투 {Math.floor(p.records.longestTicks / 60)}초 · 최고 레벨 {p.records.highestLevel} ·
        최다 처치 {p.records.mostKills} · 누적 보스 {p.records.totalBosses}
      </p>
      <label>
        <input
          type="checkbox"
          checked={p.settings.muted}
          disabled={!writable}
          onChange={(e) => {
            const settings = { ...p.settings, muted: e.target.checked };
            execute(() => store.settings(settings, p.revision), '소리 설정을 저장했습니다.');
          }}
        />
        효과음 끄기
      </label>
      <label>
        모션{' '}
        <select
          value={p.settings.motion}
          disabled={!writable}
          onChange={(e) => {
            const settings = { ...p.settings, motion: e.target.value as typeof p.settings.motion };
            execute(() => store.settings(settings, p.revision), '모션 설정을 저장했습니다.');
          }}
        >
          <option value="system">시스템 설정</option>
          <option value="reduced">줄이기</option>
          <option value="full">전체</option>
        </select>
      </label>
    </section>
  );
}
