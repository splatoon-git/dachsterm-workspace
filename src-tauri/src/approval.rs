//! The tab an approval card belongs to (DX.13). A request is shown in the tab it came from and
//! answered by the ID of that tab: a remote connection (its cards follow the terminal window it
//! moved to, `Broker`) or a local tab (always in the main window). Cards are never kept for a new
//! window: an unanswered one ends as a refusal.
use crate::{AppState, agent_forward::Agent, local, ssh::Event, storage::Result, windows::Broker};
use std::sync::Arc;

/// Where a tab's cards and notices go.
pub trait Notify: Send + Sync {
    fn notify(&self, event: Event) -> Result<()>;
}
impl Notify for Broker {
    fn notify(&self, event: Event) -> Result<()> {
        self.send(event)
    }
}

const ENDED: &str = "서명 요청이 이미 끝났습니다.";
/// Local tabs are not moved to another window.
const LOCAL_WINDOW: &str = "main";

pub enum Owner {
    Remote(Arc<crate::ssh::Control>),
    Local(Arc<local::Control>),
}

impl Owner {
    /// The tab `id` names, if the window `label` shows it. Connection and local tab IDs are both
    /// random UUIDs, so one ID never names both.
    pub fn find(state: &AppState, label: &str, id: &str) -> Result<Self> {
        if let Ok(control) = state.connections.control(id) {
            control.broker.check(label)?;
            return Ok(Self::Remote(control));
        }
        let control = state.locals.control(id).map_err(|_| ENDED)?;
        if label != LOCAL_WINDOW {
            return Err("다른 창이 이 터미널을 소유하고 있습니다.".into());
        }
        Ok(Self::Local(control))
    }
    pub fn agent(&self) -> Result<Arc<Agent>> {
        match self {
            Self::Remote(control) => Ok(control.agent.clone()),
            Self::Local(control) => control.agent().ok_or_else(|| ENDED.into()),
        }
    }
}
