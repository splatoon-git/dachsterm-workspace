import type { IconName } from '../../components/Icon';
import type { Profile } from '../../lib/ipc';

/** Tools the menu runs directly. What each one does stays with the title bar that holds its state. */
export const toolActions = [
  { id: 'tunnels', title: '터널', icon: 'tunnel' },
  { id: 'sshKey', title: 'SSH 키 만들기', icon: 'key' },
  { id: 'editor', title: '문서 편집기', icon: 'file' },
] as const satisfies readonly { id: string; title: string; icon: IconName }[];

/** Tools with long results that are read side by side, so each opens as a workspace tab. */
export const networkTools = [
  { id: 'portOpen', title: '포트 개통' },
  { id: 'portUse', title: '포트 사용 여부' },
  { id: 'service', title: '서비스 연결' },
] as const;

export type ToolActionId = (typeof toolActions)[number]['id'];
export type ToolId = (typeof networkTools)[number]['id'];

/** A target sent to the service check. No profile means the check runs from this PC. */
export type ServiceHandoff = { target: string; profile: Profile | null };
