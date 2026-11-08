//! The russh callbacks of one SSH connection, moved out of `ssh.rs` so it can shrink.
use super::{Connections, Sink};
use crate::storage::Profile;
use russh::{ChannelId, ChannelOpenFailure, client, keys::PublicKeyOrCertificate};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;

pub struct Host {
    pub(super) id: String,
    pub(super) profile: Profile,
    pub(super) paths: Vec<PathBuf>,
    pub(super) sink: Sink,
    pub(super) trust: watch::Receiver<Option<bool>>,
    pub(super) trust_request: Arc<Mutex<Option<String>>>,
    pub(super) manager: Arc<Connections>,
    pub(super) failure: Arc<Mutex<Option<String>>>,
    pub(super) waiting: watch::Sender<bool>,
    pub(super) stop: watch::Receiver<bool>,
    pub(super) forward_agent: bool,
}
impl client::Handler for Host {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(self.verify(key).await.unwrap_or_else(|message| {
            *self.failure.lock().unwrap() = Some(message);
            false
        }))
    }
    /// The only place the server's description of a failed channel can be read (TL.0).
    async fn channel_open_failure(
        &mut self,
        _: ChannelId,
        reason: ChannelOpenFailure,
        description: &str,
        _: &str,
        _: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        self.manager
            .net
            .channel_failure(&self.id, &reason, description);
        Ok(())
    }
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let route = self
            .manager
            .forwards
            .lock()
            .unwrap()
            .get(&(self.id.clone(), port as u16))
            .cloned();
        if let Some(route) = route
            && route.try_send(channel).is_ok()
        {
            reply.accept().await;
        }
        Ok(())
    }
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        crate::agent_forward::open(self.forward_agent, &self.manager, &self.id, channel, reply);
        Ok(())
    }
    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        channel: russh::Channel<client::Msg>,
        path: &str,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        crate::git_credential::open(&self.manager, &self.id, path, channel, reply);
        Ok(())
    }
}
