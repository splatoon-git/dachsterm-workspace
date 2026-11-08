//! The commit graph (GE.14) against the OpenSSH fixture: the same history as the local and WSL
//! tests reads as the same graph, and a long history stops at the limit.
use super::{Result, shell};
use dachsterm::{
    git_graph::{self, GitGraphResult, GraphCommit, GraphScope, MAX_COMMITS, RefKind},
    git_run::GitHost,
    ssh::Connections,
};

#[path = "graph_fixture.rs"]
mod fixture;

pub async fn run(manager: &Connections, id: &str) -> Result<()> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let folder = format!("/tmp/dachsterm-graph-{token} 한글");
    let big = format!("/tmp/dachsterm-graph-big-{token}");
    let host = GitHost::ssh(manager, id)?;
    let checks = async {
        assert_eq!(
            shell(manager, id, &fixture::shell_setup(&folder)).await?,
            0,
            "fixture history"
        );
        let GitGraphResult::Graph { commits, has_more } =
            git_graph::query(&host, &folder, 100, GraphScope::Auto).await?
        else {
            panic!("the fixture history was not read");
        };
        assert!(!has_more);
        assert_eq!(fixture::rows(&commits), fixture::expected());
        let merge = git_graph::detail(&host, &folder, &commits[0].hash).await?;
        assert_eq!(merge.message, "merge feature");
        assert_eq!(merge.parents.len(), 2);

        assert_eq!(
            shell(
                manager,
                id,
                &fixture::shell_big_history(&big, MAX_COMMITS + 50)
            )
            .await?,
            0,
            "long history"
        );
        let GitGraphResult::Graph { commits, has_more } =
            git_graph::query(&host, &big, MAX_COMMITS, GraphScope::Auto).await?
        else {
            panic!("the long history was not read");
        };
        assert_eq!((commits.len(), has_more), (MAX_COMMITS, true));
        Ok::<_, Box<dyn std::error::Error>>(())
    }
    .await;
    let cleanup = format!(
        "rm -rf {} {}",
        fixture::single_quote(&folder),
        fixture::single_quote(&big)
    );
    shell(manager, id, &cleanup).await?;
    checks?;
    println!("PASS product commit graph: same history, limit at {MAX_COMMITS} commits");
    Ok(())
}
