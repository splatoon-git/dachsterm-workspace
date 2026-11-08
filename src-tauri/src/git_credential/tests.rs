use super::approval::*;
use super::*;
use std::sync::Mutex as StdMutex;
use std::time::Instant;
use tokio::sync::oneshot;

fn recorder() -> (Arc<Broker>, Arc<StdMutex<Vec<CredentialRequest>>>) {
    let seen = Arc::new(StdMutex::new(Vec::new()));
    let sink = seen.clone();
    let broker = Broker::new(Arc::new(move |event| {
        if let Event::GitCredential(request) = event {
            sink.lock().unwrap().push(request);
        }
        Ok(())
    }));
    (Arc::new(broker), seen)
}
fn ask(host: &str, username: Option<&str>) -> protocol::Request {
    protocol::Request {
        protocol: "https".into(),
        host: host.into(),
        path: None,
        username: username.map(Into::into),
    }
}
fn value(user: &str) -> Credential {
    Credential {
        username: Zeroizing::new(user.into()),
        password: Zeroizing::new(format!("token-of-{user}")),
    }
}
fn forward() -> Arc<Forward> {
    Arc::new(Forward::new(
        "/tmp/dachsterm-git-0a".into(),
        vec!["store".into()],
    ))
}
async fn pending(forward: &Forward, count: usize) -> Vec<String> {
    loop {
        let ids: Vec<String> = forward.pending.lock().unwrap().keys().cloned().collect();
        if ids.len() >= count {
            return ids;
        }
        tokio::task::yield_now().await;
    }
}
fn asking(
    forward: &Arc<Forward>,
    broker: &Arc<Broker>,
    request: protocol::Request,
) -> tokio::task::JoinHandle<Option<String>> {
    let (forward, broker) = (forward.clone(), broker.clone());
    tokio::spawn(async move {
        forward
            .credential(&broker, "s", request)
            .await
            .map(|c| c.username.to_string())
    })
}

#[tokio::test]
async fn every_request_waits_for_the_card() {
    let forward = forward();
    let (broker, seen) = recorder();
    let task = asking(&forward, &broker, ask("git.test", None));
    let id = pending(&forward, 1).await.remove(0);
    let shown = seen.lock().unwrap()[0].clone();
    assert_eq!((shown.host.as_str(), shown.seconds), ("git.test", 60));
    assert_eq!(shown.server_helpers, ["store"], "the card warns about it");
    forward.send(&id, Answer::Deny).unwrap();
    assert_eq!(task.await.unwrap(), None);
    assert!(forward.send(&id, Answer::Deny).is_err(), "answered once");

    let task = asking(&forward, &broker, ask("git.test", None));
    let id = pending(&forward, 1).await.remove(0);
    forward
        .send(&id, Answer::Allow(Decision::Once, value("me")))
        .unwrap();
    assert_eq!(task.await.unwrap().as_deref(), Some("me"));
    // The rest of the same push gets the same value without a card.
    let again = asking(&forward, &broker, ask("git.test", Some("me")));
    assert_eq!(again.await.unwrap().as_deref(), Some("me"));
    assert_eq!(seen.lock().unwrap().len(), 2);
    let other_user = asking(&forward, &broker, ask("git.test", Some("you")));
    pending(&forward, 1).await;
    assert_eq!(seen.lock().unwrap().len(), 3, "another user is asked");
    forward.forget();
    assert_eq!(other_user.await.unwrap(), None, "forgetting refuses");
}

/// A request whose deadline is `after` from now, waited on as `approve` does.
fn waiting(
    forward: &Arc<Forward>,
    after: Duration,
) -> (String, tokio::task::JoinHandle<Option<String>>) {
    let (sender, mut receiver) = oneshot::channel();
    let id = uuid::Uuid::new_v4().to_string();
    forward.pending.lock().unwrap().insert(
        id.clone(),
        Pending {
            sender,
            ask: ask("git.test", None),
            deadline: Instant::now() + after,
            fetching: false,
        },
    );
    let (forward, waited) = (forward.clone(), id.clone());
    let task = tokio::spawn(async move {
        match forward.wait(&waited, &mut receiver).await {
            Some(Answer::Allow(_, found)) => Some(found.username.to_string()),
            _ => None,
        }
    });
    (id, task)
}

#[tokio::test]
async fn silence_refuses_and_the_card_can_extend_its_time() {
    let forward = forward();
    let (_, task) = waiting(&forward, Duration::from_millis(100));
    assert_eq!(task.await.unwrap(), None, "the time ran out");

    let (id, task) = waiting(&forward, Duration::from_millis(200));
    assert_eq!(forward.begin_fetch(&id).unwrap(), ask("git.test", None));
    assert!(forward.begin_fetch(&id).is_err(), "one fetch at a time");
    tokio::time::sleep(Duration::from_millis(400)).await;
    forward.end_fetch(&id);
    forward.extend(&id, Duration::from_millis(200)).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    forward.extend(&id, INPUT_TIME).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    forward
        .send(&id, Answer::Allow(Decision::Once, value("typed")))
        .unwrap();
    assert_eq!(task.await.unwrap().as_deref(), Some("typed"));
}

#[tokio::test]
async fn one_card_per_host_and_ten_minutes_for_the_connection() {
    let forward = forward();
    let (broker, seen) = recorder();
    let first = asking(&forward, &broker, ask("git.test", None));
    let id = pending(&forward, 1).await.remove(0);
    let second = asking(&forward, &broker, ask("GIT.test", None));
    let elsewhere = asking(&forward, &broker, ask("other.test", None));
    let ids = pending(&forward, 2).await;
    assert_eq!(
        seen.lock().unwrap().len(),
        2,
        "the same host waits behind its card"
    );
    let other = ids.into_iter().find(|i| *i != id).unwrap();
    forward.send(&other, Answer::Deny).unwrap();
    assert_eq!(elsewhere.await.unwrap(), None);
    forward
        .send(&id, Answer::Allow(Decision::Connection, value("me")))
        .unwrap();
    assert_eq!(first.await.unwrap().as_deref(), Some("me"));
    assert_eq!(second.await.unwrap().as_deref(), Some("me"));
    let until = forward.allowed.lock().unwrap()[0].until;
    let left = until - Instant::now();
    assert!(left > ALLOW_FOR - Duration::from_secs(5) && left <= ALLOW_FOR);
    let later = asking(&forward, &broker, ask("git.test", None));
    assert_eq!(later.await.unwrap().as_deref(), Some("me"));
    assert_eq!(seen.lock().unwrap().len(), 2);
    forward.allowed.lock().unwrap()[0].until = Instant::now();
    let expired = asking(&forward, &broker, ask("git.test", None));
    pending(&forward, 1).await;
    assert_eq!(seen.lock().unwrap().len(), 3, "the allowance ended");
    forward.forget();
    assert_eq!(expired.await.unwrap(), None);
}

#[test]
fn allow_once_is_kept_for_thirty_seconds() {
    let forward = forward();
    forward.allow(Decision::Once, "git.test", &value("me"));
    let left = forward.allowed.lock().unwrap()[0].until - Instant::now();
    assert!(left > ONCE_REUSE - Duration::from_secs(5) && left <= ONCE_REUSE);
}

#[test]
fn repeated_requests_are_cut_off_for_a_minute() {
    let forward = forward();
    for _ in 0..BURST {
        assert!(!forward.flooding("git.test"));
    }
    assert!(
        forward.flooding("Git.Test"),
        "one more than the limit in ten seconds"
    );
    assert!(!forward.flooding("other.test"));
    assert!(forward.flooding("git.test"), "still blocked");
    let until = forward.blocked.lock().unwrap()["git.test"];
    assert!(until - Instant::now() > BURST_BLOCK - Duration::from_secs(5));
    forward
        .blocked
        .lock()
        .unwrap()
        .insert("git.test".into(), Instant::now());
    assert!(!forward.flooding("git.test"), "the block ended");
    // Requests spread over more than ten seconds are not a burst.
    let old = Instant::now() - BURST_WINDOW;
    forward
        .recent
        .lock()
        .unwrap()
        .insert("slow.test".into(), vec![old; BURST]);
    assert!(!forward.flooding("slow.test"));
}

#[test]
fn only_the_own_path_and_four_channels() {
    let forward = forward();
    assert!(forward.serves("/tmp/dachsterm-git-0a"));
    assert!(!forward.serves("/tmp/dachsterm-git-0b"));
    assert!(!forward.serves("/run/user/0/x"));
    let slots: Vec<_> = (0..MAX_CHANNELS + 1)
        .filter_map(|_| Slot::take(&forward))
        .collect();
    assert_eq!(slots.len(), MAX_CHANNELS);
    drop(slots);
    assert!(Slot::take(&forward).is_some());
    *forward.path.lock().unwrap() = None;
    assert!(!forward.serves("/tmp/dachsterm-git-0a"), "after finishing");
}

#[test]
fn a_stopped_connection_forgets_its_forward() {
    let manager = Arc::new(Connections::default());
    let forward = forward();
    manager
        .git
        .0
        .lock()
        .unwrap()
        .insert("c".into(), forward.clone());
    forward.allow(Decision::Connection, "git.test", &value("me"));
    drop(Started {
        manager: manager.clone(),
        id: "c".into(),
        path: String::new(),
    });
    assert!(manager.git.get("c").is_none());
    assert!(forward.allowed_for(&ask("git.test", None)).is_none());
}

#[test]
fn the_socket_goes_where_only_the_user_reaches() {
    let private = b"D /run/user/1000\nM drwx------ 2 probe probe 40 Nov 8 /run/user/1000\n";
    assert_eq!(located(private).0, "/run/user/1000");
    assert_eq!(
        located(b"D /run/user/1000/\nM drwx------. 2 p p 40\n").0,
        "/run/user/1000"
    );
    for refused in [
        &b"D /run/user/1000\nM drwx------+ 2 p p 40\n"[..],
        b"D /run/user/1000\nM drwxr-x--- 2 p p 40\n",
        b"D /run/user/1000\n",
        b"D /run/a b\nM drwx------ 2 p p 40\n",
        b"",
    ] {
        assert_eq!(
            located(refused).0,
            "/tmp",
            "{}",
            String::from_utf8_lossy(refused)
        );
    }
    let long = format!("D /{}\nM drwx------\n", "a".repeat(60));
    assert_eq!(
        located(long.as_bytes()).0,
        "/tmp",
        "the socket path would not fit"
    );
    let (_, helpers) = located(b"H store\nH \nH cache --timeout=3600\nH \x1b[2Jx\n");
    assert_eq!(helpers, ["store", "cache --timeout=3600", "[2Jx"]);
    assert_eq!(random_name().unwrap().len(), 32);
    assert_ne!(random_name(), random_name());
}

#[test]
fn credential_requests_are_not_replayed_to_a_new_window() {
    let (broker, _) = recorder();
    broker
        .send(Event::State {
            status: "connected".into(),
            message: String::new(),
        })
        .unwrap();
    broker
        .send(Event::GitCredential(CredentialRequest {
            request: "r".into(),
            session: "s".into(),
            host: "h".into(),
            path: None,
            username: None,
            server_helpers: vec![],
            seconds: 60,
        }))
        .unwrap();
    let replayed = Arc::new(StdMutex::new(Vec::new()));
    let sink = replayed.clone();
    broker
        .attach(
            "terminal-x".into(),
            Arc::new(move |event| {
                sink.lock()
                    .unwrap()
                    .push(matches!(event, Event::GitCredential(_)));
                Ok(())
            }),
        )
        .unwrap();
    assert!(!replayed.lock().unwrap().iter().any(|request| *request));
}
