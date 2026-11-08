import type { Profile } from '../../lib/ipc';
import { networkTools, type ToolId } from './catalog';
import { PortOpenTool } from './PortOpenTool';
import { PortUseTool } from './PortUseTool';
import { SourcePicker } from './SourcePicker';
import type { Source } from './sourceLink';
import { useSource, type VaultReady } from './useSource';
import './tools.css';

const sourceText = (source: Source | null, name?: string) =>
  !source
    ? '출발지 세션을 고르고 연결을 마치세요.'
    : source.kind === 'local'
      ? '이 PC에서 점검합니다.'
      : `${name ?? '선택한 세션'}에서 점검합니다.`;

/** One network tool's tab: where it runs from, then the tool's own screen. */
export default function ToolPane({
  tool,
  profiles,
  live,
  vaultReady,
}: {
  tool: ToolId;
  profiles: Profile[];
  live: (profileId: string) => boolean;
  vaultReady: VaultReady;
}) {
  const source = useSource(vaultReady);
  const title = networkTools.find((item) => item.id === tool)!.title;
  const sourceName =
    source.source?.kind === 'local' ? '이 PC' : (source.link.profile?.name ?? '선택한 세션');
  return (
    <section className="tool-pane" aria-label={title}>
      <h2>{title}</h2>
      <SourcePicker source={source} profiles={profiles} live={live} />
      {tool === 'portOpen' ? (
        <PortOpenTool source={source.source} sourceName={sourceName} />
      ) : tool === 'portUse' ? (
        <PortUseTool control={source} />
      ) : (
        <p className="tool-pending">
          {sourceText(source.source, source.link.profile?.name)} 점검 화면은 준비 중입니다.
        </p>
      )}
    </section>
  );
}
