//! Starting the program that shows a file: an external editor the user chose, or whatever this
//! computer opens that kind of file with. The second can start a program or a script, and the
//! request comes from the web view, so anything that is not a plain document asks first in a native
//! dialog. It is the same boundary `editor_launch` keeps for editors (S.11).
use crate::storage::Result;
use std::path::Path;

pub enum Opener {
    Editor {
        program: String,
        args: Vec<String>,
    },
    /// The program this computer has for the file's type.
    Default,
}

/// Types that open in a viewer or an editor and run nothing by themselves. Macro-enabled office
/// files, web pages and everything else ask first.
const PLAIN: &[&str] = &[
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "hwp", "hwpx", "odt", "ods", "odp", "rtf",
    "txt", "log", "csv", "md", "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "tif", "tiff",
    "heic", "mp3", "wav", "flac", "m4a", "mp4", "mov", "mkv", "avi", "webm", "zip", "7z", "gz",
    "tar", "rar",
];

/// The extension when it is short and made of letters and digits only. A working copy is named
/// after it, and the name reaches the desktop shell.
pub fn plain_extension(name: &str) -> Option<&str> {
    let (stem, extension) = name.rsplit_once('.')?;
    let plain = !stem.is_empty()
        && (1..=16).contains(&extension.len())
        && extension.bytes().all(|b| b.is_ascii_alphanumeric());
    plain.then_some(extension)
}

fn asks_first(name: &str) -> bool {
    !plain_extension(name).is_some_and(|found| PLAIN.iter().any(|e| found.eq_ignore_ascii_case(e)))
}

fn describe(name: &str) -> String {
    format!(
        "아래 파일을 이 컴퓨터에 연결된 프로그램으로 엽니다.\n\n파일: {name}\n\n프로그램이나 스크립트라면 실행됩니다. 믿을 수 있는 파일일 때만 여세요."
    )
}

/// Called before a file goes to its default program. Asks outside the web view unless the type
/// only ever opens in a viewer.
pub async fn check_default(name: &str) -> Result<()> {
    if name.chars().any(char::is_control) {
        return Err("이 파일 이름은 기본 프로그램으로 열 수 없습니다.".into());
    }
    if !asks_first(name) {
        return Ok(());
    }
    let allowed = rfd::AsyncMessageDialog::new()
        .set_title("기본 프로그램으로 열기 확인")
        .set_description(describe(name))
        .set_level(rfd::MessageLevel::Warning)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        .await
        == rfd::MessageDialogResult::Yes;
    if allowed {
        Ok(())
    } else {
        Err("파일 열기를 취소했습니다.".into())
    }
}

fn spawn(command: &mut std::process::Command) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    // Reaps the process when it ends. The program outlives this call and is never waited on here.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn open_default(file: &Path) -> std::io::Result<()> {
    // Native test runs start a helper in place of the desktop's program. Debug builds only.
    #[cfg(debug_assertions)]
    if let Some(program) = std::env::var_os("DACHSTERM_TEST_OPENER") {
        return spawn(std::process::Command::new(program).arg(file));
    }
    open::that_detached(file)
}

impl Opener {
    /// Limits that hold whoever calls. `editor_launch::check` decides whether the editor may run.
    pub fn valid(&self) -> bool {
        match self {
            Self::Editor { program, args } => {
                !program.is_empty()
                    && program.len() <= 4096
                    && args.len() <= 32
                    && args.iter().all(|a| a.len() <= 4096)
            }
            Self::Default => true,
        }
    }

    pub fn launch(&self, file: &Path) -> std::io::Result<()> {
        match self {
            Self::Editor { program, args } => {
                // Never interpolate a shell command. The file argument is always a separate argument.
                let mut command =
                    std::process::Command::new(crate::editor_location::resolve(program));
                spawn(command.args(args).arg(file))
            }
            Self::Default => open_default(file),
        }
    }

    pub const fn failure(&self) -> &'static str {
        match self {
            Self::Editor { .. } => "편집기를 실행할 수 없습니다. 로컬 파일은 보존되었습니다.",
            Self::Default => {
                "이 파일을 여는 프로그램을 실행할 수 없습니다. 로컬 파일은 보존되었습니다."
            }
        }
    }
}

/// Marks a copy fetched from a server as downloaded, so the program that opens it applies what it
/// does for downloads: office programs open it read-only until the user allows editing, and the
/// system asks before it runs a program. Best effort: a volume that cannot hold the mark still
/// opens the file.
pub fn mark_downloaded(file: &Path) {
    #[cfg(windows)]
    {
        let mut stream = file.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        let _ = std::fs::write(stream, b"[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    #[cfg(target_os = "macos")]
    {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        let _ = std::process::Command::new("/usr/bin/xattr")
            .args(["-w", "com.apple.quarantine"])
            .arg(format!("0083;{seconds:x};DachsTerm;"))
            .arg(file)
            .status();
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = file;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documents_open_without_asking_and_anything_that_may_run_asks() {
        for name in ["보고서.hwp", "a.PDF", "b.docx", "c.xlsx", "d.png", "e.zip"] {
            assert!(!asks_first(name), "{name}");
        }
        for name in [
            "a.exe",
            "a.bat",
            "a.lnk",
            "a.docm",
            "a.html",
            "a.svg",
            "a.sh",
            "a.app",
            "README",
            ".bashrc",
            "a.pdf.exe",
            "a.p&df",
            "a.",
        ] {
            assert!(asks_first(name), "{name}");
        }
    }

    #[test]
    fn only_a_short_plain_extension_names_a_working_copy() {
        assert_eq!(plain_extension("a.tar.gz"), Some("gz"));
        assert_eq!(plain_extension("한글.hwp"), Some("hwp"));
        assert_eq!(plain_extension("a.b&c"), None);
        assert_eq!(plain_extension("a.%TEMP%"), None);
        assert_eq!(plain_extension(".profile"), None);
        assert_eq!(plain_extension("none"), None);
        assert_eq!(plain_extension(&format!("a.{}", "x".repeat(17))), None);
    }

    #[test]
    fn an_editor_launch_keeps_its_limits() {
        let editor = |program: &str, args: Vec<String>| Opener::Editor {
            program: program.into(),
            args,
        };
        assert!(editor("code", vec![]).valid());
        assert!(!editor("", vec![]).valid());
        assert!(!editor("code", vec!["x".into(); 33]).valid());
        assert!(!editor("code", vec!["x".repeat(4097)]).valid());
        assert!(Opener::Default.valid());
    }

    /// Opens a real window of this computer's text editor, so it runs only when asked for:
    /// `cargo test -p dachsterm --lib --locked file_opener -- --ignored`. The file is at the path
    /// in DACHSTERM_OPEN_CHECK and is named to show that nothing in the name is expanded or split.
    #[test]
    #[ignore = "opens the desktop's program for a text file"]
    fn the_desktop_opens_a_file_whose_name_a_shell_would_change() {
        let folder = std::env::var_os("DACHSTERM_OPEN_CHECK").expect("DACHSTERM_OPEN_CHECK");
        let file = Path::new(&folder).join("연결 확인 %TEMP% & a.txt");
        std::fs::write(&file, "기본 프로그램으로 열기 확인").unwrap();
        Opener::Default.launch(&file).unwrap();
    }
}
