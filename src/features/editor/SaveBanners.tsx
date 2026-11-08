import type { useFileSave } from './fileSave';

/** What a tab that edits a file says about its line breaks and its last save. */
export function SaveBanners({
  saving,
  mixedLineBreaks,
}: {
  saving: ReturnType<typeof useFileSave>;
  mixedLineBreaks: boolean;
}) {
  return (
    <>
      {mixedLineBreaks && (
        <p className="file-tab-banner" role="status">
          줄바꿈이 섞여 있습니다. 저장하면 한 가지로 통일됩니다.
        </p>
      )}
      {saving.saving && (
        <p className="file-tab-banner" role="status">
          저장하는 중…
        </p>
      )}
      {saving.error && (
        <p className="file-tab-banner" role="alert">
          저장하지 못했습니다. {saving.error}
        </p>
      )}
      {saving.notice && (
        <p className="file-tab-banner" role="status">
          {saving.notice}
        </p>
      )}
    </>
  );
}
