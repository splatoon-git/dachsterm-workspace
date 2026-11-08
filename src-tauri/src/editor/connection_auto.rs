//! "Upload automatically during this connection" (GE.1): a mode that ends with the connection.
//!
//! `upload_mode` holds `auto` in memory while it lasts and `mode_after_connection` the mode to go
//! back to. `recovery.json` always gets the original mode, so a restart cannot bring it back.

use super::{Edit, Editors, destination, persist};
use crate::{sftp, ssh::Connections, storage::Result};
use serde::Serialize;

const ENDED: &str = "연결이 바뀌어 저장할 때 다시 확인합니다.";

/// A row of `edit_list`. `connection_live` lets a reconnected tab of the same session take over
/// the question, since the edit keeps the ID of the connection that has ended.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    #[serde(flatten)]
    edit: Edit,
    connection_live: bool,
}

impl Edit {
    /// What `recovery.json` stores.
    pub(super) fn durable(&self) -> Edit {
        let mut edit = self.clone();
        edit.end_connection_auto();
        edit
    }
    fn end_connection_auto(&mut self) {
        if let Some(mode) = self.mode_after_connection.take() {
            self.upload_mode = mode;
        }
    }
    fn start_connection_auto(&mut self) {
        if self.mode_after_connection.is_none() {
            let mode = std::mem::replace(&mut self.upload_mode, "auto".into());
            self.mode_after_connection = Some(mode);
        }
        // The watcher finds the saved revision on its next pass and uploads it.
        if self.status == "pending" {
            self.status = "watching".into();
        }
        if self.status == "watching" {
            self.message = "이 연결 동안 저장하면 자동으로 업로드합니다.".into();
        }
    }
    /// A reconnect has a new ID, so moving to another connection ends the connection-only mode.
    fn move_to(&mut self, connection: &str) {
        if self.connection_id != connection {
            self.end_connection_auto();
            self.connection_id = connection.into();
        }
    }
}

impl Editors {
    pub fn listed(&self, connections: &Connections) -> Vec<Listed> {
        self.list()
            .into_iter()
            .map(|edit| Listed {
                connection_live: connections.handle(&edit.connection_id).is_ok(),
                edit,
            })
            .collect()
    }
    /// Checks that `connection` reaches the server the edit started on, then moves it there.
    /// The caller holds `busy`.
    fn bind(
        &self,
        connections: &Connections,
        id: &str,
        connection: &str,
        profile: &str,
    ) -> Result<()> {
        let actual = connections.control(connection)?.profile.clone();
        let mut entries = self.entries.lock().unwrap();
        let edit = entries.get_mut(id).ok_or("편집 작업 없음")?;
        if edit.profile_id != profile
            || actual.id != profile
            || edit.destination != destination(&actual)
        {
            return Err("편집을 시작한 서버 세션으로 연결하세요.".into());
        }
        edit.move_to(connection);
        Ok(())
    }
    pub async fn rebind(
        &self,
        connections: &Connections,
        id: &str,
        connection: &str,
        profile: &str,
    ) -> Result<()> {
        let _guard = self.busy.lock().await;
        self.bind(connections, id, connection, profile)
    }
    pub async fn connection_auto(
        &self,
        connections: &Connections,
        id: &str,
        connection: &str,
        profile: &str,
    ) -> Result<()> {
        let _guard = self.busy.lock().await;
        self.bind(connections, id, connection, profile)?;
        let edit = {
            let mut entries = self.entries.lock().unwrap();
            let edit = entries.get_mut(id).ok_or("편집 작업 없음")?;
            edit.start_connection_auto();
            edit.clone()
        };
        tauri::async_runtime::spawn_blocking(move || persist(&edit))
            .await
            .map_err(sftp::failure)?
    }
    /// Runs on every watcher pass, so a mode cannot outlive its connection by more than one pass.
    /// Nothing is written: the file on disk already has the original mode.
    pub(super) async fn expire_connection_auto(&self, connections: &Connections) {
        let any = self
            .entries
            .lock()
            .unwrap()
            .values()
            .any(|edit| edit.mode_after_connection.is_some());
        if any {
            let _guard = self.busy.lock().await;
            self.end_on_ended(|id| connections.handle(id).is_ok());
        }
    }
    fn end_on_ended(&self, live: impl Fn(&str) -> bool) {
        for edit in self.entries.lock().unwrap().values_mut() {
            if edit.mode_after_connection.is_some() && !live(&edit.connection_id) {
                edit.end_connection_auto();
                if edit.status == "watching" {
                    edit.message = ENDED.into();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn edit(status: &str) -> Edit {
        Edit {
            id: "e1".into(),
            connection_id: "c1".into(),
            profile_id: "p1".into(),
            destination: "d".into(),
            encoding: "original".into(),
            upload_mode: "ask".into(),
            remote: "/a.txt".into(),
            local: PathBuf::from("/nowhere/working.txt"),
            baseline: "b".into(),
            uploaded: "u".into(),
            status: status.into(),
            message: "m".into(),
            mode_after_connection: None,
        }
    }

    #[test]
    fn starting_it_uploads_the_waiting_revision_and_keeps_the_first_mode() {
        let mut e = edit("pending");
        e.start_connection_auto();
        assert_eq!(e.upload_mode, "auto");
        assert_eq!(e.status, "watching");
        e.start_connection_auto();
        assert_eq!(e.mode_after_connection.as_deref(), Some("ask"));
    }

    #[test]
    fn the_saved_form_has_the_original_mode_and_loads_as_a_recovery_file() {
        let mut e = edit("watching");
        e.start_connection_auto();
        let data = serde_json::to_vec(&e.durable()).unwrap();
        let text = String::from_utf8_lossy(&data);
        assert!(!text.contains("modeAfterConnection"), "{text}");
        let loaded: Edit = serde_json::from_slice(&data).unwrap();
        assert_eq!(loaded.upload_mode, "ask");
        assert_eq!(loaded.mode_after_connection, None);
    }

    #[test]
    fn a_recovery_file_from_before_this_field_still_loads() {
        let mut value = serde_json::to_value(edit("watching")).unwrap();
        value.as_object_mut().unwrap().remove("modeAfterConnection");
        let loaded: Edit = serde_json::from_value(value).unwrap();
        assert_eq!(loaded.mode_after_connection, None);
    }

    #[test]
    fn moving_to_another_connection_ends_it_and_staying_does_not() {
        let mut e = edit("watching");
        e.start_connection_auto();
        e.move_to("c1");
        assert_eq!(e.upload_mode, "auto");
        e.move_to("c2");
        assert_eq!(e.upload_mode, "ask");
        assert_eq!(e.mode_after_connection, None);
        assert_eq!(e.connection_id, "c2");
    }

    #[test]
    fn it_ends_with_its_connection_only() {
        let editors = Editors::default();
        let mut gone = edit("watching");
        gone.start_connection_auto();
        let mut live = edit("watching");
        live.id = "e2".into();
        live.connection_id = "c2".into();
        live.start_connection_auto();
        let live_message = live.message.clone();
        {
            let mut entries = editors.entries.lock().unwrap();
            entries.insert(gone.id.clone(), gone);
            entries.insert(live.id.clone(), live);
        }
        editors.end_on_ended(|id| id == "c2");
        let entries = editors.entries.lock().unwrap();
        assert_eq!(entries["e1"].upload_mode, "ask");
        assert_eq!(entries["e1"].message, ENDED);
        assert_eq!(entries["e2"].upload_mode, "auto");
        assert_eq!(entries["e2"].message, live_message);
    }

    #[tokio::test]
    async fn choosing_a_mode_replaces_the_connection_only_one() {
        let dir = std::env::temp_dir().join(format!("dachsterm-edit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut e = edit("pending");
        e.local = dir.join("working.txt");
        e.start_connection_auto();
        let editors = Editors::default();
        editors.entries.lock().unwrap().insert(e.id.clone(), e);
        editors.set_mode("e1", "manual").await.unwrap();
        {
            let entries = editors.entries.lock().unwrap();
            assert_eq!(entries["e1"].upload_mode, "manual");
            assert_eq!(entries["e1"].mode_after_connection, None);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
