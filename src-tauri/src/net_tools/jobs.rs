//! Running network tool jobs, so `net_cancel` can reach one. A job's entry lasts as long as its task.
use crate::{ssh::Connections, storage::Result};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;

pub type CancelSignal = Arc<watch::Sender<bool>>;

#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, CancelSignal>>);

impl Jobs {
    pub fn begin(
        &self,
        connections: &Arc<Connections>,
        id: String,
    ) -> Result<(CancelSignal, JobGuard)> {
        let mut jobs = self.0.lock().unwrap();
        if jobs.contains_key(&id) {
            return Err("이미 실행 중인 점검입니다.".into());
        }
        let signal = Arc::new(watch::Sender::new(false));
        jobs.insert(id.clone(), signal.clone());
        Ok((
            signal,
            JobGuard {
                connections: connections.clone(),
                id,
            },
        ))
    }
    pub fn cancel(&self, id: &str) {
        if let Some(signal) = self.0.lock().unwrap().get(id) {
            signal.send_replace(true);
        }
    }
}

pub struct JobGuard {
    connections: Arc<Connections>,
    id: String,
}
impl Drop for JobGuard {
    fn drop(&mut self) {
        self.connections.net.jobs.0.lock().unwrap().remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_reaches_a_running_job_and_a_finished_one_is_gone() {
        let connections = Arc::new(Connections::default());
        let jobs = &connections.net.jobs;
        let (signal, guard) = jobs.begin(&connections, "a".into()).unwrap();
        assert!(jobs.begin(&connections, "a".into()).is_err());
        jobs.cancel("a");
        assert!(*signal.borrow());
        drop(guard);
        jobs.cancel("a");
        assert!(jobs.begin(&connections, "a".into()).is_ok());
    }
}
