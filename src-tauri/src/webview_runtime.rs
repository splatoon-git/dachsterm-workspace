//! The oldest WebView2 Runtime the page is built for. The runtime is updated apart from Windows,
//! so a PC that cannot reach the update service keeps the one its Windows image came with. There
//! the styles and scripts the page relies on are dropped without an error. The app still starts
//! and says at startup why the screen may look wrong.
//!
//! Windows only: macOS draws with the system's WKWebView, whose age the bundle's minimum macOS
//! version already bounds.

/// The page's build target (Vite's default, Chromium 111) and the newest style it needs
/// (`color-mix`). Raise it together with either.
const MINIMUM: u32 = 111;

/// The runtime's major version, when it is older than the page needs.
fn outdated(version: &str) -> Option<u32> {
    let major = version.split('.').next()?.trim().parse().ok()?;
    (major < MINIMUM).then_some(major)
}

/// Tells the user without holding up startup. The thread ends when the message is closed.
pub fn warn_if_outdated() {
    let Some(major) = tauri::webview_version().ok().as_deref().and_then(outdated) else {
        return;
    };
    std::thread::spawn(move || {
        rfd::MessageDialog::new()
            .set_title("WebView2 런타임 업데이트 필요")
            .set_description(format!(
                "이 PC의 Microsoft Edge WebView2 런타임은 {major} 버전입니다. DachsTerm은 {MINIMUM} 이상에 맞춰 만들어져, 지금 버전에서는 화면 배치나 일부 기능이 어긋날 수 있습니다.\n\nWindows 업데이트를 하거나 Microsoft의 WebView2 런타임 설치 프로그램으로 업데이트한 뒤 다시 실행하세요. 인터넷이 없는 PC는 다른 PC에서 받은 오프라인 설치 프로그램(Evergreen Standalone Installer)을 쓸 수 있습니다."
            ))
            .set_level(rfd::MessageLevel::Warning)
            .show();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_runtime_older_than_the_build_target_is_reported() {
        assert_eq!(outdated("100.0.1185.36"), Some(100));
        assert_eq!(outdated("110.0.1587.69"), Some(110));
        assert_eq!(outdated("111.0.1661.41"), None);
        assert_eq!(outdated("157.0.4341.60"), None);
        // An unreadable version is not reported: the warning must not appear by mistake.
        assert_eq!(outdated(""), None);
        assert_eq!(outdated("canary"), None);
    }
}
