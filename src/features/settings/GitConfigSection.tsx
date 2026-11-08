import { useState } from 'react';
import {
  currentValue,
  entryOf,
  trustsEverything,
  type GitConfigEntry,
  type GitConfigField,
  type GitConfigTarget,
} from './gitConfigModel';
import { useGitConfig } from './useGitConfig';

function FieldControl({
  field,
  entry,
  draft,
  edit,
  disabled,
}: {
  field: GitConfigField;
  entry: GitConfigEntry | undefined;
  draft: string | undefined;
  edit: (value: string) => void;
  disabled: boolean;
}) {
  const label = field.label;
  if (field.kind === 'choice') {
    const value = draft ?? currentValue(entry);
    // A value the app has no name for, such as `pull.rebase=interactive`, must still show.
    const unknown = value && !field.choices.some(([choice]) => choice === value);
    return (
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => edit(e.target.value)}
      >
        <option value="">설정 안 함</option>
        {unknown && <option value={value}>{value}</option>}
        {field.choices.map(([choice, text]) => (
          <option key={choice} value={choice}>
            {text}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === 'text')
    return (
      <input
        aria-label={label}
        value={draft ?? currentValue(entry)}
        placeholder={field.placeholder ?? '설정 안 함'}
        disabled={disabled}
        onChange={(e) => edit(e.target.value)}
      />
    );
  return (
    <input
      aria-label={label}
      value={draft ?? ''}
      placeholder={field.kind === 'list' ? '추가할 폴더 경로' : '바꾸려면 직접 입력'}
      disabled={disabled}
      onChange={(e) => edit(e.target.value)}
    />
  );
}

/** What is set now, for the settings whose box stays empty. */
function CurrentValues({ field, entry }: { field: GitConfigField; entry?: GitConfigEntry }) {
  if (field.kind !== 'typed' && field.kind !== 'list') return null;
  if (entry?.hidden)
    return (
      <small className="git-config-now">설정돼 있지만 비밀이 있을 수 있어 표시하지 않습니다.</small>
    );
  const values = entry?.values.filter(Boolean) ?? [];
  return (
    <small className="git-config-now">{values.length ? values.join(', ') : '설정된 값 없음'}</small>
  );
}

/** The settings of one target, and the confirmation of what will run. */
function GitConfigForm({ target }: { target: GitConfigTarget }) {
  const config = useGitConfig(target);
  const locked = config.busy || config.loading;
  return (
    <>
      <div className="setting-rows">
        {config.fields.map((field) => {
          const entry = entryOf(config.entries, field.key);
          return (
            <div className="setting-row git-config-row" key={field.key}>
              <span>
                {field.label}
                <CurrentValues field={field} entry={entry} />
              </span>
              <FieldControl
                field={field}
                entry={entry}
                draft={config.draft[field.key]}
                disabled={locked}
                edit={(value) => config.edit(field.key, value)}
              />
            </div>
          );
        })}
      </div>
      {config.review ? (
        <div className="git-config-review" role="group" aria-label="실행할 명령 확인">
          <strong>이 명령을 실행합니다</strong>
          <pre tabIndex={0}>{config.review.commands.join('\n')}</pre>
          {trustsEverything(config.review.changes) && (
            <p role="alert">
              <code>*</code>는 이 대상의 모든 저장소를 소유자와 관계없이 신뢰합니다. 다른 사람이
              만든 저장소의 설정이 실행될 수 있습니다.
            </p>
          )}
          <div className="git-config-actions">
            <button type="button" onClick={config.cancelReview} disabled={config.busy}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void config.apply()}
              disabled={config.busy}
            >
              실행
            </button>
          </div>
        </div>
      ) : (
        <div className="git-config-actions">
          <button
            type="button"
            className="primary"
            disabled={locked || !config.changes.length}
            onClick={() => void config.prepare()}
          >
            {config.changes.length ? `변경 ${config.changes.length}개 검토…` : '변경 없음'}
          </button>
        </div>
      )}
      {config.message && (
        <p role={config.message.error ? 'alert' : 'status'}>{config.message.text}</p>
      )}
    </>
  );
}

/**
 * Edits one target's `git config`: what is shown is read from that target, only the settings the
 * user changed are written, and the exact commands are confirmed first.
 */
export function GitConfigSection({
  targets,
  initial,
}: {
  targets: GitConfigTarget[];
  initial?: string;
}) {
  const [chosen, setChosen] = useState(initial);
  const target = targets.find((t) => t.id === chosen) ?? targets[0];
  return (
    <section className="dialog-section git-config" aria-label="Git 설정 편집">
      <h3>Git 설정 편집</h3>
      <p>
        고른 대상의 값을 읽어 옵니다. 바꾼 항목만 <code>git config</code>로 쓰고, 실행 전에 최종
        명령을 보여 줍니다.
      </p>
      <label className="git-config-target">
        <span>대상</span>
        <select
          aria-label="Git 설정 대상"
          value={target?.id ?? ''}
          onChange={(e) => setChosen(e.target.value)}
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      {target && <GitConfigForm key={target.id} target={target} />}
    </section>
  );
}
