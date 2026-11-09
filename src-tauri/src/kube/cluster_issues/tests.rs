use super::*;

// Recorded from `kubectl get` with the templates on a kind cluster (2026-11-09).
const PENDING_PVC: &str = "kv7\tstuck-claim\tPending";
const FAILED_JOB: &str =
    "kv7\tbroken-job\t2026-11-09T03:49:43Z\t\t2026-11-09T03:49:51Z;BackoffLimitExceeded";
const FAILED_CRON_RUN: &str = "kv7\tnightly-1\t2026-11-09T03:49:43Z\tCronJob/nightly,\t2026-11-09T03:49:52Z;BackoffLimitExceeded";
const HPA_AT_MAX: &str = "kv7\tapi\tDeployment\tapi\t1\t1";

#[test]
fn a_claim_keeps_its_phase() {
    let claim = pvc(PENDING_PVC).unwrap();
    assert_eq!(claim.namespace, "kv7");
    assert_eq!(claim.name, "stuck-claim");
    assert_eq!(claim.phase, "Pending");
}

#[test]
fn a_claim_without_a_phase_yet_has_an_empty_one() {
    assert_eq!(pvc("a\tb\t<no value>").unwrap().phase, "");
}

#[test]
fn a_job_on_its_own_that_failed_has_no_owner() {
    let failed = job(FAILED_JOB).unwrap();
    assert!(failed.failed);
    assert_eq!(failed.failed_at, "2026-11-09T03:49:51Z");
    assert_eq!(failed.reason, "BackoffLimitExceeded");
    assert_eq!(failed.owner_kind, "");
    assert_eq!(failed.owner_name, "");
}

#[test]
fn a_cron_run_names_its_owner() {
    let run = job(FAILED_CRON_RUN).unwrap();
    assert_eq!(run.owner_kind, "CronJob");
    assert_eq!(run.owner_name, "nightly");
}

#[test]
fn a_job_still_running_has_not_failed() {
    let running = job("a\tb\t2026-11-09T03:49:43Z\t\t").unwrap();
    assert!(!running.failed);
    assert_eq!(running.failed_at, "");
    assert_eq!(running.reason, "");
}

#[test]
fn a_failure_reason_is_decoded_and_cleaned() {
    let failed = job("a\tb\tc\t\tt;Bad%0Areason+here").unwrap();
    assert!(failed.failed);
    assert_eq!(failed.reason, "Badreason here");
}

#[test]
fn an_hpa_reads_its_target_and_replicas() {
    let scaler = hpa(HPA_AT_MAX).unwrap();
    assert_eq!(scaler.target_kind, "Deployment");
    assert_eq!(scaler.target_name, "api");
    assert_eq!((scaler.max, scaler.current), (1, 1));
}

#[test]
fn an_hpa_that_has_not_reported_yet_counts_zero() {
    let scaler = hpa("a\tb\tDeployment\tapi\t5\t<no value>").unwrap();
    assert_eq!((scaler.max, scaler.current), (5, 0));
}

#[test]
fn a_record_of_the_wrong_shape_is_refused() {
    assert!(pvc("a\tb").is_none());
    assert!(job("a\tb\tc").is_none());
    assert!(hpa("a\tb\tc\td\tnot-a-number\t1").is_none());
}
