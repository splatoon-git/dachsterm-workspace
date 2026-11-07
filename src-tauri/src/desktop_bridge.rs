//! Desktop actions the terminal needs. The web clipboard depends on user activation and differs
//! between WebView2 and WKWebView, and a webview has no way to open the system browser, so these
//! go through checked Rust commands instead of opening plugin permissions to the webview.
use crate::storage::Result;
use std::error::Error;

const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;
const MAX_URL_BYTES: usize = 2048;
const MAX_NOTIFICATION_TITLE_BYTES: usize = 512;
const MAX_NOTIFICATION_BODY_BYTES: usize = 1024;

/// Only plain web links. Rejects `file:`, UNC paths and links that hide a host behind user info.
fn check_url(url: &str) -> Result<()> {
    let invalid = || "이 링크는 열 수 없습니다.".to_string();
    if url.len() > MAX_URL_BYTES || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(invalid());
    }
    let (scheme, rest) = url.split_once("://").ok_or_else(invalid)?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(invalid());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains(['@', '\\']) {
        return Err(invalid());
    }
    Ok(())
}

#[tauri::command]
pub async fn clipboard_write_text(text: String) -> Result<()> {
    if text.len() > MAX_CLIPBOARD_BYTES {
        return Err("복사할 내용이 1MiB를 넘습니다.".into());
    }
    // Callers are user copies and OSC 52, which is limited to the focused pane in integrations.ts.
    tauri::async_runtime::spawn_blocking(move || {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(text))
            .map_err(|_| "클립보드에 복사하지 못했습니다. 다시 시도하세요.".to_string())
    })
    .await
    .map_err(|error| {
        error
            .source()
            .map_or(error.to_string(), ToString::to_string)
    })?
}

#[tauri::command]
pub async fn url_open(url: String) -> Result<()> {
    check_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        open::that_detached(&url).map_err(|_| "브라우저를 열지 못했습니다.".to_string())
    })
    .await
    .map_err(|error| {
        error
            .source()
            .map_or(error.to_string(), ToString::to_string)
    })?
}

/// Both values are shortened in the frontend. These limits are for a call that skipped it.
fn check_notification(title: &str, body: &str) -> Result<()> {
    if title.is_empty()
        || title.len() > MAX_NOTIFICATION_TITLE_BYTES
        || body.len() > MAX_NOTIFICATION_BODY_BYTES
    {
        return Err("알림 내용이 올바르지 않습니다.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn notification_show(app: tauri::AppHandle, title: String, body: String) -> Result<()> {
    use tauri_plugin_notification::NotificationExt;
    check_notification(&title, &body)?;
    tauri::async_runtime::spawn_blocking(move || {
        let builder = app.notification().builder().title(title);
        let builder = if body.is_empty() {
            builder
        } else {
            builder.body(body)
        };
        builder
            .show()
            .map_err(|_| "OS 알림을 표시하지 못했습니다. OS 알림 설정을 확인하세요.".to_string())
    })
    .await
    .map_err(|error| {
        error
            .source()
            .map_or(error.to_string(), ToString::to_string)
    })?
}

#[cfg(test)]
mod tests {
    use super::{check_notification, check_url};

    #[test]
    fn bounds_notification_text() {
        assert!(check_notification("prod — 완료", "").is_ok());
        assert!(check_notification("", "body").is_err());
        assert!(check_notification(&"t".repeat(513), "").is_err());
        assert!(check_notification("t", &"b".repeat(1025)).is_err());
    }

    #[test]
    fn opens_only_plain_web_links() {
        for good in [
            "https://claude.ai/oauth/authorize?code=true&state=abc",
            "http://localhost:3000/",
            "HTTPS://example.com",
            "https://[::1]:8080/a",
            "https://example.com/a@b",
        ] {
            assert!(check_url(good).is_ok(), "{good}");
        }
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ms-settings://x",
            "https://",
            "https://user:pw@example.com/",
            "https://example.com@evil.example/",
            "https://a\\b/",
            "https://example.com/a b",
            "https://example.com/\u{7}",
            "\\\\server\\share",
            "example.com",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        assert!(check_url(&format!("https://example.com/{}", "a".repeat(2048))).is_err());
    }
}
