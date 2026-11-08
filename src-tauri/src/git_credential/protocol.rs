//! What crosses the forwarded socket and what the server's shells receive. Pure functions: the
//! request comes from a server the app does not trust, and the helper text is typed into shells.
use crate::remote_exec::quote;
use zeroize::Zeroizing;

pub const MAX_REQUEST: usize = 64 * 1024;
const MAX_FIELD: usize = 4096;
/// A Unix socket path must fit `sun_path` (104 bytes on macOS servers, 108 on Linux).
pub const MAX_SOCKET_PATH: usize = 100;

/// One `get` from git's `credential-cache` client (DX.12.0: the same from git 1.8 to 2.56).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub protocol: String,
    pub host: String,
    /// Only sent when the server's git has `credential.useHttpPath`.
    pub path: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    TooLarge,
    /// Not UTF-8, or a NUL or another control character.
    NotText,
    Malformed,
    /// `store` and `erase` never reach the app, and nothing else is answered.
    NotGet,
    Missing,
}

/// Reads one request. Unknown keys (`timeout`, `capability[]`, `wwwauth[]`, a `password` git
/// already had) are ignored; a key the app uses must appear at most once.
pub fn parse(bytes: &[u8]) -> Result<Request, Refused> {
    if bytes.len() > MAX_REQUEST {
        return Err(Refused::TooLarge);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Refused::NotText)?;
    if text.chars().any(|c| c.is_control() && c != '\n') {
        return Err(Refused::NotText);
    }
    let (mut action, mut protocol, mut host, mut path, mut username) =
        (None, None, None, None, None);
    for line in text.split('\n').filter(|line| !line.is_empty()) {
        let (key, value) = line.split_once('=').ok_or(Refused::Malformed)?;
        if value.len() > MAX_FIELD {
            return Err(Refused::Malformed);
        }
        let slot = match key {
            "action" => &mut action,
            "protocol" => &mut protocol,
            "host" => &mut host,
            "path" => &mut path,
            "username" => &mut username,
            _ => continue,
        };
        if slot.replace(value.to_string()).is_some() {
            return Err(Refused::Malformed);
        }
    }
    if action.as_deref() != Some("get") {
        return Err(Refused::NotGet);
    }
    let (Some(protocol), Some(host)) = (protocol, host) else {
        return Err(Refused::Missing);
    };
    if protocol.is_empty()
        || host.is_empty()
        || host
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '/' | '\\'))
    {
        return Err(Refused::Missing);
    }
    Ok(Request {
        protocol,
        host,
        path: path.filter(|p| !p.is_empty()),
        username: username.filter(|u| !u.is_empty()),
    })
}

/// A value the server's git can read back as exactly one field.
pub fn usable_value(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

/// The answer the client hands to git unchanged. The channel is closed after it.
pub fn answer(username: &str, password: &str) -> Zeroizing<Vec<u8>> {
    Zeroizing::new(format!("username={username}\npassword={password}\n").into_bytes())
}

/// The path goes unquoted into the helper, which sits inside one single-quoted
/// `GIT_CONFIG_PARAMETERS` item, so only characters that need no quoting are allowed.
pub fn usable_path(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= MAX_SOCKET_PATH
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-'))
}

/// Passes `get` only, and only to a socket the user owns (DX.12.0): an old path may outlive its
/// connection in a tmux pane, and someone else could later make a socket there.
pub fn helper(path: &str) -> String {
    format!(
        "!f() {{ [ \"$1\" = get ] && [ -S {path} ] && [ -O {path} ] || return 0; \
         exec git credential-cache --socket {path} get; }}; f"
    )
}

/// One `GIT_CONFIG_PARAMETERS` item, appended after the user's own.
pub fn parameter(path: &str) -> String {
    format!("'credential.helper={}'", helper(path))
}

/// `GIT_CONFIG_PARAMETERS` with the item appended, as one shell word. The item keeps its
/// single quotes, so the `!` never meets interactive history expansion.
fn appended(path: &str) -> String {
    format!(
        "\"${{GIT_CONFIG_PARAMETERS:+$GIT_CONFIG_PARAMETERS }}\"{}",
        quote(&parameter(path))
    )
}

/// Typed into Bash or Zsh with the shell hook. A second run in the same shell adds nothing, or a
/// refused request would ask the card twice.
pub fn shell_export(path: &str) -> String {
    format!(
        "case \"$GIT_CONFIG_PARAMETERS\" in *{path}*) ;; *) export GIT_CONFIG_PARAMETERS={};; esac",
        appended(path)
    )
}

/// The lines a tmux start script runs before creating or attaching the session.
pub fn tmux_export(path: &str) -> String {
    format!(
        "GIT_CONFIG_PARAMETERS={}\nexport GIT_CONFIG_PARAMETERS",
        appended(path)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(lines: &[&str]) -> Vec<u8> {
        lines
            .iter()
            .map(|l| format!("{l}\n"))
            .collect::<String>()
            .into_bytes()
    }

    #[test]
    fn reads_the_requests_every_measured_git_sends() {
        let push = get(&[
            "action=get",
            "timeout=900",
            "protocol=https",
            "host=git.test:3000",
        ]);
        assert_eq!(
            parse(&push),
            Ok(Request {
                protocol: "https".into(),
                host: "git.test:3000".into(),
                path: None,
                username: None,
            })
        );
        // git 2.56 with git-lfs 3.8: capabilities and the server's challenge are ignored.
        let lfs = get(&[
            "action=get",
            "timeout=900",
            "capability[]=authtype",
            "capability[]=state",
            "protocol=https",
            "host=git.test:3000",
            "wwwauth[]=Basic realm=\"gitea-lfs\"",
        ]);
        assert_eq!(parse(&lfs).unwrap().host, "git.test:3000");
        let full = get(&[
            "action=get",
            "protocol=https",
            "host=git.test",
            "path=probe/r.git",
            "username=probe",
            "password=already-known",
        ]);
        let full = parse(&full).unwrap();
        assert_eq!(full.path.as_deref(), Some("probe/r.git"));
        assert_eq!(full.username.as_deref(), Some("probe"));
        // No final line feed is the same request.
        assert!(parse(b"action=get\nprotocol=https\nhost=h").is_ok());
    }

    #[test]
    fn refuses_anything_else() {
        assert_eq!(
            parse(&get(&["action=store", "protocol=https", "host=h"])),
            Err(Refused::NotGet)
        );
        assert_eq!(
            parse(&get(&["action=erase", "protocol=https", "host=h"])),
            Err(Refused::NotGet)
        );
        assert_eq!(
            parse(&get(&["protocol=https", "host=h"])),
            Err(Refused::NotGet)
        );
        assert_eq!(
            parse(&get(&["action=get", "host=h"])),
            Err(Refused::Missing)
        );
        assert_eq!(
            parse(&get(&["action=get", "protocol=https", "host=a b"])),
            Err(Refused::Missing)
        );
        assert_eq!(
            parse(&get(&["action=get", "protocol=https", "host=h", "junk"])),
            Err(Refused::Malformed)
        );
        assert_eq!(
            parse(&get(&[
                "action=get",
                "protocol=https",
                "host=h",
                "host=evil"
            ])),
            Err(Refused::Malformed),
            "a second host could hide the first"
        );
        for control in ["\0", "\r", "\x1b[2J", "\u{85}"] {
            let bytes = get(&["action=get", "protocol=https", &format!("host=h{control}")]);
            assert_eq!(parse(&bytes), Err(Refused::NotText), "{control:?}");
        }
        assert_eq!(parse(b"action=get\nhost=\xff"), Err(Refused::NotText));
        let mut large = get(&["action=get", "protocol=https", "host=h"]);
        large.extend(std::iter::repeat_n(b'a', MAX_REQUEST));
        assert_eq!(parse(&large), Err(Refused::TooLarge));
        let long = format!("username={}", "u".repeat(MAX_FIELD + 1));
        assert_eq!(
            parse(&get(&["action=get", "protocol=https", "host=h", &long])),
            Err(Refused::Malformed)
        );
    }

    #[test]
    fn the_answer_is_two_fields() {
        assert_eq!(&**answer("me", "t0ken"), b"username=me\npassword=t0ken\n");
        assert!(usable_value("t0ken", 16));
        assert!(!usable_value("", 16));
        assert!(
            !usable_value("a\nhost=evil", 64),
            "a line feed adds a field"
        );
        assert!(!usable_value(&"a".repeat(17), 16));
    }

    #[test]
    fn socket_paths_need_no_quoting() {
        assert!(usable_path("/run/user/1000/dachsterm-git-0a1b"));
        assert!(usable_path("/tmp/dachsterm-git-0a1b"));
        for bad in [
            "tmp/x",
            "/tmp/a b",
            "/tmp/a'b",
            "/tmp/$(id)",
            "/tmp/a;b",
            "/tmp/한",
        ] {
            assert!(!usable_path(bad), "{bad}");
        }
        assert!(!usable_path(&format!("/{}", "a".repeat(MAX_SOCKET_PATH))));
    }

    #[test]
    fn the_helper_keeps_its_quotes_and_asks_only_its_own_socket() {
        let path = "/tmp/dachsterm-git-0a1b";
        assert_eq!(
            parameter(path),
            "'credential.helper=!f() { [ \"$1\" = get ] && [ -S /tmp/dachsterm-git-0a1b ] && \
             [ -O /tmp/dachsterm-git-0a1b ] || return 0; exec git credential-cache --socket \
             /tmp/dachsterm-git-0a1b get; }; f'"
        );
        // The item's own single quotes are escaped, and no `!` is outside single quotes.
        let export = shell_export(path);
        assert!(export.starts_with("case \"$GIT_CONFIG_PARAMETERS\" in *"));
        assert!(export.contains(
            "export GIT_CONFIG_PARAMETERS=\"${GIT_CONFIG_PARAMETERS:+$GIT_CONFIG_PARAMETERS }\"''\\''credential.helper=!f()"
        ));
        assert!(export.ends_with("f'\\''';; esac"));
        assert!(tmux_export(path).ends_with("\nexport GIT_CONFIG_PARAMETERS"));
    }

    /// Runs the export in this PC's POSIX shell, where one exists, and reads the value back.
    #[cfg(unix)]
    #[test]
    fn a_shell_builds_the_value_once() {
        let path = "/tmp/dachsterm-git-0a1b";
        let script = format!(
            "GIT_CONFIG_PARAMETERS=\"'core.pager=less -R'\"; {e}; {e}; printf %s \"$GIT_CONFIG_PARAMETERS\"",
            e = shell_export(path)
        );
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("'core.pager=less -R' {}", parameter(path))
        );
    }
}
