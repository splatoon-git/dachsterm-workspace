import { lazy, Suspense, useState, type ComponentProps } from 'react';
import type { GeneratedKey } from './SshKeyDialog';

const SshKeyDialog = lazy(() => import('./SshKeyDialog'));

/** The key dialog, loaded the first time it opens. */
export function LazySshKeyDialog(props: ComponentProps<typeof SshKeyDialog>) {
  return (
    <Suspense fallback={null}>
      <SshKeyDialog {...props} />
    </Suspense>
  );
}

/** Beside a key path or key list in a form: makes a key and hands its path to that field. */
export function NewSshKeyButton({
  disabled,
  created,
}: {
  disabled?: boolean;
  created: (key: GeneratedKey) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        title="새 SSH 키 만들기"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        새 키…
      </button>
      {open && <LazySshKeyDialog close={() => setOpen(false)} created={created} />}
    </>
  );
}
