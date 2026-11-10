//! An SSH connection that stops after login: no PTY, shell, session log, Git credentials, agent
//! forwarding or tunnel auto-start. A network tool's remote source (TL.5) holds one until it goes
//! unused; an agent chat (AC.1) holds one until its tab closes.
use crate::{
    AppState,
    ssh::{Connections, Event, Sink, route},
    storage::{Profile, Result, Store},
};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::sync::watch;
use zeroize::Zeroizing;

/// How often a held connection looks at whether it or a jump host has gone.
const HEALTH_INTERVAL: Duration = Duration::from_millis(200);

pub struct Start {
    pub connections: Arc<Connections>,
    pub id: String,
    pub profile: Profile,
    pub secret: Option<Zeroizing<String>>,
    pub hops: Vec<(Profile, Option<Zeroizing<String>>)>,
    pub paths: Vec<PathBuf>,
    pub sink: Sink,
    pub store: Arc<Store>,
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "연결 정보를 읽지 못했습니다.".to_string())?
}

/// The saved session, read off the main thread. The caller decides which protocols it accepts.
pub async fn saved_profile(app: &tauri::AppHandle, profile_id: String) -> Result<Profile> {
    let reader = app.clone();
    blocking(move || reader.state::<AppState>().store.profile(&profile_id)).await
}

/// Everything `start` needs for `profile`, with its saved secrets read off the main thread.
pub async fn request(
    app: &tauri::AppHandle,
    id: String,
    profile: Profile,
    sink: Sink,
) -> Result<Start> {
    let reader = app.clone();
    let target = profile.clone();
    let (secret, hops) = blocking(move || {
        let state = reader.state::<AppState>();
        let secret = crate::commands::saved_secret(&state, &target.id)?;
        let hops = crate::commands::hop_secrets(&state, &target)?;
        Ok((secret, hops))
    })
    .await?;
    let state = app.state::<AppState>();
    Ok(Start {
        connections: state.connections.clone(),
        id,
        profile,
        secret,
        hops,
        paths: state.known_hosts.clone(),
        sink,
        store: state.store.clone(),
    })
}

/// When an unused connection closes: after `limit` with no new value on the clock. `None` keeps it
/// until its owner stops it.
pub type Idle = Option<(watch::Receiver<Instant>, Duration)>;

/// Logs in and holds the connection. `registered` runs once the connection ID is taken, so a
/// caller can record its own state only for a start that went ahead; `ended` runs when the
/// connection is gone, however it ended.
pub fn start(
    request: Start,
    idle: Idle,
    registered: impl FnOnce(),
    ended: impl FnOnce() + Send + 'static,
) -> Result<()> {
    let Start {
        connections,
        id,
        profile,
        secret,
        hops,
        paths,
        sink,
        store,
    } = request;
    let (sink, mut channels) = connections.register(&id, &profile, &hops, sink, &store)?;
    registered();
    let mut stopped = channels.stop.clone();
    tokio::spawn(async move {
        let work = async {
            let route = route::open(
                route::Target {
                    profile: &profile,
                    secret,
                    hops,
                    paths: &paths,
                    forward_agent: false,
                },
                &mut channels,
                sink.clone(),
                &connections,
                &id,
            )
            .await?;
            route.publish(&connections, &id);
            sink(Event::State {
                status: "connected".into(),
                message: format!("연결됨 · {}", route.description),
            })?;
            hold(&route, idle).await
        };
        let result = tokio::select! {
            biased;
            _ = stopped.wait_for(|stop| *stop) => Ok("연결을 닫았습니다.".to_string()),
            result = work => result,
        };
        connections.finish(&id);
        ended();
        let (status, message) = match result {
            Ok(message) => ("closed", message),
            Err(message) => ("error", message),
        };
        let _ = sink(Event::State {
            status: status.into(),
            message,
        });
    });
    Ok(())
}

/// Keeps the logged-in connection until it breaks or, with an idle limit, stops being used.
async fn hold(route: &route::Route, idle: Idle) -> Result<String> {
    let quiet = async move {
        match idle {
            Some((clock, limit)) => {
                let minutes = limit.as_secs() / 60;
                unused(clock, limit).await;
                format!("{minutes}분간 쓰지 않아 연결을 닫았습니다.")
            }
            None => std::future::pending().await,
        }
    };
    tokio::pin!(quiet);
    loop {
        tokio::select! {
            message = &mut quiet => return Ok(message),
            _ = tokio::time::sleep(HEALTH_INTERVAL) => {}
        }
        if let Some(hop) = route.broken_hop() {
            return Err(format!("{hop}홉 연결이 끊어졌습니다."));
        }
        if route.session.is_closed() {
            return Err("서버 연결이 끊어졌습니다.".into());
        }
    }
}

/// Finishes once `limit` passes with no use. Connecting time does not count, so the clock
/// starts when this is first polled.
async fn unused(mut clock: watch::Receiver<Instant>, limit: Duration) {
    let mut since = Instant::now();
    loop {
        let wait = tokio::time::sleep_until((since + limit).into());
        tokio::select! {
            _ = wait => return,
            changed = clock.changed() => {
                // The sender goes with its owner, and the stop that follows ends this task.
                if changed.is_err() {
                    return std::future::pending().await;
                }
                since = *clock.borrow_and_update();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unused_ends_after_the_limit() {
        let (_used, clock) = watch::channel(Instant::now());
        let started = Instant::now();
        unused(clock, Duration::from_millis(60)).await;
        assert!(started.elapsed() >= Duration::from_millis(60));
    }

    #[tokio::test]
    async fn a_use_restarts_the_clock() {
        let (used, clock) = watch::channel(Instant::now());
        let started = Instant::now();
        let waiting = tokio::spawn(unused(clock, Duration::from_millis(200)));
        tokio::time::sleep(Duration::from_millis(120)).await;
        used.send_replace(Instant::now());
        waiting.await.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(320));
    }

    #[tokio::test]
    async fn a_dropped_owner_does_not_end_the_wait_by_itself() {
        let (used, clock) = watch::channel(Instant::now());
        let waiting = tokio::spawn(unused(clock, Duration::from_secs(60)));
        drop(used);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!waiting.is_finished());
        waiting.abort();
    }
}
