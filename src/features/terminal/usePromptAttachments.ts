import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { call, desktop, errorText } from '../../lib/ipc';
import { isMacPlatform } from './preferences';
import {
  approveClipboard,
  clipboardApproved,
  insideRect,
  localDropText,
  posixQuote,
  type AttachItem,
  type ClipboardImage,
  type PendingAttachment,
} from './promptAttachments';
import type { TerminalSession } from './session';

/** Clipboard images and dropped files for one terminal pane. Enter is never sent. */
export function usePromptAttachments(
  session: TerminalSession,
  active: boolean,
  pane: RefObject<HTMLElement | null>,
) {
  const [pending, setPending] = useState<PendingAttachment | null>(null);
  const visible = useRef(active);
  useEffect(() => {
    visible.current = active;
  }, [active]);
  const attachable = !session.podtree && session.profile.protocol === 'ssh';

  /** The tab or connection may have changed during the upload. Then the path is only reported. */
  const type = useCallback(
    (id: string, text: string) => {
      const here = id === session.connectionId && session.snapshot().status === 'connected';
      if (!here || !visible.current) {
        session.notice(`입력하지 않았습니다. 경로: ${text}`);
        return false;
      }
      session.terminal.paste(`${text} `);
      session.terminal.focus();
      return true;
    },
    [session],
  );

  const send = useCallback(
    async (attachment: PendingAttachment) => {
      const { id } = attachment;
      session.notice('서버로 보내는 중입니다.');
      try {
        const paths =
          attachment.kind === 'clipboard'
            ? [
                await call<string>('prompt_clipboard_image', {
                  id,
                  expected: attachment.digest,
                }),
              ]
            : await call<string[]>('prompt_files_upload', { id, paths: attachment.paths });
        if (type(id, paths.map(posixQuote).join(' ')))
          session.notice('서버에 저장하고 경로를 입력했습니다. 7일 뒤 다음 전송 때 정리됩니다.');
      } catch (e) {
        session.notice(errorText(e));
      }
    },
    [session, type],
  );

  const attachImage = useCallback(async () => {
    if (!attachable) return;
    const id = session.connectionId;
    try {
      const image = await call<ClipboardImage | null>('prompt_clipboard_inspect');
      if (!image) return;
      if (session.localTarget) {
        session.notice('이 탭은 이미지를 올리지 않습니다. 프로그램의 이미지 붙여넣기 키를 쓰세요.');
        return;
      }
      const attachment: PendingAttachment = {
        id,
        kind: 'clipboard',
        items: [image.item],
        digest: image.digest,
      };
      if (clipboardApproved(id)) await send(attachment);
      else setPending(attachment);
    } catch (e) {
      session.notice(errorText(e));
    }
  }, [attachable, send, session]);

  const drop = useCallback(
    async (paths: string[]) => {
      const id = session.connectionId;
      const local = session.localTarget;
      try {
        // Checked first, because looking up a network path can block for seconds on Windows.
        const text = local ? localDropText(paths, local.kind, isMacPlatform) : null;
        if (local && text === null) return session.notice('이 터미널에서 쓸 수 없는 경로입니다.');
        const items = await call<AttachItem[]>('prompt_files_inspect', { paths, upload: !local });
        if (text === null) setPending({ id, kind: 'files', items, paths });
        else type(id, text);
      } catch (e) {
        session.notice(errorText(e));
      }
    },
    [session, type],
  );

  useEffect(() => {
    if (!desktop || !active || !attachable) return;
    let off: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop' || document.querySelector('dialog[open]')) return;
        const rect = pane.current?.getBoundingClientRect();
        const { x, y } = event.payload.position;
        const scale = window.devicePixelRatio;
        if (!rect || !insideRect(rect, x / scale, y / scale)) return;
        if (session.snapshot().status === 'connected') void drop(event.payload.paths);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else off = unlisten;
      });
    return () => {
      disposed = true;
      off?.();
    };
  }, [active, attachable, drop, pane, session]);

  return {
    pending: pending?.id === session.connectionId ? pending : null,
    attachImage,
    cancel: () => setPending(null),
    confirm: (remember: boolean) => {
      if (!pending) return;
      if (remember) approveClipboard(pending.id);
      setPending(null);
      void send(pending);
    },
  };
}
