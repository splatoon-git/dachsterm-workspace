//! Remote runs a connection may have open at once. `MaxSessions` (default 10) is shared with the
//! shell, SFTP, monitoring, Git status and pod tabs, so the workspace takes only a few (design KV.2).
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::Semaphore;

const PER_CONNECTION: usize = 3;

/// Entries are weak, so a connection that is gone needs no cleanup call.
#[derive(Default)]
pub struct Slots(Mutex<HashMap<String, Weak<Semaphore>>>);

impl Slots {
    pub fn for_connection(&self, id: &str) -> Arc<Semaphore> {
        let mut slots = self.0.lock().unwrap();
        slots.retain(|_, slot| slot.strong_count() > 0);
        if let Some(slot) = slots.get(id).and_then(Weak::upgrade) {
            return slot;
        }
        let slot = Arc::new(Semaphore::new(PER_CONNECTION));
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
        let kept: Vec<String> = slots.0.lock().unwrap().keys().cloned().collect();
        assert_eq!(kept, ["other"]);
    }
}
