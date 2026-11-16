//! In-band transfers against real `sz`, `rz`, `tsz` and `trz` (lrzsz 0.12.21, trzsz 1.1.7) on the
//! jump host of `npm run connect:fixture -- up`, through the app's own SSH terminal path.
use super::Stage;
use crate::ssh::{Connections, Event, Input};
use crate::storage::{Profile, Store};
use sha2::Digest;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use zeroize::Zeroizing;

struct Tab {
    manager: Arc<Connections>,
    id: String,
    events: mpsc::UnboundedReceiver<Event>,
    screen: String,
    notices: Vec<super::Notice>,
}

impl Tab {
    async fn open(dir: &Path, password: &str) -> Self {
        let store = Arc::new(Store::open(&dir.join("s.sqlite3")).unwrap());
        let mut profile = Profile::imported("jump", "127.0.0.1", "probe", 42222);
        profile.id.clear();
        let profile = store.save(profile, None).unwrap();
        let manager = Arc::new(Connections::default());
        let (tx, events) = mpsc::unbounded_channel();
        let id = uuid::Uuid::new_v4().to_string();
        let sink: crate::ssh::Sink = Arc::new(move |e| {
            let _ = tx.send(e);
            Ok(())
        });
        let secret = Zeroizing::new(password.to_string());
        let known = vec![dir.join("known_hosts")];
        manager
            .start(id.clone(), profile, secret, known, sink, store)
            .unwrap();
        Tab {
            manager,
            id,
            events,
            screen: String::new(),
            notices: Vec::new(),
        }
    }

    /// Draws one event: ACKs output, trusts the fixture's new host key, keeps transfer notices.
    async fn step(&mut self) {
        let event = tokio::time::timeout(Duration::from_secs(60), self.events.recv())
            .await
            .unwrap_or_else(|_| {
                let tail: String = self.screen.chars().rev().take(300).collect();
                let tail: String = tail.chars().rev().collect();
                panic!("nothing happened: {:?} / {tail:?}", self.notices.last())
            })
            .expect("connection ended");
        let control = self.manager.control(&self.id).ok();
        match event {
            Event::Data { seq, bytes } => {
                self.screen.push_str(&String::from_utf8_lossy(&bytes));
                if let Some(c) = control {
                    let _ = c.ack.send(seq);
                }
            }
            Event::HostKey { challenge, .. } => {
                let c = control.unwrap();
                assert_eq!(c.trust_request.lock().unwrap().take(), Some(challenge));
                c.trust.send(Some(true)).unwrap();
            }
            Event::Inband(notice) => self.notices.push(notice),
            Event::State { status, message } if status == "error" || status == "closed" => {
                panic!("{status}: {message}")
            }
            _ => {}
        }
    }

    async fn wait(&mut self, from: usize, text: &str) -> usize {
        loop {
            if let Some(at) = self.screen[from..].find(text) {
                return from + at + text.len();
            }
            self.step().await;
        }
    }

    async fn send(&self, text: &str) {
        let control = self.manager.control(&self.id).unwrap();
        control
            .input
            .send(Input::Data(text.as_bytes().to_vec()))
            .await
            .unwrap();
    }

    /// Answers the transfer the command started, as the tab's buttons would, and waits.
    async fn transfer(&mut self, folder: Option<&Path>, files: Vec<PathBuf>) -> String {
        let start = self.notices.len();
        let mut answered = false;
        loop {
            if let Some(last) = self.notices[start..].last().cloned() {
                match last.stage {
                    Stage::Ask if !answered => {
                        let folder = folder.map(Path::to_path_buf);
                        let transfers = &self.manager.inband;
                        transfers
                            .answer_with(&self.id, &last.request, folder, files.clone())
                            .unwrap();
                        answered = true;
                    }
                    Stage::Done => return last.message.unwrap_or_default(),
                    Stage::Failed => panic!("transfer failed: {:?}", last.message),
                    _ => {}
                }
            }
            self.step().await;
        }
    }
}

fn sha256(path: &Path) -> String {
    let digest = sha2::Sha256::digest(std::fs::read(path).unwrap());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The 64-digit checksum on the screen before `at`.
fn checksum(screen: &str) -> String {
    screen
        .split_whitespace()
        .rev()
        .find(|t| t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()))
        .expect("checksum")
        .to_string()
}

#[tokio::test]
#[ignore = "needs npm run connect:fixture -- up"]
async fn moves_files_with_sz_rz_tsz_and_trz_over_ssh() {
    let secrets = std::env::temp_dir().join("dachsterm-connect-fixture");
    let password = Zeroizing::new(
        std::fs::read_to_string(secrets.join("user.password"))
            .unwrap()
            .trim()
            .to_string(),
    );
    let dir = tempfile::tempdir().unwrap();
    let mut tab = Tab::open(dir.path(), &password).await;
    let at = tab.wait(0, "$ ").await;
    tab.send("cd $(mktemp -d) && head -c 65536 /dev/urandom > d.bin && sha256sum d.bin\r")
        .await;
    let checked = tab.wait(at, "  d.bin\r\n").await;
    let remote = checksum(&tab.screen[..checked]);
    tab.wait(checked, "$ ").await;
    for (n, command) in ["sz d.bin", "tsz d.bin"].into_iter().enumerate() {
        let folder = dir.path().join(format!("in{n}"));
        std::fs::create_dir(&folder).unwrap();
        tab.send(&format!("{command}\r")).await;
        let message = tab.transfer(Some(&folder), vec![]).await;
        assert!(message.contains("d.bin"), "{command}: {message}");
        assert_eq!(sha256(&folder.join("d.bin")), remote, "{command}");
        // The prompt after the program ended, not the one before it started.
        let ended = tab.screen.len();
        let at = tab.wait(ended, "$ ").await;
        assert!(
            !tab.screen[ended..at].contains("OO"),
            "{command} left its OO on the screen"
        );
    }
    let up = dir.path().join("u.bin");
    // Every byte value, so the escapes are exercised.
    let bytes: Vec<u8> = (0..50_000u32)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect();
    std::fs::write(&up, bytes).unwrap();
    let local = sha256(&up);
    for command in ["rz -y", "trz -y"] {
        tab.send(&format!("{command}\r")).await;
        let message = tab.transfer(None, vec![up.clone()]).await;
        assert!(message.contains("u.bin"), "{command}: {message}");
        let ended = tab.screen.len();
        let at = tab.wait(ended, "$ ").await;
        tab.send("sha256sum u.bin; rm u.bin\r").await;
        let at = tab.wait(at, "  u.bin\r\n").await;
        assert_eq!(checksum(&tab.screen[..at]), local, "{command}");
    }
    tab.send("exit\r").await;
}
