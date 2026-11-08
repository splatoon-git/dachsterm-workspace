//! Diff review (DX.6) against the OpenSSH fixture: every kind of change in a repository whose
//! settings name an external diff, a textconv driver and an fsmonitor program, none of which may
//! run during the app's queries.
use super::{Result, shell};
use dachsterm::{
    git_diff::{self, Change, DiffBase, DiffList, FileDiff, FileRequest},
    git_run::GitHost,
    ssh::Connections,
};

fn text(diff: FileDiff) -> String {
    match diff {
        FileDiff::Text { text } => text,
        other => panic!("not a text diff: {other:?}"),
    }
}

pub async fn run(manager: &Connections, id: &str) -> Result<()> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let root = format!("/tmp/dachsterm-diff-{token} 한글");
    let program = format!("/tmp/dachsterm-diff-{token}-");
    // Three programs, so a trace says which setting ran.
    let setup = format!(
        "set -e; R='{root}'; P='{program}'; mkdir -p \"$R\"; cd \"$R\"; git init -q; \
         git checkout -q -b main; git config user.email probe@example.invalid; \
         git config user.name probe; \
         printf '*.txt diff=evil\\n*.bin diff=evil\\n' > .gitattributes; \
         printf 'a\\nb\\n' > tracked.txt; printf 'x\\n' > removed.txt; \
         printf 'same\\n' > 'old name.txt'; printf '\\000\\001bin' > image.bin; \
         git add .; git commit -qm init; git branch base; \
         printf 'second\\n' >> tracked.txt; git commit -qam second; \
         printf 'B\\n' >> tracked.txt; rm removed.txt; git mv 'old name.txt' '새 이름.txt'; \
         printf '\\000\\002bin' > image.bin; printf 'n\\n' > 'new file.txt'; \
         git add 'new file.txt'; printf 'u\\n' > '추적 안 함.txt'; \
         head -c 3145728 /dev/zero > big.log; \
         for k in fsmonitor external textconv; do \
           printf '#!/bin/sh\\ntouch \"$0.ran\"\\n' > \"$P$k\"; chmod +x \"$P$k\"; done; \
         git config core.fsmonitor \"${{P}}fsmonitor\"; git config diff.external \"${{P}}external\"; \
         git config diff.evil.textconv \"${{P}}textconv\"; git config diff.evil.command \"${{P}}external\"; \
         git config diff.noprefix true; git config color.ui always"
    );
    let ran = |kind: &str| format!("test -e '{program}{kind}.ran'");
    let host = GitHost::ssh(manager, id)?;
    let result = async {
        assert_eq!(shell(manager, id, &setup).await?, 0, "fixture repository");

        let refs = git_diff::refs(&host, &root).await?;
        assert_eq!(refs.root, root);
        assert_eq!(refs.refs, vec!["refs/heads/base", "refs/heads/main"]);
        assert_eq!(refs.worktrees.len(), 1);
        assert_eq!(refs.worktrees[0].branch.as_deref(), Some("refs/heads/main"));

        let head = DiffBase::WorkingTree;
        let DiffList::Files { files, truncated } = git_diff::list(&host, &root, &head).await?
        else {
            panic!("the change list stopped");
        };
        assert!(!truncated);
        let mut found: Vec<_> = files
            .iter()
            .map(|f| {
                (
                    f.path.as_str(),
                    f.old_path.as_deref(),
                    f.change,
                    f.added,
                    f.binary,
                )
            })
            .collect();
        found.sort_by_key(|f| f.0);
        assert_eq!(
            found,
            vec![
                ("big.log", None, Change::Untracked, None, false),
                ("image.bin", None, Change::Modified, None, true),
                ("new file.txt", None, Change::Added, Some(1), false),
                ("removed.txt", None, Change::Deleted, Some(0), false),
                ("tracked.txt", None, Change::Modified, Some(1), false),
                (
                    "새 이름.txt",
                    Some("old name.txt"),
                    Change::Renamed,
                    Some(0),
                    false
                ),
                ("추적 안 함.txt", None, Change::Untracked, None, false),
            ]
        );
        assert!(files.iter().all(|f| f.readable));

        let file = |path: &'static str, old: Option<&'static str>, untracked: bool| FileRequest {
            root: &root,
            base: &head,
            path,
            old_path: old,
            untracked,
        };
        let tracked = text(git_diff::file(&host, file("tracked.txt", None, false)).await?);
        assert!(
            tracked.contains("--- a/tracked.txt\n+++ b/tracked.txt\n"),
            "{tracked}"
        );
        assert!(
            tracked.contains("\n+B\n") && !tracked.contains('\x1b'),
            "{tracked}"
        );
        let added = text(git_diff::file(&host, file("new file.txt", None, false)).await?);
        assert!(added.contains("new file mode") && added.contains("\n+n\n"));
        let removed = text(git_diff::file(&host, file("removed.txt", None, false)).await?);
        assert!(removed.contains("deleted file mode") && removed.contains("\n-x\n"));
        let renamed =
            text(git_diff::file(&host, file("새 이름.txt", Some("old name.txt"), false)).await?);
        assert!(renamed.contains("rename from old name.txt\nrename to 새 이름.txt"));
        let binary = text(git_diff::file(&host, file("image.bin", None, false)).await?);
        assert!(binary.contains("Binary files a/image.bin and b/image.bin differ"));
        let untracked = text(git_diff::file(&host, file("추적 안 함.txt", None, true)).await?);
        assert!(untracked.contains("+++ b/추적 안 함.txt") && untracked.contains("\n+u\n"));
        assert_eq!(
            git_diff::file(&host, file("big.log", None, true)).await?,
            FileDiff::TooLarge {
                size: Some(3_145_728)
            }
        );

        // Against the merge base with `base`, the committed line shows too.
        let branch = DiffBase::Branch {
            reference: "refs/heads/base".into(),
        };
        let DiffList::Files { files, .. } = git_diff::list(&host, &root, &branch).await? else {
            panic!("the branch list stopped");
        };
        let tracked = files.iter().find(|f| f.path == "tracked.txt").unwrap();
        assert_eq!((tracked.added, tracked.removed), (Some(2), Some(0)));
        let missing = DiffBase::Branch {
            reference: "refs/heads/nope".into(),
        };
        assert!(git_diff::list(&host, &root, &missing).await.is_err());

        for kind in ["fsmonitor", "external", "textconv"] {
            assert_ne!(shell(manager, id, &ran(kind)).await?, 0, "{kind} ran");
        }
        // The same repository runs each program for plain Git commands, so the checks above
        // would have caught them.
        let plain = format!(
            "cd '{root}' && git status --porcelain >/dev/null 2>&1; git diff >/dev/null 2>&1; \
             git diff --no-ext-diff >/dev/null 2>&1; {} && {} && {}",
            ran("fsmonitor"),
            ran("external"),
            ran("textconv")
        );
        assert_eq!(
            shell(manager, id, &plain).await?,
            0,
            "malicious settings fixture"
        );
        Ok::<_, Box<dyn std::error::Error>>(())
    }
    .await;
    let cleanup = format!("rm -rf '{root}' '{program}'*");
    shell(manager, id, &cleanup).await?;
    result?;
    println!(
        "PASS product Git diff: all change kinds, spaced and Korean paths, branch base, size limit; \
         external diff, textconv and fsmonitor not run"
    );
    Ok(())
}
