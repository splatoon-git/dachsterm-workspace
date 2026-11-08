#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // git in a WSL tab runs the app as its credential helper (DX.14): no window, no instance lock.
    if let Some(code) = dachsterm::credential_helper::from_args(std::env::args_os()) {
        std::process::exit(code);
    }
    dachsterm::run();
}
