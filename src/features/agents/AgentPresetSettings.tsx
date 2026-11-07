import { useState } from 'react';
import {
  defaultAgentPresets,
  maxPresets,
  presetProblem,
  readAgentPresets,
  writeAgentPresets,
  type AgentPreset,
} from './presets';
import './agents.css';

/**
 * The start commands offered when starting an agent. The list saves as it changes, but only while
 * every row is valid, so a half-typed row never replaces a working list.
 */
export function AgentPresetSettings() {
  const [presets, setPresets] = useState(readAgentPresets);
  const [status, setStatus] = useState('');
  const problem = presets.map(presetProblem).find(Boolean);
  const change = (next: AgentPreset[]) => {
    setPresets(next);
    const invalid = next.map(presetProblem).find(Boolean);
    if (invalid) setStatus('');
    else setStatus(writeAgentPresets(next) ? '' : '프리셋을 저장하지 못했습니다.');
  };
  const edit = (index: number, part: Partial<AgentPreset>) =>
    change(presets.map((p, i) => (i === index ? { ...p, ...part } : p)));
  return (
    <section className="dialog-section" aria-label="시작 프리셋">
      <h3>시작 프리셋</h3>
      <p>
        파일 트리의 폴더나 연결을 우클릭해 에이전트를 시작할 때 고르는 명령입니다. 명령의{' '}
        <code>{'{name}'}</code>은 시작할 때 입력하는 이름(영문, 숫자, ., _, -)으로 바뀝니다.
      </p>
      <div className="agent-presets">
        {presets.map((preset, index) => (
          <div className="agent-preset-row" key={index}>
            <label>
              이름
              <input
                value={preset.name}
                maxLength={40}
                aria-label={`프리셋 ${index + 1} 이름`}
                aria-invalid={!!presetProblem(preset)}
                onChange={(e) => edit(index, { name: e.target.value })}
              />
            </label>
            <label>
              명령
              <input
                className="command"
                value={preset.command}
                maxLength={1000}
                spellCheck={false}
                aria-label={`프리셋 ${index + 1} 명령`}
                aria-invalid={!!presetProblem(preset)}
                onChange={(e) => edit(index, { command: e.target.value })}
              />
            </label>
            <button
              type="button"
              aria-label={`프리셋 ${index + 1} 삭제`}
              title="삭제"
              disabled={presets.length === 1}
              onClick={() => change(presets.filter((_, i) => i !== index))}
            >
              삭제
            </button>
          </div>
        ))}
      </div>
      {problem && <p role="alert">{problem} 고칠 때까지 저장하지 않습니다.</p>}
      {status && <p role="alert">{status}</p>}
      <div className="agent-preset-actions">
        <button
          type="button"
          disabled={presets.length >= maxPresets}
          onClick={() => setPresets([...presets, { name: '', command: '' }])}
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
