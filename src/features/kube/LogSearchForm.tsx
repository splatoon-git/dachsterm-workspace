import type { Dispatch, RefObject, SetStateAction } from 'react';
import { MAX_PODS, scopeKinds, type ScopeKind } from './logSearchModel';
import type { SearchForm } from './useLogSearch';

const SINCE_CHOICES = [
  { id: '15m', label: '최근 15분' },
  { id: '1h', label: '최근 1시간' },
  { id: '6h', label: '최근 6시간' },
  { id: '24h', label: '최근 24시간' },
  { id: 'custom', label: '직접 입력' },
];
const AROUND_CHOICES = [5, 10, 20, 50];

/** What to search and how the results are shown. */
export function LogSearchForm({
  form,
  setForm,
  session,
  options,
  targetCount,
  running,
  ready,
  run,
  cancel,
  keywordBox,
}: {
  form: SearchForm;
  setForm: Dispatch<SetStateAction<SearchForm>>;
  session: string;
  options: string[];
  targetCount: number;
  running: boolean;
  ready: boolean;
  run: () => void;
  cancel: () => void;
  keywordBox: RefObject<HTMLInputElement | null>;
}) {
  const setKind = (kind: ScopeKind) => setForm((now) => ({ ...now, scope: { kind, value: '' } }));
  return (
    <>
      <div className="kube-search-tools">
        <select
          aria-label="범위 종류"
          value={form.scope.kind}
          onChange={(event) => setKind(event.target.value as ScopeKind)}
        >
          {scopeKinds.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        {form.scope.kind !== 'all' && form.scope.kind !== 'controller' && (
          <>
            <input
              type="search"
              aria-label="범위"
              list={`kube-search-scope-${session}`}
              value={form.scope.value}
              placeholder="이름을 입력하거나 고르세요"
              onChange={(event) => {
                const value = event.target.value;
                setForm((now) => ({ ...now, scope: { ...now.scope, value } }));
              }}
            />
            <datalist id={`kube-search-scope-${session}`}>
              {options.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          </>
        )}
        <select
          aria-label="시간"
          value={form.since}
          onChange={(event) => {
            const value = event.target.value;
            setForm((now) => ({ ...now, since: value }));
          }}
        >
          {SINCE_CHOICES.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        {form.since === 'custom' && (
          <input
            type="text"
            aria-label="시간 직접 입력"
            placeholder="예: 2h30m"
            value={form.customSince}
            onChange={(event) => {
              const value = event.target.value;
              setForm((now) => ({ ...now, customSince: value }));
            }}
          />
        )}
        <input
          ref={keywordBox}
          type="search"
          className="kube-search-keywords"
          aria-label="키워드"
          placeholder="키워드: 공백은 AND, !단어는 제외, 대소문자 무시"
          value={form.query}
          onChange={(event) => {
            const value = event.target.value;
            setForm((now) => ({ ...now, query: value }));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) run();
          }}
        />
        {running ? (
          <button onClick={cancel}>취소</button>
        ) : (
          <button className="primary" disabled={!ready} onClick={run}>
            검색
          </button>
        )}
      </div>
      <div className="kube-search-tools secondary">
        <label className="kube-tree-problems">
          <input
            type="checkbox"
            checked={form.allContainers}
            onChange={(event) => {
              const checked = event.target.checked;
              setForm((now) => ({ ...now, allContainers: checked }));
            }}
          />
          컨테이너 전체
        </label>
        <label className="kube-tree-problems">
          <input
            type="checkbox"
            checked={form.previous}
            onChange={(event) => {
              const checked = event.target.checked;
              setForm((now) => ({ ...now, previous: checked }));
            }}
          />
          이전 인스턴스 포함
        </label>
        <label className="kube-tree-problems">
          주변 줄 수
          <select
            aria-label="주변 줄 수"
            value={form.around}
            onChange={(event) => {
              const value = Number(event.target.value);
              setForm((now) => ({ ...now, around: value }));
            }}
          >
            {AROUND_CHOICES.map((value) => (
              <option key={value} value={value}>
                앞뒤 {value}줄
              </option>
            ))}
          </select>
        </label>
        <label className="kube-tree-problems">
          <input
            type="checkbox"
            checked={form.byPod}
            onChange={(event) => {
              const checked = event.target.checked;
              setForm((now) => ({ ...now, byPod: checked }));
            }}
          />
          파드별 묶기
        </label>
        <span className="kube-tree-summary">
          대상 파드 {targetCount.toLocaleString('en-US')}개
          {targetCount > MAX_PODS && ` (앞의 ${MAX_PODS}개만 검색)`}
        </span>
      </div>
    </>
  );
}
