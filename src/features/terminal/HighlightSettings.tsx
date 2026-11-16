import { useState, useSyncExternalStore } from 'react';
import { errorText } from '../../lib/ipc';
import { blankRule, highlightColors, maxRules, type HighlightRule } from './highlightRules';
import {
  highlightLoadError,
  highlightRuleStopped,
  saveHighlightRules,
  subscribeHighlightRules,
  useHighlightLibrary,
} from './highlightStore';
import { HighlightRuleForm } from './HighlightRuleForm';
import './highlight.css';

const colorLabel = (rule: HighlightRule) =>
  highlightColors.find((c) => c.value === rule.color)?.label.split(' ')[0];

function summary(rule: HighlightRule) {
  const parts = [colorLabel(rule), rule.notify && '알림', rule.send && '입력 보내기'];
  if (rule.scope.kind === 'tags') parts.push(`태그 ${rule.scope.tags.join(', ')}`);
  if (rule.scope.kind === 'sessions') parts.push(`세션 ${rule.scope.ids.length}개`);
  return parts.filter(Boolean).join(' · ');
}

/**
 * Settings → Terminal → Highlights (CG.7). Rules color what matches, can notify, and can type an
 * answer once the user accepted the warning. One tab can turn them off from its header menu.
 */
export function HighlightSettings() {
  const library = useHighlightLibrary();
  const loadError = useSyncExternalStore(subscribeHighlightRules, highlightLoadError);
  const [editing, setEditing] = useState<HighlightRule | null>(null);
  const [message, setMessage] = useState('');
  const store = async (items: HighlightRule[]) => {
    try {
      await saveHighlightRules(items);
      setMessage('');
      return true;
    } catch (e) {
      setMessage(errorText(e));
      return false;
    }
  };
  const put = async (rule: HighlightRule) => {
    const exists = library.items.some((r) => r.id === rule.id);
    const items = exists
      ? library.items.map((r) => (r.id === rule.id ? rule : r))
      : [...library.items, rule];
    await saveHighlightRules(items);
    setEditing(null);
  };
  if (editing)
    return (
      <section className="dialog-section" aria-label="하이라이트 규칙 편집">
        <h3>{library.items.some((r) => r.id === editing.id) ? '규칙 수정' : '새 규칙'}</h3>
        <HighlightRuleForm rule={editing} save={put} cancel={() => setEditing(null)} />
      </section>
    );
  return (
    <section className="dialog-section" aria-label="하이라이트">
      <h3>하이라이트</h3>
      <p>
        출력에서 정규식과 일치하는 부분을 칠하고, 필요하면 알림을 띄웁니다. 색은 테마의 터미널 색을
        따릅니다. 탭 헤더 우클릭 메뉴에서 그 탭만 끌 수 있습니다.
      </p>
      {loadError && <p role="alert">{loadError}</p>}
      {library.items.length > 0 && (
        <ul className="highlight-rules">
          {library.items.map((rule) => (
            <li key={rule.id}>
              <input
                type="checkbox"
                className="switch"
                aria-label={`${rule.name} 사용`}
                checked={rule.enabled}
                onChange={(e) =>
                  void store(
                    library.items.map((r) =>
                      r.id === rule.id ? { ...r, enabled: e.target.checked } : r,
                    ),
                  )
                }
              />
              <span className="highlight-rule-text">
                <strong>{rule.name}</strong>
                <code>{rule.pattern}</code>
                <small>
                  {summary(rule)}
                  {highlightRuleStopped(rule) && ' · 검사가 오래 걸려 멈춤'}
                </small>
              </span>
              <button type="button" onClick={() => setEditing(rule)}>
                수정
              </button>
              <button
                type="button"
                aria-label={`${rule.name} 삭제`}
                onClick={() => void store(library.items.filter((r) => r.id !== rule.id))}
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={library.items.length >= maxRules}
        onClick={() => setEditing(blankRule())}
      >
        규칙 추가
      </button>
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
