import type { TunnelStatus as Status } from './serverPorts';

/** A saved tunnel, as `tunnel_configs` returns it. */
export type TunnelConfig = {
  id: string;
  profileId: string;
  name: string;
  kind: string;
  port: number;
  host: string;
  targetPort: number;
  autoStart: boolean;
};

export const tunnelKinds = [
  {
    id: 'local',
    name: '로컬 포워딩',
    code: 'Local · -L',
    description: '내 PC에서 서버 쪽 서비스에 접속',
  },
  {
    id: 'remote',
    name: '원격 포워딩',
    code: 'Remote · -R',
    description: 'SSH 서버에서 내 PC 쪽 서비스에 접속',
  },
  {
    id: 'dynamic',
    name: 'SOCKS5 프록시',
    code: 'Dynamic · -D',
    description: '내 앱의 접속을 SSH 서버로 경유',
  },
];

export const isActive = (s: Status) => s.status === 'running' || s.status === 'starting';
/** A running tunnel belongs to a saved one when its id is `<connection>:<config>`. */
export const belongsTo = (s: Status, c: TunnelConfig) => s.id === `${s.connectionId}:${c.id}`;
