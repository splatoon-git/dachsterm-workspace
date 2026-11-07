//! Git status (DX.5) against the OpenSSH fixture: a real repository is read, and the
//! repository's own `core.fsmonitor` program never runs during the app's query.
use dachsterm::{
    git_status::{self, GitStatus, Mark},
    ssh::Connections,
};
use russh::ChannelMsg;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Fixture setup and checks the app itself never runs, on a channel of their own.
async fn shell(manager: &Connections, id: &str, script: &str) -> Result<u32> {
    let handle = manager.handle(id)?;
    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, script).await?;
    let mut exit = None;
    while let Some(message) = channel.wait().await {
        if let ChannelMsg::ExitStatus { exit_status } = message {
            exit = Some(exit_status);
        }
    }
    Ok(exit.unwrap_or(255))
}

pub async fn run(manager: &Connections, id: &str) -> Result<()> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let root = format!("/tmp/dachsterm-git-{token} 한글");
    let hook = format!("/tmp/dachsterm-git-{token}-fsmonitor");
    let setup = format!(
        "set -e; R='{root}'; H='{hook}'; mkdir -p \"$R\"; cd \"$R\"; git init -q; \
         git checkout -q -b main; git config user.email probe@example.invalid; \
         git config user.name probe; printf 'a\\n' > tracked.txt; printf 'x\\n' > removed.txt; \
         git add .; git commit -qm init; printf 'b\\n' >> tracked.txt; rm removed.txt; \
         printf 'n\\n' > 'staged file.txt'; git add 'staged file.txt'; printf 'u\\n' > '새 파일.txt'; \
         printf '#!/bin/sh\\ntouch \"$0.ran\"\\n' > \"$H\"; chmod +x \"$H\"; \
         git config core.fsmonitor \"$H\""
    );
    let result = async {
        assert_eq!(shell(manager, id, &setup).await?, 0, "fixture repository");
        let GitStatus::Repo {
            root: found,
            branch,
            entries,
            truncated,
            ..
        } = git_status::query(manager, id, &root).await?
        else {
            panic!("the fixture repository was not read");
        };
        assert_eq!(found, root);
        assert_eq!(branch.as_deref(), Some("main"));
        assert!(!truncated);
        let mut marks: Vec<_> = entries.iter().map(|e| (e.path.as_str(), e.mark)).collect();
        marks.sort_by_key(|(path, _)| *path);
        assert_eq!(
            marks,
            vec![
                ("removed.txt", Mark::Deleted),
                ("staged file.txt", Mark::Added),
                ("tracked.txt", Mark::Modified),
                ("새 파일.txt", Mark::Untracked),
            ]
        );
        let ran = format!("test -e '{hook}.ran'");
        assert_ne!(shell(manager, id, &ran).await?, 0, "fsmonitor ran");
        // The same repository runs the program for a plain `git status`, so the check above
        // would have caught it.
        let plain = format!("cd '{root}' && git status --porcelain >/dev/null 2>&1; {ran}");
        assert_eq!(shell(manager, id, &plain).await?, 0, "fsmonitor fixture");
        for folder in ["/tmp", &format!("/tmp/dachsterm-git-{token}-missing")] {
            assert!(
                matches!(
                    git_status::query(manager, id, folder).await?,
                    GitStatus::NotRepo { .. }
                ),
                "{folder}"
            );
        }
        Ok::<_, Box<dyn std::error::Error>>(())
    }
    .await;
    let cleanup = format!("rm -rf '{root}' '{hook}' '{hook}.ran'");
    shell(manager, id, &cleanup).await?;
    result?;
    println!("PASS product Git status: repository read, fsmonitor not run, non-repository quiet");
    Ok(())
}
