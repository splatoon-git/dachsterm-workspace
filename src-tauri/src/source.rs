//! Where a file or a Git command lives: one SSH connection, one local or WSL target, or one FTP
//! connection. Commands that work on any tab take this instead of a string with the kind mixed in.
use crate::storage::Result;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    #[serde(rename_all = "camelCase")]
    Ssh { connection_id: String },
    #[serde(rename_all = "camelCase")]
    Local { target_id: String },
    #[serde(rename_all = "camelCase")]
    Ftp { connection_id: String },
}

/// A source Git can run on, so that the code that runs it has no FTP case to refuse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitSource<'a> {
    Ssh(&'a str),
    Local(&'a str),
}

impl Source {
    /// An FTP server has no shell and no Git to run.
    pub fn for_git(&self) -> Result<GitSource<'_>> {
        match self {
            Source::Ssh { connection_id } => Ok(GitSource::Ssh(connection_id)),
            Source::Local { target_id } => Ok(GitSource::Local(target_id)),
            Source::Ftp { .. } => Err("FTP 연결에서는 Git을 쓸 수 없습니다.".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{GitSource, Source};

    #[test]
    fn reads_each_kind_from_the_window() {
        let ssh: Source = serde_json::from_str(r#"{"kind":"ssh","connectionId":"c1"}"#).unwrap();
        assert_eq!(
            ssh,
            Source::Ssh {
                connection_id: "c1".into()
            }
        );
        let local: Source = serde_json::from_str(r#"{"kind":"local","targetId":"wsl:U"}"#).unwrap();
        assert_eq!(
            local,
            Source::Local {
                target_id: "wsl:U".into()
            }
        );
        let ftp: Source = serde_json::from_str(r#"{"kind":"ftp","connectionId":"f"}"#).unwrap();
        assert_eq!(
            ftp,
            Source::Ftp {
                connection_id: "f".into()
            }
        );
        assert!(serde_json::from_str::<Source>(r#"{"kind":"rdp"}"#).is_err());
        assert!(serde_json::from_str::<Source>(r#"{"kind":"ssh"}"#).is_err());
    }

    #[test]
    fn git_refuses_ftp_in_words_the_user_can_read() {
        let ssh = Source::Ssh {
            connection_id: "c".into(),
        };
        assert_eq!(ssh.for_git(), Ok(GitSource::Ssh("c")));
        let local = Source::Local {
            target_id: "t".into(),
        };
        assert_eq!(local.for_git(), Ok(GitSource::Local("t")));
        let ftp = Source::Ftp {
            connection_id: "f".into(),
        };
        assert_eq!(
            ftp.for_git(),
            Err("FTP 연결에서는 Git을 쓸 수 없습니다.".to_string())
        );
    }
}
