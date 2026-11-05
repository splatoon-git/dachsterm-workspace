use crate::{
    ssh::{AuthPrompt, AuthReply, Event, Host, Sink},
    storage::Result,
};
use russh::{
    client::{self, KeyboardInteractiveAuthResponse as Response},
    keys::{
        HashAlg,
        agent::{AgentIdentity, client::AgentClient},
    },
};
use std::time::Duration;
use tokio::{sync::mpsc, time::timeout};

pub async fn hop_secret(
    p: &crate::storage::Profile,
    sink: &Sink,
    replies: &mut mpsc::Receiver<AuthReply>,
) -> Result<zeroize::Zeroizing<String>> {
    let challenge = uuid::Uuid::new_v4().to_string();
    sink(Event::AuthPrompt {
        challenge: challenge.clone(),
        name: "경유지 인증".into(),
        instructions: "이번 연결에만 사용합니다. 저장하려면 해당 경유 프로필을 편집하세요.".into(),
        prompts: vec![AuthPrompt {
            prompt: if p.auth == "key" {
                "Passphrase (없으면 빈 값)"
            } else {
                "비밀번호"
            }
            .into(),
            echo: false,
        }],
    })?;
    timeout(Duration::from_secs(120), async {
        loop {
            let mut reply = replies.recv().await.ok_or("경유 인증이 취소되었습니다.")?;
            if reply.challenge == challenge {
                if reply.responses.len() != 1 {
                    return Err("인증 응답 개수 오류".into());
                }
                return Ok(zeroize::Zeroizing::new(reply.responses.remove(0)));
            }
        }
    })
    .await
    .map_err(|_| "경유 인증 입력 시간 초과")?
}

pub async fn agent(session: &mut client::Handle<Host>, user: &str) -> Result<client::AuthResult> {
    #[cfg(windows)]
    let mut agent = AgentClient::connect_named_pipe(agent_pipe()).await
        .map_err(|_| "Windows OpenSSH 인증 에이전트에 연결할 수 없습니다. ssh-agent 서비스와 ssh-add 등록을 확인하세요.")?;
    #[cfg(unix)]
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|_| "SSH_AUTH_SOCK 인증 에이전트에 연결할 수 없습니다.")?;
    if let Some(binding) = session.agent_session_binding() {
        // Older agents do not implement session binding. No agent forwarding is enabled.
        let _ = agent.bind_session(binding, false).await;
    }
    let identities = agent
        .request_identities()
        .await
        .map_err(|_| "에이전트 키 목록을 읽을 수 없습니다.")?;
    if identities.is_empty() {
        return Err("에이전트에 등록된 키가 없습니다. ssh-add로 키를 등록하세요.".into());
    }
    let mut last = None;
    // Bound attempts: OpenSSH commonly permits six failures per connection.
    let mut attempts = 0;
    for identity in identities.into_iter().take(5) {
        if identity
            .public_key()
            .key_data()
            .rsa()
            .is_some_and(|key| !(2048..=8192).contains(&key.key_size()))
        {
            continue;
        }
        let hash = if identity.public_key().algorithm().is_rsa() {
            Some(
                session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|_| "RSA SHA-2 협상 실패")?
                    .flatten()
                    .unwrap_or(HashAlg::Sha512),
            )
        } else {
            None
        };
        let hashes = if hash == Some(HashAlg::Sha512) {
            vec![hash, Some(HashAlg::Sha256)]
        } else {
            vec![hash]
        };
        for hash in hashes {
            if attempts >= 5 {
                break;
            }
            attempts += 1;
            let result = match identity.clone() {
                AgentIdentity::PublicKey { key, .. } => {
                    session
                        .authenticate_publickey_with(user, key, hash, &mut agent)
                        .await
                }
                AgentIdentity::Certificate { certificate, .. } => {
                    session
                        .authenticate_certificate_with(user, certificate, hash, &mut agent)
                        .await
                }
            }
            .map_err(|_| "에이전트 서명에 실패했습니다. 키 잠금·승인 상태를 확인하세요.")?;
            if result.success()
                || matches!(
                    result,
                    client::AuthResult::Failure {
                        partial_success: true,
                        ..
                    }
                )
            {
                return Ok(result);
            }
            last = Some(result);
        }
    }
    last.ok_or("에이전트 인증에 실패했습니다.".into())
}

#[cfg(windows)]
fn agent_pipe() -> String {
    #[cfg(debug_assertions)]
    if let Ok(pipe) = std::env::var("DAXTERM_TEST_AGENT_PIPE")
        && pipe.starts_with(r"\\.\pipe\daxterm-agent-")
    {
        return pipe;
    }
    r"\\.\pipe\openssh-ssh-agent".into()
}

pub async fn interactive(
    session: &mut client::Handle<Host>,
    user: &str,
    sink: &Sink,
    replies: &mut mpsc::Receiver<AuthReply>,
) -> Result<bool> {
    let mut response = timeout(
        Duration::from_secs(30),
        session.authenticate_keyboard_interactive_start(user, None::<String>),
    )
    .await
    .map_err(|_| "추가 인증 요청 시간 초과")?
    .map_err(|_| "추가 인증을 시작할 수 없습니다.")?;
    for _ in 0..12 {
        match response {
            Response::Success => return Ok(true),
            Response::Failure { .. } => return Ok(false),
            Response::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                if prompts.len() > 16
                    || name.len() > 4096
                    || instructions.len() > 16384
                    || prompts.iter().any(|p| p.prompt.len() > 4096)
                {
                    return Err("서버의 추가 인증 요청이 너무 큽니다.".into());
                }
                let count = prompts.len();
                let challenge = uuid::Uuid::new_v4().to_string();
                sink(Event::AuthPrompt {
                    challenge: challenge.clone(),
                    name,
                    instructions,
                    prompts: prompts
                        .into_iter()
                        .map(|p| AuthPrompt {
                            prompt: p.prompt,
                            echo: p.echo,
                        })
                        .collect(),
                })?;
                // RFC 4256 permits informational requests with zero prompts.
                // Acknowledge them without requiring a meaningless extra click.
                if count == 0 {
                    response = timeout(
                        Duration::from_secs(30),
                        session.authenticate_keyboard_interactive_respond(Vec::new()),
                    )
                    .await
                    .map_err(|_| "추가 인증 응답 시간 초과")?
                    .map_err(|_| "추가 인증에 실패했습니다.")?;
                    continue;
                }
                let answer = timeout(Duration::from_secs(120), async {
                    loop {
                        let reply = replies.recv().await.ok_or("추가 인증이 취소되었습니다.")?;
                        if reply.challenge == challenge {
                            break Ok::<_, &str>(reply);
                        }
                    }
                })
                .await
                .map_err(|_| "추가 인증 입력 시간이 초과되었습니다.")??;
                if answer.responses.len() != count {
                    return Err("추가 인증 응답 개수가 다릅니다.".into());
                }
                response = timeout(
                    Duration::from_secs(30),
                    session.authenticate_keyboard_interactive_respond(answer.responses.to_vec()),
                )
                .await
                .map_err(|_| "추가 인증 응답 시간 초과")?
                .map_err(|_| "추가 인증에 실패했습니다.")?;
            }
        }
    }
    Err("추가 인증 요청 횟수가 초과되었습니다.".into())
}
