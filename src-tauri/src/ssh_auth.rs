use crate::{
    ssh::{AuthPrompt, AuthReply, Event, Host, Sink},
    storage::Result,
};
use russh::{
    client::{self, KeyboardInteractiveAuthResponse as Response},
    keys::{
        Certificate, HashAlg, PrivateKey, PrivateKeyWithHashAlg,
        agent::{AgentIdentity, client::AgentClient},
    },
};
use std::{sync::Arc, time::Duration};
use tokio::{sync::mpsc, time::timeout};

/// Asks for a secret that is not saved. `last` is the session itself rather than a jump host.
pub async fn hop_secret(
    p: &crate::storage::Profile,
    last: bool,
    sink: &Sink,
    replies: &mut mpsc::Receiver<AuthReply>,
) -> Result<zeroize::Zeroizing<String>> {
    let (name, instructions) = if last {
        (
            "세션 인증",
            "이번 연결에만 사용합니다. 저장하려면 세션을 편집하세요.",
        )
    } else {
        (
            "경유지 인증",
            "이번 연결에만 사용합니다. 저장하려면 해당 경유 프로필을 편집하세요.",
        )
    };
    let prompt = if p.auth == "key" {
        "Passphrase (없으면 빈 값)"
    } else {
        "비밀번호"
    };
    ask_one(sink, replies, name, instructions, prompt).await
}

/// Asks who to log in as, for a session saved without a user name. Nothing is saved: the next
/// connection asks again.
pub async fn hop_username(
    last: bool,
    sink: &Sink,
    replies: &mut mpsc::Receiver<AuthReply>,
) -> Result<String> {
    let name = if last {
        "세션 로그인"
    } else {
        "경유지 로그인"
    };
    let instructions = "이 세션은 사용자명 없이 저장되어 있습니다. 이번 연결에만 사용합니다. 저장하려면 세션을 편집하세요.";
    let answer = ask(sink, replies, name, instructions, "사용자명", true).await?;
    let user = answer.trim();
    if user.is_empty() || user.len() > 256 || user.chars().any(char::is_control) {
        return Err("사용자명을 입력해야 연결할 수 있습니다.".into());
    }
    Ok(user.to_string())
}

/// Shows one hidden prompt and waits up to two minutes for its answer.
pub async fn ask_one(
    sink: &Sink,
    replies: &mut mpsc::Receiver<AuthReply>,
    name: &str,
    instructions: &str,
    prompt: &str,
) -> Result<zeroize::Zeroizing<String>> {
    ask(sink, replies, name, instructions, prompt, false).await
}

/// One prompt, shown as typed when `echo`, and up to two minutes for its answer.
async fn ask(
    sink: &Sink,
    replies: &mut mpsc::Receiver<AuthReply>,
    name: &str,
    instructions: &str,
    prompt: &str,
    echo: bool,
) -> Result<zeroize::Zeroizing<String>> {
    let challenge = uuid::Uuid::new_v4().to_string();
    sink(Event::AuthPrompt {
        challenge: challenge.clone(),
        name: name.into(),
        instructions: instructions.into(),
        prompts: vec![AuthPrompt {
            prompt: prompt.into(),
            echo,
        }],
    })?;
    timeout(Duration::from_secs(120), async {
        loop {
            let mut reply = replies.recv().await.ok_or("인증 입력이 취소되었습니다.")?;
            if reply.challenge == challenge {
                if reply.responses.len() != 1 {
                    return Err("인증 응답 개수 오류".into());
                }
                return Ok(zeroize::Zeroizing::new(reply.responses.remove(0)));
            }
        }
    })
    .await
    .map_err(|_| "인증 입력 시간이 초과되었습니다.")?
}

/// Pageant opens without being found; a failed or empty key list is how it shows (CG.0).
pub const PAGEANT_MISSING: &str = "Pageant가 실행 중이 아니거나 키가 없습니다.";

pub async fn agent(
    session: &mut client::Handle<Host>,
    user: &str,
    source: &str,
) -> Result<client::AuthResult> {
    let mut agent = AgentClient::connect(crate::agent_relay::open(source).await?);
    let pageant = source == "pageant";
    if let Some(binding) = session.agent_session_binding() {
        // Older agents do not implement session binding. No agent forwarding is enabled.
        let _ = agent.bind_session(binding, false).await;
    }
    let identities = agent.request_identities().await.map_err(|_| {
        if pageant {
            PAGEANT_MISSING
        } else {
            "에이전트 키 목록을 읽을 수 없습니다."
        }
    })?;
    if identities.is_empty() {
        return Err(if pageant {
            PAGEANT_MISSING
        } else {
            "에이전트에 등록된 키가 없습니다. ssh-add로 키를 등록하세요."
        }
        .into());
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

fn partial(result: &client::AuthResult) -> bool {
    matches!(
        result,
        client::AuthResult::Failure {
            partial_success: true,
            ..
        }
    )
}

/// Public key login with a decoded key file. RSA signs through ring with SHA-2 only. A
/// certificate goes first; when the server refuses it the key is tried alone, as OpenSSH does.
pub async fn key(
    session: &mut client::Handle<Host>,
    user: &str,
    key: PrivateKey,
    cert: Option<Certificate>,
) -> Result<client::AuthResult> {
    if let Some(cert) = cert {
        let result = certificate(session, user, &key, cert).await?;
        if result.success() || partial(&result) {
            return Ok(result);
        }
    }
    if !key.algorithm().is_rsa() {
        return session
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), None))
            .await
            .map_err(|_| "개인키 인증에 실패했습니다.".into());
    }
    let mut signer = crate::rsa_auth::RsaSigner::new(&key)?;
    let hash = session
        .best_supported_rsa_hash()
        .await
        .map_err(|_| "RSA SHA-2 협상에 실패했습니다.")?
        .flatten()
        .unwrap_or(HashAlg::Sha512);
    let failed = |_| "RSA SHA-2 개인키 인증에 실패했습니다.".to_string();
    let result = session
        .authenticate_publickey_with(user, key.public_key().clone(), Some(hash), &mut signer)
        .await
        .map_err(failed)?;
    if hash == HashAlg::Sha512
        && matches!(
            result,
            client::AuthResult::Failure {
                partial_success: false,
                ..
            }
        )
    {
        return session
            .authenticate_publickey_with(
                user,
                key.public_key().clone(),
                Some(HashAlg::Sha256),
                &mut signer,
            )
            .await
            .map_err(failed);
    }
    Ok(result)
}

/// `authenticate_openssh_cert` names an RSA certificate with SHA-1, which servers refuse (CG.0),
/// so RSA signs through ring with the SHA-2 the server offers.
async fn certificate(
    session: &mut client::Handle<Host>,
    user: &str,
    key: &PrivateKey,
    cert: Certificate,
) -> Result<client::AuthResult> {
    const FAILED: &str = "인증서 인증에 실패했습니다.";
    if !key.algorithm().is_rsa() {
        return session
            .authenticate_openssh_cert(user, Arc::new(key.clone()), cert)
            .await
            .map_err(|_| FAILED.into());
    }
    let mut signer = crate::rsa_auth::RsaSigner::new(key)?;
    let hash = session
        .best_supported_rsa_hash()
        .await
        .map_err(|_| "RSA SHA-2 협상에 실패했습니다.")?
        .flatten()
        .unwrap_or(HashAlg::Sha512);
    let result = session
        .authenticate_certificate_with(user, cert.clone(), Some(hash), &mut signer)
        .await
        .map_err(|_| FAILED)?;
    if hash == HashAlg::Sha512 && !result.success() && !partial(&result) {
        return session
            .authenticate_certificate_with(user, cert, Some(HashAlg::Sha256), &mut signer)
            .await
            .map_err(|_| FAILED.into());
    }
    Ok(result)
}

#[cfg(windows)]
pub(crate) fn agent_pipe() -> String {
    #[cfg(debug_assertions)]
    if let Ok(pipe) = std::env::var("DACHSTERM_TEST_AGENT_PIPE")
        && pipe.starts_with(r"\\.\pipe\dachsterm-agent-")
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Answers the prompt with `answer`, and tells whether it was shown as typed.
    async fn asked(answer: &str) -> (Result<String>, bool) {
        let (tx, mut rx) = mpsc::channel(1);
        let echo = Arc::new(Mutex::new(false));
        let (seen, reply) = (echo.clone(), answer.to_string());
        let sink: Sink = Arc::new(move |event| {
            if let Event::AuthPrompt {
                challenge, prompts, ..
            } = event
            {
                *seen.lock().unwrap() = prompts[0].echo;
                let responses = zeroize::Zeroizing::new(vec![reply.clone()]);
                tx.try_send(AuthReply {
                    challenge,
                    responses,
                })
                .map_err(|_| "reply not taken")?;
            }
            Ok(())
        });
        let user = hop_username(true, &sink, &mut rx).await;
        let echo = *echo.lock().unwrap();
        (user, echo)
    }

    #[tokio::test]
    async fn a_session_saved_without_a_user_name_asks_for_it_in_the_clear() {
        let (user, echo) = asked(" deploy ").await;
        assert_eq!(user.unwrap(), "deploy");
        assert!(echo);
        assert!(asked("  ").await.0.is_err());
        assert!(asked("a\nb").await.0.is_err());
    }
}
