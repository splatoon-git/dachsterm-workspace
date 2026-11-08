import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { defaultChoice, Dialog } from '../../components/Dialog';
import { call, errorText } from '../../lib/ipc';
import type { GitRefs } from './gitDiff';
import type { GitViewRepo } from './gitViewModel';
import {
  branchChoices,
  networkCommands,
  trackCommand,
  type DiscardTarget,
  type GitDialogRequest,
} from './gitWrite';
import type { GitWrite } from './useGitWrite';

const maxListed = 200;

/** A yes-or-no question. The answer that loses nothing is the one already chosen. */
function Confirm({
  title,
  action,
  danger,
  children,
  close,
  confirm,
}: {
  title: string;
  action: string;
  danger?: boolean;
  children: ReactNode;
  close: () => void;
  confirm: () => void;
}) {
  return (
    <Dialog title={title} size="small" close={close}>
      {children}
      <div className="form-actions">
        <button type="button" ref={defaultChoice} onClick={close}>
          취소
        </button>
        <button
          type="button"
          className={danger ? 'danger' : 'primary'}
          onClick={() => {
            close();
            confirm();
          }}
        >
          {action}
        </button>
      </div>
    </Dialog>
  );
}

function DiscardDialog({
  target,
  truncated,
  close,
  write,
}: {
  target: DiscardTarget;
  truncated: boolean;
  close: () => void;
  write: GitWrite;
}) {
  const deleting = target.untracked.length > 0;
  const files = deleting ? target.untracked : target.paths;
  const hidden = files.length - maxListed;
  return (
    <Confirm
      title={deleting ? '추적 안 함 파일 삭제' : '변경 버리기'}
      action={deleting ? '삭제' : '변경 버리기'}
      danger
      close={close}
      confirm={() =>
        void write.apply({ kind: 'discard', paths: target.paths, untracked: target.untracked })
      }
    >
      <p>
        {deleting
          ? `파일 ${files.length.toLocaleString()}개를 지웁니다. Git에 없는 파일이라 되돌릴 수 없습니다.`
          : `파일 ${files.length.toLocaleString()}개의 스테이지하지 않은 변경을 버립니다. 되돌릴 수 없습니다.`}
      </p>
      <ul className="git-dialog-files" aria-label="대상 파일" tabIndex={0}>
        {files.slice(0, maxListed).map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
      {hidden > 0 && <p>외 {hidden.toLocaleString()}개</p>}
      {!!target.omitted && <p>이름을 읽을 수 없는 파일 {target.omitted}개는 건드리지 않습니다.</p>}
      {truncated && <p>목록이 잘려 있어 목록에 보이는 파일만 대상입니다.</p>}
    </Confirm>
  );
}

function CheckoutDialog({
  repo,
  close,
  write,
}: {
  repo: GitViewRepo;
  close: () => void;
  write: GitWrite;
}) {
  const [refs, setRefs] = useState<GitRefs | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const { source } = write;
  useEffect(() => {
    let live = true;
    void call<GitRefs>('git_refs', { source, folder: repo.root })
      .then((value) => {
        if (live) setRefs(value);
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
    };
    // Asked once for the dialog: `source` is a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.root]);
  const choices = useMemo(() => branchChoices(refs?.refs ?? [], repo.branch), [refs, repo.branch]);
  const matches = (name: string) => name.toLowerCase().includes(filter.toLowerCase());
  const local = choices.local.filter(matches);
  const remote = choices.remote.filter(matches);
  const pickRemote = (name: string) => {
    const command = trackCommand(name);
    close();
    if (command) void write.runInTerminal(command);
    else write.note('이 브랜치 이름은 터미널에 안전하게 입력할 수 없습니다. 직접 입력하세요.');
  };
  const row = (name: string, choose: () => void) => (
    <li key={name}>
      <button type="button" onClick={choose}>
        {name}
      </button>
    </li>
  );
  return (
    <Dialog title="브랜치 전환" size="small" close={close}>
      {error && <p role="alert">{error}</p>}
      <input
        aria-label="브랜치 찾기"
        placeholder="브랜치 찾기"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {!refs && !error && <p>불러오는 중…</p>}
      {refs && !local.length && !remote.length && <p>전환할 브랜치가 없습니다.</p>}
      {!!local.length && (
        <section aria-label="로컬 브랜치">
          <h3 className="git-dialog-heading">로컬</h3>
          <ul className="git-branch-list">
            {local.map((name) =>
              row(name, () => {
                close();
                void write.apply({ kind: 'checkout', branch: name });
              }),
            )}
          </ul>
        </section>
      )}
      {!!remote.length && (
        <section aria-label="원격 브랜치">
          <h3 className="git-dialog-heading">원격 (터미널에서 추적 브랜치 만들기)</h3>
          <ul className="git-branch-list">
            {remote.map((name) => row(name, () => pickRemote(name)))}
          </ul>
        </section>
      )}
      <div className="form-actions">
        <button type="button" onClick={close}>
          닫기
        </button>
      </div>
    </Dialog>
  );
}

/** A form that closes itself and reports through the view, where the next action starts clean. */
function FormDialog({
  title,
  action,
  close,
  submit,
  children,
}: {
  title: string;
  action: string;
  close: () => void;
  submit: (form: FormData) => void;
  children: ReactNode;
}) {
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    close();
    submit(form);
  };
  return (
    <Dialog title={title} size="small" close={close}>
      <form onSubmit={onSubmit}>
        {children}
        <div className="form-actions">
          <button type="button" onClick={close}>
            취소
          </button>
          <button type="submit" className="primary">
            {action}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

/** The dialog one Git action asked for. */
export function GitWriteDialog({
  request,
  repo,
  close,
  write,
}: {
  request: GitDialogRequest;
  repo: GitViewRepo;
  close: () => void;
  write: GitWrite;
}) {
  switch (request.kind) {
    case 'discard':
      return (
        <DiscardDialog
          target={request.target}
          truncated={repo.truncated}
          close={close}
          write={write}
        />
      );
    case 'forcePush':
      return (
        <Confirm
          title="강제 push"
          action="강제 push"
          danger
          close={close}
          confirm={() => void write.runInTerminal(networkCommands.forcePush)}
        >
          <p>
            <code>{repo.branch}</code>의 원격 기록을 이 PC의 기록으로 덮어씁니다. 다른 사람이 그
            사이에 올린 내용이 있으면 Git이 거부합니다(<code>--force-with-lease</code>).
          </p>
        </Confirm>
      );
    case 'terminal':
      return (
        <Confirm
          title="터미널에 입력"
          action="입력"
          close={close}
          confirm={() => write.typeCommand(request.command)}
        >
          <p>
            이 터미널은 실행 상태를 알려 주지 않습니다. 프로그램이 실행 중이면 그 프로그램이 이
            글자를 받습니다.
          </p>
          <pre className="git-dialog-command">{request.command}</pre>
        </Confirm>
      );
    case 'checkout':
      return <CheckoutDialog repo={repo} close={close} write={write} />;
    case 'branchCreate':
      return (
        <FormDialog
          title="새 브랜치"
          action="만들고 전환"
          close={close}
          submit={(form) => void write.apply({ kind: 'branchCreate', name: text(form, 'name') })}
        >
          <label>
            이름
            <input name="name" required maxLength={255} spellCheck={false} />
          </label>
        </FormDialog>
      );
    case 'tag':
      return (
        <FormDialog
          title="태그"
          action="태그 만들기"
          close={close}
          submit={(form) =>
            void write.apply({
              kind: 'tag',
              name: text(form, 'name'),
              message: text(form, 'message'),
            })
          }
        >
          <label>
            이름
            <input name="name" required maxLength={255} spellCheck={false} />
          </label>
          <label>
            설명 (선택)
            <input name="message" spellCheck={false} />
          </label>
        </FormDialog>
      );
    case 'stash':
      return (
        <FormDialog
          title="stash 넣기"
          action="넣기"
          close={close}
          submit={(form) =>
            void write.apply({
              kind: 'stashPush',
              message: text(form, 'message'),
              includeUntracked: form.get('untracked') === 'on',
            })
          }
        >
          <label>
            설명 (선택)
            <input name="message" spellCheck={false} />
          </label>
          <label className="checkbox">
            <input name="untracked" type="checkbox" />
            추적 안 함 파일 포함
          </label>
        </FormDialog>
      );
  }
}
