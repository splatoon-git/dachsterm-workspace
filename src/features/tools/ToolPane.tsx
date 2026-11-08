import { useEffect, useEffectEvent } from 'react';
import type { Profile } from '../../lib/ipc';
import { networkTools, type ServiceHandoff, type ToolId } from './catalog';
import { PortOpenTool } from './PortOpenTool';
import { PortUseTool } from './PortUseTool';
import { ServiceTool } from './ServiceTool';
import { SourcePicker } from './SourcePicker';
import type { SourceControl, VaultReady } from './useSource';
import { useSource } from './useSource';
import './tools.css';

/** Whether a handed-over target's source is the one now connected, so it is safe to run. */
function inPlace(handoff: ServiceHandoff, control: SourceControl) {
  return handoff.profile
    ? control.source?.kind === 'remote' && control.link.profile?.id === handoff.profile.id
    : control.source?.kind === 'local';
}

/** One network tool's tab: where it runs from, then the tool's own screen. */
export default function ToolPane({
  tool,
  profiles,
  live,
  vaultReady,
  handoff = null,
  viewService,
}: {
  tool: ToolId;
  profiles: Profile[];
  live: (profileId: string) => boolean;
  vaultReady: VaultReady;
  /** Set on the service tab when a port check sent it a target. */
  handoff?: ServiceHandoff | null;
  viewService?: (handoff: ServiceHandoff) => void;
}) {
  const source = useSource(vaultReady);
  const title = networkTools.find((item) => item.id === tool)!.title;
  const sourceName =
    source.source?.kind === 'local' ? '이 PC' : (source.link.profile?.name ?? '선택한 세션');
  const adopt = useEffectEvent((next: ServiceHandoff) => {
    if (next.profile) {
      source.chooseRemote();
      source.pick(next.profile);
    } else {
      source.chooseLocal();
    }
  });
  useEffect(() => {
    if (handoff) adopt(handoff);
  }, [handoff]);
  return (
    <section className="tool-pane" aria-label={title}>
      <h2>{title}</h2>
      <SourcePicker source={source} profiles={profiles} live={live} />
      {tool === 'portOpen' ? (
        <PortOpenTool
          source={source.source}
          sourceName={sourceName}
          viewService={
            viewService &&
            ((target) =>
              viewService({
                target,
                profile: source.mode === 'remote' ? source.link.profile : null,
              }))
          }
        />
      ) : tool === 'portUse' ? (
        <PortUseTool control={source} />
      ) : (
        <ServiceTool
          source={source.source}
          sourceName={sourceName}
          handoff={handoff && inPlace(handoff, source) ? handoff : null}
        />
      )}
    </section>
  );
}
