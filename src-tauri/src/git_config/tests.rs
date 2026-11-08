use super::*;
use crate::git_credential::git_program;

fn set(key: &str, value: &str) -> Change {
    Change::Set {
        key: key.into(),
        value: value.into(),
        all: false,
    }
}
fn local(folder: &str) -> Scope {
    Scope::Local {
        folder: folder.into(),
    }
}

#[test]
fn only_listed_settings_with_valid_values_pass() {
    assert!(check(&set("user.name", "김 개발"), &Scope::Global).is_ok());
    assert!(check(&set("pull.rebase", "merges"), &Scope::Global).is_ok());
    assert!(check(&set("pull.rebase", "maybe"), &Scope::Global).is_err());
    assert!(check(&set("http.extraHeader", "x"), &Scope::Global).is_err());
    assert!(check(&set("user.name", ""), &Scope::Global).is_err());
    assert!(check(&set("user.name", "a\nb"), &Scope::Global).is_err());
    assert!(
        check(
            &set("user.name", &"x".repeat(MAX_VALUE + 1)),
            &Scope::Global
        )
        .is_err()
    );
    let too_many = vec![set("user.name", "a"); MAX_CHANGES + 1];
    assert!(check_all(&too_many, &Scope::Global).is_err());
}

#[test]
fn the_helper_is_replaced_only_and_the_directory_list_only_grows() {
    let unset = |key: &str| Change::Unset {
        key: key.into(),
        all: false,
    };
    let add = |key: &str| Change::Add {
        key: key.into(),
        value: "/srv/app".into(),
    };
    assert!(check(&unset("user.name"), &Scope::Global).is_ok());
    assert!(check(&unset("credential.helper"), &Scope::Global).is_err());
    assert!(check(&set("credential.helper", "store"), &Scope::Global).is_ok());
    assert!(check(&add("credential.helper"), &Scope::Global).is_err());
    assert!(check(&add("safe.directory"), &Scope::Global).is_ok());
    assert!(check(&set("safe.directory", "/x"), &Scope::Global).is_err());
    assert!(check(&unset("safe.directory"), &Scope::Global).is_err());
    assert!(check(&add("safe.directory"), &local("/r")).is_err());
}

#[test]
fn the_shown_command_is_the_one_that_runs() {
    let change = Change::Set {
        key: "user.name".into(),
        value: "김 it's".into(),
        all: false,
    };
    assert_eq!(
        change.command(&Scope::Global),
        ["config", "--global", "user.name", "김 it's"]
    );
    assert_eq!(
        preview(std::slice::from_ref(&change), &Scope::Global, false).unwrap(),
        ["git config --global user.name '김 it'\\''s'"]
    );
    assert_eq!(
        preview(&[change], &Scope::Global, true).unwrap(),
        ["git config --global user.name \"김 it's\""]
    );
    let several = [
        Change::Set {
            key: "core.editor".into(),
            value: "vim".into(),
            all: true,
        },
        Change::Unset {
            key: "pull.ff".into(),
            all: false,
        },
        Change::Unset {
            key: "user.name".into(),
            all: true,
        },
        Change::Add {
            key: "safe.directory".into(),
            value: "*".into(),
        },
    ];
    assert_eq!(
        preview(&several, &Scope::Global, false).unwrap(),
        [
            "git config --global --replace-all core.editor vim",
            "git config --global --unset pull.ff",
            "git config --global --unset-all user.name",
            "git config --global --add safe.directory '*'",
        ]
    );
    assert_eq!(
        preview(&several[..1], &local("/r"), false).unwrap(),
        ["git config --local --replace-all core.editor vim"]
    );
    assert!(preview(&several, &local("/r"), false).is_err());
}

#[test]
fn parsing_keeps_listed_settings_in_their_spelling() {
    let entries = parse(
        b"user.name\nKim\0merge.conflictstyle\nzdiff3\0safe.directory\n/a\0safe.directory\n/b\0\
          user.email\0http.extraheader\nAuthorization: secret\0",
    );
    assert_eq!(
        entries,
        [
            Entry {
                key: "user.name".into(),
                values: vec!["Kim".into()],
                hidden: false
            },
            Entry {
                key: "merge.conflictStyle".into(),
                values: vec!["zdiff3".into()],
                hidden: false
            },
            Entry {
                key: "safe.directory".into(),
                values: vec!["/a".into(), "/b".into()],
                hidden: false
            },
            Entry {
                key: "user.email".into(),
                values: vec!["".into()],
                hidden: false
            },
        ]
    );
}

#[test]
fn a_helper_that_may_hold_a_secret_is_never_returned() {
    let shown = parse(b"credential.helper\n\0credential.helper\nmanager\0");
    assert_eq!(shown[0].values, ["", "manager"]);
    assert!(!shown[0].hidden);
    for value in [
        "!f() { echo password=abc; }; f",
        "store --file=/x --token=abc",
        "https://user:abc@example.test",
        "cache --key=abc",
    ] {
        let record = format!("credential.helper\n{value}\0credential.helper\nmanager\0");
        let entries = parse(record.as_bytes());
        assert!(entries[0].hidden, "{value}");
        assert!(entries[0].values.is_empty(), "{value}");
    }
}

#[test]
fn the_read_pattern_names_every_setting_in_lower_case() {
    let pattern = key_pattern();
    assert!(pattern.contains("merge\\.conflictstyle"));
    assert!(pattern.starts_with("^(user\\.name|"));
    assert!(pattern.ends_with("safe\\.directory)$"));
    assert_eq!(pattern.matches('|').count(), FIELDS.len() - 1);
}

#[test]
fn counts_the_commands_that_finished() {
    assert_eq!(applied(b""), 0);
    assert_eq!(applied(b"\0\0"), 2);
}

#[test]
fn a_global_command_starts_outside_any_repository() {
    let wsl = GitHost::Wsl(crate::local::Target::for_test("wsl:U", "wsl"));
    assert_eq!(Scope::Global.folder(&wsl), "/");
    assert_eq!(local("/r").folder(&wsl), "/r");
    let native = GitHost::Native(None);
    assert_eq!(
        Scope::Global.folder(&native),
        std::env::temp_dir().to_string_lossy()
    );
}

/// Runs this PC's real git on a repository's own settings; skipped where none is installed. The
/// global file is the user's, so this test never writes to it.
#[tokio::test]
async fn reads_and_writes_a_real_repository() {
    let Some(program) = git_program() else { return };
    let host = GitHost::Native(Some(program.clone()));
    let repo = tempfile::tempdir().unwrap();
    let folder = repo.path().to_str().unwrap().to_string();
    let init = std::process::Command::new(&program)
        .args(["-C", &folder, "init", "-q"])
        .status()
        .unwrap();
    assert!(init.success());
    let scope = local(&folder);
    let value = |entries: &[Entry], key: &str| {
        entries
            .iter()
            .find(|e| e.key == key)
            .map(|e| e.values.clone())
    };

    // A value that starts with a dash is still a value.
    let changes = [
        set("user.name", "-김 개발"),
        set("merge.conflictStyle", "zdiff3"),
    ];
    write(&host, &scope, &changes).await.unwrap();
    let entries = read(&host, &scope).await.unwrap();
    assert_eq!(
        value(&entries, "user.name"),
        Some(vec!["-김 개발".to_string()])
    );
    assert_eq!(
        value(&entries, "merge.conflictStyle"),
        Some(vec!["zdiff3".to_string()])
    );

    let config = repo.path().join(".git").join("config");
    let text = std::fs::read_to_string(&config).unwrap();
    std::fs::write(
        &config,
        format!("{text}[user]\n\tname = 둘째\n[http]\n\textraHeader = SECRET\n"),
    )
    .unwrap();
    assert_eq!(
        value(&read(&host, &scope).await.unwrap(), "user.name"),
        Some(vec!["-김 개발".to_string(), "둘째".to_string()])
    );
    let plain_set = write(&host, &scope, &[set("user.name", "셋째")]).await;
    assert!(
        plain_set.unwrap_err().starts_with("1개 중 0개만"),
        "several values need --replace-all"
    );
    let replace = Change::Set {
        key: "user.name".into(),
        value: "셋째".into(),
        all: true,
    };
    write(&host, &scope, &[replace]).await.unwrap();
    let entries = read(&host, &scope).await.unwrap();
    assert_eq!(value(&entries, "user.name"), Some(vec!["셋째".to_string()]));
    assert!(!entries.iter().any(|e| e.key.starts_with("http")));

    let unset = Change::Unset {
        key: "user.name".into(),
        all: false,
    };
    write(&host, &scope, std::slice::from_ref(&unset))
        .await
        .unwrap();
    assert_eq!(
        value(&read(&host, &scope).await.unwrap(), "user.name"),
        None
    );

    // The first command fails, so the second one does not run.
    let stops = [unset, set("rerere.enabled", "true")];
    let failed = write(&host, &scope, &stops).await.unwrap_err();
    assert!(failed.starts_with("2개 중 0개만"), "{failed}");
    assert_eq!(
        value(&read(&host, &scope).await.unwrap(), "rerere.enabled"),
        None
    );
}

#[tokio::test]
async fn a_folder_that_is_no_repository_reports_it() {
    let Some(program) = git_program() else { return };
    let host = GitHost::Native(Some(program));
    let plain = tempfile::tempdir().unwrap();
    let scope = local(plain.path().to_str().unwrap());
    assert!(!read(&host, &scope).await.unwrap_err().is_empty());
}

#[tokio::test]
async fn a_missing_git_reads_as_such() {
    let host = GitHost::Native(None);
    assert_eq!(
        read(&host, &Scope::Global).await,
        Err("이 PC에서 git을 찾지 못했습니다.".to_string())
    );
}
