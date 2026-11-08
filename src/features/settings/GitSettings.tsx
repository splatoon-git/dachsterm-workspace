import type { ReactNode } from 'react';
import { GitConfigSection } from './GitConfigSection';
import { GitProgramSection } from './GitProgramSection';
import type { GitConfigTarget } from './gitConfigModel';
import './gitSettings.css';

/**
 * Settings → Git. What belongs to other features (how Git shows in the terminal, saved
 * credentials) comes in as parts from the app, which is the layer that may join features.
 */
export function GitSettings({
  targets,
  initialTarget,
  display,
  credentials,
}: {
  targets: GitConfigTarget[];
  initialTarget?: string;
  display: ReactNode;
  credentials: ReactNode;
}) {
  return (
    <>
      <GitProgramSection />
      {display}
      {/* The chosen target starts over when another request opens this on a repository. */}
      <GitConfigSection key={initialTarget} targets={targets} initial={initialTarget} />
      {credentials}
    </>
  );
}
