import { useState } from 'react';
import {
  agentPrograms,
  buildAgentCommand,
  dangerWarning,
  isDangerousCommand,
  parseAgentCommand,
  programOf,
  type AgentChoice,
  type AgentOption,
} from './agentOptions';
import {
  defaultAgentPresets,
  maxPresets,
  presetProblem,
  readAgentPresets,
  writeAgentPresets,
  type AgentPreset,
} from './presets';
import './agents.css';

/** `typed` holds a row on free text even if its command reads as a choice. It is never saved. */
type PresetRow = AgentPreset & { typed?: boolean };

const typedProgram = '';

function OptionSelect({
  label,
  rowLabel,
  value,
  options,
  choose,
}: {
  label: string;
  rowLabel: string;
  value: string;
  options: readonly AgentOption[];
  choose: (id: string) => void;
}) {
  return (
    <label>
      {label}
      <select
        value={value}
        aria-label={`${rowLabel} ${label}`}
        onChange={(e) => choose(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function PresetRowEditor({
  preset,
  index,
  edit,
  remove,
  removable,
}: {
  preset: PresetRow;
  index: number;
  edit: (part: Partial<PresetRow>) => void;
  remove: () => void;
  removable: boolean;
}) {
  const rowLabel = `프리셋 ${index + 1}`;
  const invalid = !!presetProblem(preset);
  const choice = preset.typed ? null : parseAgentCommand(preset.command);
  const program = choice && programOf(choice.program);
  const update = (part: Partial<AgentChoice>) => {
    if (choice) edit({ command: buildAgentCommand({ ...choice, ...part }) });
  };
  return (
    <div className="agent-preset-row">
      <label>
        이름
        <input
          value={preset.name}
          maxLength={40}
          aria-label={`${rowLabel} 이름`}
          aria-invalid={invalid}
          onChange={(e) => edit({ name: e.target.value })}
        />
      </label>
      <label>
        프로그램
        <select
          value={choice?.program ?? typedProgram}
          aria-label={`${rowLabel} 프로그램`}
          onChange={(e) =>
            edit(
              e.target.value === typedProgram
                ? { typed: true }
                : {
                    typed: false,
                    // A new program starts plain: a dangerous mode is never carried over.
                    command: buildAgentCommand({
                      program: e.target.value,
                      mode: 'default',
                      start: 'new',
                    }),
                  },
            )
          }
        >
          {agentPrograms.map((p) => (
            <option key={p.command} value={p.command}>
              {p.command}
            </option>
          ))}
          <option value={typedProgram}>직접 입력</option>
        </select>
      </label>
      {choice && program && (
        <>
          <OptionSelect
            label="모드"
            rowLabel={rowLabel}
            value={choice.mode}
            options={program.modes}
            choose={(mode) => update({ mode })}
          />
          <OptionSelect
            label="시작 방식"
            rowLabel={rowLabel}
            value={choice.start}
            options={program.starts}
            choose={(start) => update({ start })}
          />
        </>
      )}
      <label className="agent-preset-command">
        명령
        <input
          className="command"
          value={preset.command}
          maxLength={1000}
          spellCheck={false}
          aria-label={`${rowLabel} 명령`}
          aria-invalid={invalid}
          onChange={(e) => edit({ command: e.target.value })}
        />
      </label>
      {isDangerousCommand(preset.command) && (
        <p className="field-help agent-launch-error agent-preset-danger">{dangerWarning}</p>
      )}
      <button
        type="button"
        aria-label={`${rowLabel} 삭제`}
        title="삭제"
        disabled={!removable}
        onClick={remove}
      >
        삭제
      </button>
    </div>
  );
}

/**
 * The start commands offered when starting an agent. The list saves as it changes, but only while
 * every row is valid, so a half-typed row never replaces a working list.
 */
export function AgentPresetSettings() {
  const [presets, setPresets] = useState<PresetRow[]>(readAgentPresets);
  const [status, setStatus] = useState('');
  const problem = presets.map(presetProblem).find(Boolean);
  const change = (next: PresetRow[]) => {
    setPresets(next);
    const invalid = next.map(presetProblem).find(Boolean);
    if (invalid) setStatus('');
    else setStatus(writeAgentPresets(next) ? '' : '프리셋을 저장하지 못했습니다.');
  };
  return (
    <section className="dialog-section" aria-label="시작 프리셋">
      <h3>시작 프리셋</h3>
      <p>
        파일 트리의 폴더나 연결을 우클릭해 에이전트를 시작할 때 고르는 명령입니다. 프로그램과 모드를
        고르면 명령이 만들어지고, 명령 칸에서 직접 고칠 수도 있습니다. 명령의{' '}
        <code>{'{name}'}</code>은 시작할 때 입력하는 이름(영문, 숫자, ., _, -)으로 바뀝니다.
      </p>
      <div className="agent-presets">
        {presets.map((preset, index) => (
          <PresetRowEditor
            key={index}
            preset={preset}
            index={index}
            edit={(part) => change(presets.map((p, i) => (i === index ? { ...p, ...part } : p)))}
            remove={() => change(presets.filter((_, i) => i !== index))}
            removable={presets.length > 1}
          />
        ))}
      </div>
      {problem && <p role="alert">{problem} 고칠 때까지 저장하지 않습니다.</p>}
      {status && <p role="alert">{status}</p>}
      <div className="agent-preset-actions">
        <button
          type="button"
          disabled={presets.length >= maxPresets}
          onClick={() => setPresets([...presets, { name: '', command: agentPrograms[0].command }])}
        >
          프리셋 추가
        </button>
        <button type="button" onClick={() => change([...defaultAgentPresets])}>
          기본값으로 되돌리기
        </button>
      </div>
    </section>
  );
}
