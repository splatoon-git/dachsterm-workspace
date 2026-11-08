// Isolated UI fixture. This is not part of the production entry point or an SSH test.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ForwardKeysField } from '../../../src/features/sessions/ForwardKeysField';
import { blankProfile, type Profile } from '../../../src/lib/ipc';
import { applyTheme } from '../../../src/themes/adapters/css';
import { getCurrentTheme } from '../../../src/themes/store';
import '../../../src/app/styles.css';
import '../../../src/app/workspace.css';
import '../../../src/features/sessions/sessionForm.css';

declare global {
  interface Window {
    __forwardProfile: Profile;
  }
}

applyTheme(getCurrentTheme());

function Harness() {
  const [profile, setProfile] = useState<Profile>({
    ...blankProfile(),
    auth: 'key',
    forwardAgent: true,
    forwardKeys: [
      { path: 'C:\\Users\\me\\.ssh\\id_git', secretRef: 'saved' },
      { path: '/Users/me/.ssh/id_work' },
    ],
  });
  window.__forwardProfile = profile;
  return (
    // The same container as the session form's folded options, so its rules apply here too.
    <details open className="session-advanced">
      <summary>고급 옵션</summary>
      <div className="form-grid">
        <ForwardKeysField
          profile={profile}
          field={(key, value) => setProfile((p) => ({ ...p, [key]: value }))}
        />
      </div>
    </details>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
