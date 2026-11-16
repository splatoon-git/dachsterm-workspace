//! What each kind of saved connection can do once it is open. SSH carries files and a shell,
//! FTP only files, and Telnet and serial only a terminal (CG.4, CG.5).
use crate::{ssh::Connections, storage::Result};
use std::sync::Arc;

impl Connections {
    pub fn ftp_session(&self, id: &str) -> Result<Arc<crate::ftp::Session>> {
        self.ftp
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("FTP 연결이 종료되었습니다.".into())
    }

    /// Files can be listed and moved over this connection: SFTP or FTP.
    pub fn ready(&self, id: &str) -> Result<()> {
        match self.control(id)?.profile.protocol.as_str() {
            "ssh" => self.handle(id).map(|_| ()),
            "ftp" | "ftps" => self.ftp_session(id).map(|_| ()),
            _ => Err("이 연결에는 파일 패널이 없습니다.".into()),
        }
    }

    /// The connection's terminal takes input now: SSH once its session is up, Telnet and serial
    /// once their stream is open. Session logs, snippets, multi-input and detaching check this.
    pub fn terminal_ready(&self, id: &str) -> Result<()> {
        if self.handle(id).is_ok() || self.streaming.lock().unwrap().contains(id) {
            Ok(())
        } else {
            Err("연결이 준비되지 않았습니다.".into())
        }
    }

    /// A Telnet or serial terminal is connected. `finish` forgets it.
    pub(crate) fn mark_streaming(&self, id: &str) {
        self.streaming.lock().unwrap().insert(id.to_string());
    }
}
