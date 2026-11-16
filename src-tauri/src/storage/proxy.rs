//! The proxy a session's first TCP connection goes through (CG.1). It lives in the profile JSON;
//! its password is a reference like a forwarded key's Passphrase, set only by the backend and
//! collected through the `credential_gc` journal when it leaves.
use super::{Profile, Result, Store, db_error, profile_data};
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// SOCKS5 carries the user name and password with a one-byte length (RFC 1929).
pub const MAX_PROXY_FIELD: usize = 255;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Proxy {
    Http {
        host: String,
        port: u16,
        #[serde(default)]
        username: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secret_ref: Option<String>,
    },
    Socks5 {
        host: String,
        port: u16,
        #[serde(default)]
        username: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secret_ref: Option<String>,
    },
    /// OpenSSH's `ProxyCommand` (CG.2): the SSH connection runs over the command's standard
    /// input and output. Only a command the user typed or approved on the import preview is saved.
    Command { command: String },
}

/// The parts of an HTTP or SOCKS5 proxy the connection uses.
pub struct Endpoint<'a> {
    pub socks: bool,
    pub host: &'a str,
    pub port: u16,
    pub username: &'a str,
}

/// A command line long enough for `ssh -W` with options, short enough to read on the preview.
pub const MAX_COMMAND: usize = 4096;
/// The tokens a command may use: host, port, user, original host name and a literal `%`.
const TOKENS: [char; 5] = ['h', 'p', 'r', 'n', '%'];

/// Checks a `ProxyCommand` line: one line, and only the tokens the connection replaces.
pub fn check_command(command: &str) -> Result<()> {
    if command.trim().is_empty()
        || command.len() > MAX_COMMAND
        || command.chars().any(char::is_control)
    {
        return Err("프록시 명령은 4096바이트 이하의 한 줄로 입력하세요.".into());
    }
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if c == '%' && !chars.next().is_some_and(|t| TOKENS.contains(&t)) {
            return Err("프록시 명령에는 %h, %p, %r, %n, %%만 쓸 수 있습니다.".into());
        }
    }
    Ok(())
}

/// The program a command runs, for status lines: its first word without the folder.
pub fn command_program(command: &str) -> &str {
    let command = command.trim_start();
    let first = match command.strip_prefix(['"', '\'']) {
        Some(quoted) => quoted.split(['"', '\'']).next().unwrap_or(quoted),
        None => command.split_whitespace().next().unwrap_or(""),
    };
    first.rsplit(['/', '\\']).next().unwrap_or(first)
}

impl Proxy {
    /// `None` for a command, which has no address of its own.
    pub fn endpoint(&self) -> Option<Endpoint<'_>> {
        match self {
            Proxy::Http {
                host,
                port,
                username,
                ..
            } => Some(Endpoint {
                socks: false,
                host,
                port: *port,
                username,
            }),
            Proxy::Socks5 {
                host,
                port,
                username,
                ..
            } => Some(Endpoint {
                socks: true,
                host,
                port: *port,
                username,
            }),
            Proxy::Command { .. } => None,
        }
    }
    pub fn command(&self) -> Option<&str> {
        match self {
            Proxy::Command { command } => Some(command),
            _ => None,
        }
    }
    /// Where the password reference is kept, for the backend alone to set. A command has none.
    pub(crate) fn secret_slot(&mut self) -> Option<&mut Option<String>> {
        match self {
            Proxy::Http { secret_ref, .. } | Proxy::Socks5 { secret_ref, .. } => Some(secret_ref),
            Proxy::Command { .. } => None,
        }
    }
    pub fn secret_ref(&self) -> Option<&str> {
        match self {
            Proxy::Http { secret_ref, .. } | Proxy::Socks5 { secret_ref, .. } => {
                secret_ref.as_deref()
            }
            Proxy::Command { .. } => None,
        }
    }
    pub fn clear_secret(&mut self) {
        if let Some(slot) = self.secret_slot() {
            slot.take();
        }
    }
    /// The same proxy and account (or the same command), so a saved password still belongs to it.
    pub fn same_target(&self, other: &Proxy) -> bool {
        match (self.endpoint(), other.endpoint()) {
            (Some(a), Some(b)) => {
                a.socks == b.socks
                    && a.host == b.host
                    && a.port == b.port
                    && a.username == b.username
            }
            (None, None) => self.command() == other.command(),
            _ => false,
        }
    }
    /// Keeps the saved password while the proxy and account stay the same; a form or a file
    /// cannot choose one.
    pub fn keep_secret(&mut self, saved: Option<&Proxy>) {
        let kept = saved
            .filter(|s| s.same_target(self))
            .and_then(Proxy::secret_ref)
            .map(String::from);
        if let Some(slot) = self.secret_slot() {
            *slot = kept;
        }
    }
    /// What the connection's status line shows, e.g. `SOCKS5 프록시 경유 (proxy:1080)` or
    /// `명령으로 연결: nc`.
    pub fn label(&self) -> String {
        match self.endpoint() {
            Some(e) => {
                let kind = if e.socks { "SOCKS5" } else { "HTTP" };
                format!("{kind} 프록시 경유 ({}:{})", e.host, e.port)
            }
            None => format!(
                "명령으로 연결: {}",
                command_program(self.command().unwrap_or(""))
            ),
        }
    }
    pub fn validate(&self) -> Result<()> {
        let Some(e) = self.endpoint() else {
            return check_command(self.command().unwrap_or(""));
        };
        if !super::valid_host(e.host)
            || e.port == 0
            || e.username.len() > MAX_PROXY_FIELD
            || e.username.chars().any(char::is_control)
        {
            return Err(
                "프록시 호스트·포트·사용자 이름을 확인하세요. 사용자 이름은 255바이트 이하입니다."
                    .into(),
            );
        }
        Ok(())
    }
}

impl Profile {
    /// Stored secret references kept inside the profile data rather than its `secret_ref`
    /// column: forwarded key Passphrases and the proxy password.
    pub fn data_refs(&self) -> impl Iterator<Item = &str> {
        self.forward_refs()
            .chain(self.proxy.as_ref().and_then(Proxy::secret_ref))
    }
    pub(crate) fn check_proxy(&self) -> Result<()> {
        let Some(proxy) = &self.proxy else {
            return Ok(());
        };
        if self.protocol != "ssh" {
            return Err("FTP 세션에는 프록시를 쓸 수 없습니다.".into());
        }
        // The first TCP connection of a route belongs to its first jump host (design §3-2).
        if !self.jump_ids.is_empty() {
            return Err("경유지가 있는 세션은 첫 경유지 세션에 프록시를 지정하세요.".into());
        }
        proxy.validate()
    }
}

impl Store {
    /// Points the session's proxy at a password `Vault::save` just stored and staged, or forgets
    /// it with `None`. If a cleanup removed the new one in between, it is staged again and nothing
    /// refers to it.
    pub fn set_proxy_secret(&self, profile: &str, reference: Option<&str>) -> Result<Profile> {
        let mut p = self.profile(profile)?;
        let slot = (p.proxy.as_mut().and_then(Proxy::secret_slot))
            .ok_or("세션의 프록시가 바뀌어 암호를 저장하지 않았습니다.")?;
        let previous = std::mem::replace(slot, reference.map(String::from));
        let data = profile_data(&p)?;
        {
            let mut db = self.0.lock().unwrap();
            let tx = db.transaction().map_err(db_error)?;
            if let Some(reference) = reference
                && tx
                    .execute("DELETE FROM credential_gc WHERE id=?", [reference])
                    .map_err(db_error)?
                    == 0
            {
                drop(tx);
                db.execute("INSERT OR IGNORE INTO credential_gc VALUES(?)", [reference])
                    .map_err(db_error)?;
                return Err("프록시 암호를 저장하지 못했습니다. 다시 시도하세요.".into());
            }
            if let Some(previous) = previous.filter(|p| Some(p.as_str()) != reference) {
                tx.execute("INSERT OR IGNORE INTO credential_gc VALUES(?)", [previous])
                    .map_err(db_error)?;
            }
            tx.execute(
                "UPDATE profiles SET data=?1 WHERE id=?2",
                params![data, profile],
            )
            .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
        }
        self.profile(profile)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::tests::profile;

    pub fn http(username: &str) -> Proxy {
        Proxy::Http {
            host: "proxy.example".into(),
            port: 3128,
            username: username.into(),
            secret_ref: None,
        }
    }
    fn journaled(store: &Store) -> Vec<String> {
        let db = store.0.lock().unwrap();
        let mut statement = db
            .prepare("SELECT id FROM credential_gc ORDER BY id")
            .unwrap();
        statement
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn the_json_names_the_kind_and_never_takes_unknown_fields() {
        let mut p = profile();
        p.proxy = Some(Proxy::Socks5 {
            host: "10.0.0.1".into(),
            port: 1080,
            username: "u".into(),
            secret_ref: Some("ref".into()),
        });
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains(
            r#""proxy":{"kind":"socks5","host":"10.0.0.1","port":1080,"username":"u","secretRef":"ref"}"#
        ));
        let back: Profile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.proxy, p.proxy);
        let plain = serde_json::to_string(&profile()).unwrap();
        assert!(!plain.contains("proxy"), "absent when unset");
        let unknown = json.replace(r#""username":"u""#, r#""username":"u","extra":1"#);
        assert!(serde_json::from_str::<Profile>(&unknown).is_err());
        let other = json.replace("socks5", "socks4");
        assert!(serde_json::from_str::<Profile>(&other).is_err());
        let minimal: Proxy =
            serde_json::from_str(r#"{"kind":"http","host":"h","port":8080}"#).unwrap();
        assert_eq!(minimal.endpoint().unwrap().username, "");
    }

    #[test]
    fn a_proxy_needs_ssh_no_jump_hosts_and_valid_fields() {
        let mut p = profile();
        p.proxy = Some(http("user"));
        assert!(p.validate().is_ok());
        let mut ftp = p.clone();
        ftp.protocol = "ftp".into();
        ftp.auth = "password".into();
        assert_eq!(
            ftp.validate().unwrap_err(),
            "FTP 세션에는 프록시를 쓸 수 없습니다."
        );
        let mut jumped = p.clone();
        jumped.jump_ids = vec!["hop".into()];
        assert!(jumped.validate().unwrap_err().contains("첫 경유지"));
        for bad in [
            Proxy::Http {
                host: "bad host".into(),
                port: 1,
                username: String::new(),
                secret_ref: None,
            },
            Proxy::Socks5 {
                host: "h".into(),
                port: 0,
                username: String::new(),
                secret_ref: None,
            },
            http(&"u".repeat(256)),
            http("a\nb"),
        ] {
            p.proxy = Some(bad);
            assert!(p.validate().is_err());
        }
        p.proxy = Some(http(&"u".repeat(255)));
        assert!(p.validate().is_ok());
    }

    #[test]
    fn the_password_reference_is_set_by_the_backend_and_follows_the_same_proxy() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        let mut p = profile();
        let mut forged = http("user");
        *forged.secret_slot().unwrap() = Some("forged".into());
        p.proxy = Some(forged);
        let p = store.save(p, None).unwrap();
        assert_eq!(p.data_refs().count(), 0, "a form cannot pick a reference");
        assert!(store.set_proxy_secret(&p.id, Some("unstaged")).is_err());
        assert_eq!(journaled(&store), ["unstaged"], "stays journaled");
        store.stage_secret("ref-1").unwrap();
        let p = store.set_proxy_secret(&p.id, Some("ref-1")).unwrap();
        assert_eq!(p.proxy.as_ref().unwrap().secret_ref(), Some("ref-1"));
        assert_eq!(journaled(&store), ["unstaged"]);
        // Saving the form again keeps it; the same proxy with another account drops it.
        let mut edited = store.profile(&p.id).unwrap();
        edited.proxy.as_mut().unwrap().clear_secret();
        edited.name = "renamed".into();
        let edited = store.save(edited, None).unwrap();
        assert_eq!(edited.proxy.as_ref().unwrap().secret_ref(), Some("ref-1"));
        let mut other = edited.clone();
        other.proxy = Some(http("someone-else"));
        let other = store.save(other, None).unwrap();
        assert_eq!(other.data_refs().count(), 0);
        assert!(journaled(&store).contains(&"ref-1".to_string()));
        // Forgetting and deleting journal the reference too.
        store.stage_secret("ref-2").unwrap();
        store.set_proxy_secret(&p.id, Some("ref-2")).unwrap();
        store.set_proxy_secret(&p.id, None).unwrap();
        assert!(journaled(&store).contains(&"ref-2".to_string()));
        store.stage_secret("ref-3").unwrap();
        store.set_proxy_secret(&p.id, Some("ref-3")).unwrap();
        store.delete(&p.id).unwrap();
        assert!(journaled(&store).contains(&"ref-3".to_string()));
        let plain = store.save(profile(), None).unwrap();
        assert!(store.set_proxy_secret(&plain.id, None).is_err(), "no proxy");
    }

    #[test]
    fn a_proxy_password_in_use_survives_the_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        let mut p = profile();
        p.proxy = Some(http("user"));
        let p = store.save(p, None).unwrap();
        store.stage_secret("in-use").unwrap();
        store.set_proxy_secret(&p.id, Some("in-use")).unwrap();
        // A stale journal entry for a reference that is still in use must not be deleted.
        store.stage_secret("in-use").unwrap();
        store.cleanup_credentials().unwrap();
        assert_eq!(
            store.profile(&p.id).unwrap().proxy.unwrap().secret_ref(),
            Some("in-use")
        );
        assert_eq!(journaled(&store), ["in-use"], "kept, not removed");
    }
    #[test]
    fn a_command_is_one_line_with_known_tokens_and_has_no_password() {
        let command = |c: &str| Proxy::Command { command: c.into() };
        for ok in ["nc %h %p", "ssh -W %h:%p -l %r jump", "connect %n 100%%"] {
            assert!(command(ok).validate().is_ok(), "{ok}");
        }
        for bad in [
            "",
            "  ",
            "nc %h %d",
            "nc %h %",
            "a\nb",
            &"x".repeat(MAX_COMMAND + 1),
        ] {
            assert!(command(bad).validate().is_err(), "{bad:?}");
        }
        let p = command("/opt/homebrew/bin/socat - TCP:%h:%p");
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"kind":"command","command":"/opt/homebrew/bin/socat - TCP:%h:%p"}"#
        );
        assert_eq!(p.label(), "명령으로 연결: socat");
        assert_eq!(
            command(r#""C:\Program Files\x.exe" %h"#).label(),
            "명령으로 연결: x.exe"
        );
        assert!(p.same_target(&p.clone()) && !p.same_target(&command("nc %h %p")));
        assert!(!p.same_target(&http("u")));
        let mut cleared = p.clone();
        cleared.clear_secret();
        cleared.keep_secret(Some(&p));
        assert_eq!(cleared, p);
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        let mut profile = profile();
        profile.proxy = Some(p);
        let saved = store.save(profile, None).unwrap();
        assert!(
            store.set_proxy_secret(&saved.id, None).is_err(),
            "no password"
        );
    }
}
