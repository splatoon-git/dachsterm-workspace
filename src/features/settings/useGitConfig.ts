import { useCallback, useEffect, useMemo, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import {
  changesOf,
  fieldsFor,
  type GitConfigChange,
  type GitConfigEntry,
  type GitConfigTarget,
} from './gitConfigModel';

/** Commands to run, as the user confirms them. */
export type GitConfigReview = { commands: string[]; changes: GitConfigChange[] };

/**
 * One target's settings: read from it, edited here, and written back after a confirmation. Mounted
 * once per target, so nothing typed for one target can be written to another.
 */
export function useGitConfig({ source, scope }: GitConfigTarget) {
  const [entries, setEntries] = useState<GitConfigEntry[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [review, setReview] = useState<GitConfigReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const reach = useMemo(() => ({ source, scope }), [source, scope]);
  const read = useCallback(() => call<GitConfigEntry[]>('git_config_read', reach), [reach]);

  useEffect(() => {
    let live = true;
    read()
      .then(
        (found) => live && setEntries(found),
        (error: unknown) => live && setMessage({ error: true, text: errorText(error) }),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [read]);

  /** Reads again after a write, which may have finished only partly. */
  const reread = async () => {
    try {
      setEntries(await read());
    } catch (error) {
      setEntries([]);
      setMessage({ error: true, text: errorText(error) });
    }
  };

  const fields = useMemo(() => fieldsFor(scope), [scope]);
  const changes = useMemo(() => changesOf(fields, entries, draft), [fields, entries, draft]);

  const edit = (key: string, value: string) => {
    setDraft((old) => ({ ...old, [key]: value }));
    setReview(null);
    setMessage(null);
  };

  /** Asks the app for the exact commands; nothing runs until the user confirms them. */
  const prepare = async () => {
    if (!changes.length) return;
    setBusy(true);
    try {
      const commands = await call<string[]>('git_config_preview', { ...reach, changes });
      setReview({ commands, changes });
      setMessage(null);
    } catch (error) {
      setMessage({ error: true, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!review) return;
    setBusy(true);
    try {
      await call('git_config_write', { ...reach, changes: review.changes });
      setDraft({});
      setReview(null);
      setMessage({ error: false, text: '적용했습니다.' });
      await reread();
    } catch (error) {
      setReview(null);
      setMessage({ error: true, text: errorText(error) });
      // Whatever was applied now reads as unchanged, so the draft holds only what is left.
      await reread();
    } finally {
      setBusy(false);
    }
  };

  return {
    fields,
    entries,
    draft,
    loading,
    changes,
    review,
    busy,
    message,
    edit,
    prepare,
    apply,
    cancelReview: () => setReview(null),
  };
}
