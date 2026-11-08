//! Remote runs a connection may have open at once. `MaxSessions` (default 10) is shared with the
//! shell, SFTP, monitoring, Git status and pod tabs, so the workspace takes only a few (design KV.2).
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::Semaphore;

const PER_CONNECTION: usize = 3;
const WATCH_PER_CONNECTION: usize = 4;

/// Entries are weak, so a connection that is gone needs no cleanup call.
pub struct Slots {
    per_connection: usize,
    open: Mutex<HashMap<String, Weak<Semaphore>>>,
}

impl Default for Slots {
    fn default() -> Self {
        Self::with_limit(PER_CONNECTION)
    }
}

/// Metric reads and pod probes (KV.9), kept apart so a slow sweep over 50 pods cannot hold up the
/// tree's polling.
pub struct WatchSlots(pub Slots);

impl Default for WatchSlots {
    fn default() -> Self {
        Self(Slots::with_limit(WATCH_PER_CONNECTION))
    }
}

impl Slots {
    fn with_limit(per_connection: usize) -> Self {
        Self {
            per_connection,
            open: Mutex::default(),
        }
    }

    pub fn for_connection(&self, id: &str) -> Arc<Semaphore> {
        let mut slots = self.open.lock().unwrap();
        slots.retain(|_, slot| slot.strong_count() > 0);
        if let Some(slot) = slots.get(id).and_then(Weak::upgrade) {
            return slot;
        }
        let slot = Arc::new(Semaphore::new(self.per_connection));
        slots.insert(id.to_string(), Arc::downgrade(&slot));
        slot
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_shares_one_limit_and_others_have_their_own() {
        let slots = Slots::default();
        let first = slots.for_connection("a");
        let again = slots.for_connection("a");
        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(first.available_permits(), PER_CONNECTION);
        assert!(!Arc::ptr_eq(&first, &slots.for_connection("b")));
    }

    #[test]
    fn a_limit_nobody_holds_is_forgotten() {
        let slots = Slots::default();
        drop(slots.for_connection("gone"));
        let _other = slots.for_connection("other");
        let kept: Vec<String> = slots.open.lock().unwrap().keys().cloned().collect();
        assert_eq!(kept, ["other"]);
    }

    #[test]
    fn the_watch_limit_is_separate_from_the_polling_limit() {
        let watch = WatchSlots::default();
        let slot = watch.0.for_connection("a");
        assert_eq!(slot.available_permits(), WATCH_PER_CONNECTION);
        let polling = Slots::default().for_connection("a");
        assert_eq!(polling.available_permits(), PER_CONNECTION);
    }
}
