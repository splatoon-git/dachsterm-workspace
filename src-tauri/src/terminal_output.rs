//! Output pump for terminals that read a russh channel: the SSH terminal and the pod terminal
//! over SSH. The local PTY reads its own way (`local.rs`) and keeps its own rules.
//!
//! One frame is in flight at a time, and the next is sent only after the window acknowledges
//! the last one has been drawn, so a busy server cannot outrun the screen. While a frame waits,
//! the data that arrives is gathered into the next frame, up to 32KiB. Sending each SSH message
//! as its own frame kept a terminal at one ~4KiB message per round trip (the 5.1 endurance
//! measurement in docs/verification/endurance.md).
//!
//! A window that acknowledges nothing for 30 one-second steps ends the connection. The steps
//! are counted, not measured: after the PC wakes from sleep the clock may have moved on by
//! hours, and that must count as one step rather than end every connection that was drawing.
use russh::ChannelMsg;
use std::future::Future;
use tokio::{sync::watch, time::Instant};

const FRAME: usize = 32768;
const STEP: std::time::Duration = std::time::Duration::from_secs(1);
const STALL_STEPS: u32 = 30;

/// Where channel messages come from: a russh channel, or a queue in tests.
pub(crate) trait Source {
    fn next(&mut self) -> impl Future<Output = Option<ChannelMsg>> + Send;
}
impl Source for russh::ChannelReadHalf {
    fn next(&mut self) -> impl Future<Output = Option<ChannelMsg>> + Send {
        self.wait()
    }
}

/// What to do with a message that is not output.
pub(crate) enum Other {
    Ignore,
    /// Stop reading; the output already read is still sent.
    End,
    /// End with this error once the output read before it has been sent.
    Fail(String),
}

/// Sends output as frames until the source ends or `other` ends it. Returns once every byte
/// has been handed to `send`; the last frame may still be waiting for its ACK.
pub(crate) async fn pump<S: Source>(
    source: &mut S,
    ack: &mut watch::Receiver<u64>,
    mut send: impl FnMut(u64, Vec<u8>) -> Result<(), String>,
    mut other: impl FnMut(ChannelMsg) -> Other,
    stalled: &str,
) -> Result<(), String> {
    let mut seq = 0_u64;
    let mut pending: Vec<u8> = Vec::new();
    let mut open = true;
    let mut failure = None;
    let mut stalls = 0;
    let stall = tokio::time::sleep(STEP);
    tokio::pin!(stall);
    loop {
        let acked = *ack.borrow_and_update();
        if acked >= seq && !pending.is_empty() {
            let rest = pending.split_off(pending.len().min(FRAME));
            seq += 1;
            send(seq, std::mem::replace(&mut pending, rest))?;
            stalls = 0;
            stall.as_mut().reset(Instant::now() + STEP);
            continue;
        }
        if !open && pending.is_empty() {
            return failure.map_or(Ok(()), Err);
        }
        let waiting = acked < seq;
        tokio::select! {
            message = source.next(), if open && pending.len() < FRAME => match message {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    pending.extend_from_slice(&data)
                }
                Some(message) => match other(message) {
                    Other::Ignore => {}
                    Other::End => open = false,
                    Other::Fail(e) => {
                        open = false;
                        failure = Some(e);
                    }
                },
                None => open = false,
            },
            changed = ack.changed(), if waiting => {
                changed.map_err(|_| "출력 구독 종료".to_string())?;
                stalls = 0;
                stall.as_mut().reset(Instant::now() + STEP);
            }
            () = &mut stall, if waiting => {
                stalls += 1;
                if stalls >= STALL_STEPS {
                    return Err(stalled.to_string());
                }
                stall.as_mut().reset(Instant::now() + STEP);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::mpsc;

    impl Source for mpsc::UnboundedReceiver<ChannelMsg> {
        fn next(&mut self) -> impl Future<Output = Option<ChannelMsg>> + Send {
            self.recv()
        }
    }
    fn data(bytes: &[u8]) -> ChannelMsg {
        ChannelMsg::Data {
            data: bytes.to_vec().into(),
        }
    }
    type Frames = Arc<Mutex<Vec<(u64, Vec<u8>)>>>;
    fn start(
        mut rx: mpsc::UnboundedReceiver<ChannelMsg>,
    ) -> (
        Frames,
        watch::Sender<u64>,
        tokio::task::JoinHandle<Result<(), String>>,
    ) {
        let frames: Frames = Arc::default();
        let (ack, mut acked) = watch::channel(0);
        let out = frames.clone();
        let task = tokio::spawn(async move {
            pump(
                &mut rx,
                &mut acked,
                move |seq, bytes| {
                    out.lock().unwrap().push((seq, bytes));
                    Ok(())
                },
                |m| match m {
                    ChannelMsg::Close => Other::End,
                    ChannelMsg::ExitStatus { exit_status } if exit_status != 0 => {
                        Other::Fail("failed".into())
                    }
                    _ => Other::Ignore,
                },
                "stalled",
            )
            .await
        });
        (frames, ack, task)
    }
    async fn frames_reach(frames: &Frames, n: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while frames.lock().unwrap().len() < n {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("frames not sent");
    }

    #[tokio::test]
    async fn gathers_messages_that_arrive_while_a_frame_waits() {
        let (tx, rx) = mpsc::unbounded_channel();
        let (frames, ack, task) = start(rx);
        tx.send(data(&[0; 4096])).unwrap();
        frames_reach(&frames, 1).await;
        // Sixteen more 4KiB messages arrive before the window draws the first frame.
        for i in 1..=16u8 {
            tx.send(data(&[i; 4096])).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(frames.lock().unwrap().len(), 1, "sent before the ACK");
        ack.send(1).unwrap();
        frames_reach(&frames, 2).await;
        ack.send(2).unwrap();
        frames_reach(&frames, 3).await;
        tx.send(ChannelMsg::Close).unwrap();
        let _ = ack.send(3);
        task.await.unwrap().unwrap();
        let frames = frames.lock().unwrap();
        let sizes: Vec<usize> = frames.iter().map(|f| f.1.len()).collect();
        assert_eq!(sizes, [4096, 32768, 32768]);
        assert_eq!(
            frames.iter().map(|f| f.0).collect::<Vec<_>>(),
            [1, 2, 3],
            "sequence numbers"
        );
        let all: Vec<u8> = frames.iter().flat_map(|f| f.1.clone()).collect();
        let expected: Vec<u8> = (0..=16u8).flat_map(|i| [i; 4096]).collect();
        assert_eq!(all, expected, "bytes reordered or lost");
    }

    #[tokio::test]
    async fn splits_a_message_larger_than_a_frame() {
        let (tx, rx) = mpsc::unbounded_channel();
        let (frames, ack, task) = start(rx);
        tx.send(data(&[7; FRAME * 2 + 10])).unwrap();
        tx.send(ChannelMsg::Close).unwrap();
        for seq in 1..=3 {
            frames_reach(&frames, seq as usize).await;
            // The pump may already have ended after the last frame.
            let _ = ack.send(seq);
        }
        task.await.unwrap().unwrap();
        let sizes: Vec<usize> = frames.lock().unwrap().iter().map(|f| f.1.len()).collect();
        assert_eq!(sizes, [FRAME, FRAME, 10]);
    }

    #[tokio::test]
    async fn sends_the_output_read_before_a_failure() {
        let (tx, rx) = mpsc::unbounded_channel();
        let (frames, ack, task) = start(rx);
        tx.send(data(b"first")).unwrap();
        frames_reach(&frames, 1).await;
        tx.send(data(b"last words")).unwrap();
        tx.send(ChannelMsg::ExitStatus { exit_status: 1 }).unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        ack.send(1).unwrap();
        assert_eq!(task.await.unwrap(), Err("failed".into()));
        assert_eq!(frames.lock().unwrap()[1].1, b"last words");
    }

    // Reproduces the wake from sleep: the clock moves on by two minutes at once while a frame
    // waits, and the ACK comes right after. A 30s timeout measured on the clock ended here.
    #[tokio::test(start_paused = true)]
    async fn a_clock_jump_while_waiting_counts_as_one_step() {
        let (tx, rx) = mpsc::unbounded_channel();
        let (frames, ack, task) = start(rx);
        tx.send(data(b"drawn after wake")).unwrap();
        frames_reach(&frames, 1).await;
        tokio::time::advance(Duration::from_secs(120)).await;
        tokio::task::yield_now().await;
        assert!(!task.is_finished(), "ended by the clock jump");
        ack.send(1).unwrap();
        tx.send(data(b"next")).unwrap();
        frames_reach(&frames, 2).await;
        tx.send(ChannelMsg::Close).unwrap();
        let _ = ack.send(2);
        task.await.unwrap().unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_that_never_acknowledges_ends_after_thirty_steps() {
        let (tx, rx) = mpsc::unbounded_channel();
        let (frames, _ack, task) = start(rx);
        tx.send(data(b"never drawn")).unwrap();
        frames_reach(&frames, 1).await;
        let started = Instant::now();
        // Output keeps arriving; it must not reset the count.
        for _ in 0..40 {
            tx.send(data(b"more")).unwrap();
            tokio::time::sleep(Duration::from_millis(500)).await;
            if task.is_finished() {
                break;
            }
        }
        assert_eq!(task.await.unwrap(), Err("stalled".into()));
        let waited = started.elapsed();
        assert!(waited >= Duration::from_secs(29) && waited <= Duration::from_secs(31));
    }
}
