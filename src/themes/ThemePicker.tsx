import { useState, type CSSProperties } from 'react';
import { themes } from './registry';
import { useTheme } from './useTheme';
import { selectTheme } from './store';
import { cssVariables } from './adapters/css';
import './picker.css';

export function ThemePicker() {
  const selected = useTheme();
  const [saved, setSaved] = useState(true);
  return (
    <section className="theme-settings" aria-label="테마 설정">
      <div className="theme-heading">
        <div>
          <h3>내 작업 공간의 분위기</h3>
          <p>테마를 선택하면 화면과 열린 터미널에 바로 적용됩니다.</p>
        </div>
        <span className="theme-count">{themes.length} THEMES</span>
      </div>
      <fieldset className="theme-picker">
        <legend>테마 선택</legend>
        <div className="theme-grid">
          {themes.map((theme) => (
            <label className="theme-card" key={theme.id} data-selected={selected.id === theme.id}>
              <div
                className="theme-thumbnail"
                aria-hidden="true"
                style={{ ...cssVariables(theme), colorScheme: theme.colorScheme } as CSSProperties}
              >
                <div className="theme-mini-toolbar">
                  <i />
                  <i />
                  <i />
                  <span>DaxTerm</span>
                </div>
                <div className="theme-mini-workspace">
                  <div className="theme-mini-sidebar">
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="theme-mini-terminal">
                    <span>
                      <b>~</b> ssh workspace
                    </span>
                    <span className="theme-mini-prompt">
                      ❯ <i />
                    </span>
                    <div className="theme-mini-ansi">
                      {['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].map((color) => (
                        <i key={color} style={{ background: `var(--terminal-${color})` }} />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="theme-card-label">
                <input
                  type="radio"
                  name="theme"
                  value={theme.id}
                  checked={selected.id === theme.id}
                  onChange={() => setSaved(selectTheme(theme.id))}
                  aria-label={theme.name}
                />
                <strong>{theme.name}</strong>
                <span>{theme.category}</span>
              </div>
              <p>{theme.description}</p>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="theme-current" role="status">
        현재 테마: <strong>{selected.name}</strong> · {saved ? '자동 저장' : '이번 창에만 적용'}
      </p>
      {!saved && (
        <p role="alert" className="inline-error">
          테마를 저장하지 못했습니다. 앱을 다시 열면 이전 테마로 돌아갑니다.
        </p>
      )}
    </section>
  );
}
