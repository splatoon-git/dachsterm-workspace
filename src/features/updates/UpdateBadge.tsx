import { useEffect } from 'react';
import { Icon } from '../../components/Icon';
import { requestSettings } from '../../lib/settingsRequest';
import {
  pendingVersion,
  progressPercent,
  startAutomaticChecks,
  useUpdateStatus,
} from './updateState';
import './updates.css';

/**
 * The title bar's update notice, there only while a new version waits or installs. It also runs
 * the automatic check, so the main window mounts it once.
 */
export function UpdateBadge() {
  const status = useUpdateStatus();
  useEffect(() => startAutomaticChecks(), []);
  const version = status && pendingVersion(status.phase);
  if (!status || !version) return null;
  const { phase } = status;
  const percent = phase.state === 'downloading' ? progressPercent(phase) : null;
  const text =
    phase.state === 'installing'
      ? `${version} 설치 중`
      : phase.state === 'downloading'
        ? `${version} 받는 중${percent === null ? '' : ` ${percent}%`}`
        : `새 버전 ${version}`;
  return (
    <button
      className="update-badge"
      title="설정 → 업데이트에서 설치합니다"
      onClick={() => requestSettings({ section: 'update' })}
    >
      <Icon name="download" size={14} />
      {text}
    </button>
  );
}
