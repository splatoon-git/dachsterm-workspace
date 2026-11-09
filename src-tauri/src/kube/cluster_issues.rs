//! The three kinds only the problem list reads (KV.7). Each is its own `kube_snapshot` kind so that
//! an account refused one of them still sees the other two.
use super::snapshot::{count, decode, fields, text};
use serde::Serialize;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pvc {
    namespace: String,
    name: String,
    phase: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    namespace: String,
    name: String,
    created: String,
    owner_kind: String,
    owner_name: String,
    /// The `Failed` condition is true: the Job has given up, not merely lost a pod and retried.
    failed: bool,
    failed_at: String,
    reason: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hpa {
    namespace: String,
    name: String,
    target_kind: String,
    target_name: String,
    max: u32,
    current: u32,
}

pub fn pvc(line: &str) -> Option<Pvc> {
    let [namespace, name, phase] = fields::<3>(line)?;
    Some(Pvc {
        namespace: text(namespace),
        name: text(name),
        phase: text(phase),
    })
}

pub fn job(line: &str) -> Option<Job> {
    let [namespace, name, created, owners, failure] = fields::<5>(line)?;
    let (owner_kind, owner_name) = owners
        .split(',')
        .next()
        .and_then(|owner| owner.split_once('/'))
        .unwrap_or_default();
    let (failed_at, reason) = failure.split_once(';').unwrap_or_default();
    Some(Job {
        namespace: text(namespace),
        name: text(name),
        created: text(created),
        owner_kind: text(owner_kind),
        owner_name: text(owner_name),
        failed: !failure.is_empty(),
        failed_at: text(failed_at),
        reason: text(&decode(reason)),
    })
}

pub fn hpa(line: &str) -> Option<Hpa> {
    let [namespace, name, target_kind, target_name, max, current] = fields::<6>(line)?;
    Some(Hpa {
        namespace: text(namespace),
        name: text(name),
        target_kind: text(target_kind),
        target_name: text(target_name),
        max: count(max)?,
        current: count(current)?,
    })
}

#[cfg(test)]
mod tests;
