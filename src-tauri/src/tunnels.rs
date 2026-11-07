use crate::{ssh::Connections, storage::Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch},
    task::JoinSet,
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    pub kind: String,
    pub port: u16,
    pub host: String,
    pub target_port: u16,
    pub auto_start: bool,
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        if !["local", "remote", "dynamic"].contains(&self.kind.as_str())
            || self.name.is_empty()
            || self.name.len() > 100
            || self.host.is_empty()
            || self.host.len() > 253
            || self
                .host
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
            || self.target_port == 0
        {
            return Err("터널 설정을 확인하세요.".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub kind: String,
    pub port: u16,
    pub host: String,
    pub target_port: u16,
    pub status: String,
    pub message: String,
}
#[derive(Default)]
pub struct Tunnels {
    entries: Mutex<HashMap<String, (Status, watch::Sender<bool>)>>,
}
pub type Forwarded = mpsc::Sender<russh::Channel<russh::client::Msg>>;
impl Tunnels {
    pub fn list(&self) -> Vec<Status> {
        self.entries
            .lock()
            .unwrap()
            .values()
            .map(|v| v.0.clone())
            .collect()
    }
    pub fn stop(&self, id: &str) {
        if let Some(v) = self.entries.lock().unwrap().get(id) {
            let _ = v.1.send(true);
        }
    }
    pub async fn start(
        self: &Arc<Self>,
        connections: Arc<Connections>,
        connection: String,
        c: Config,
    ) -> Result<String> {
        c.validate()?;
        let handle = connections.handle(&connection)?;
        let mut disconnected = connections.control(&connection)?.stop.subscribe();
        let id = format!("{}:{}", connection, c.id);
        let (stop, mut stopped) = watch::channel(false);
        {
            let mut entries = self.entries.lock().unwrap();
            if entries.len() > 128 {
                entries.retain(|_, v| v.0.status == "running" || v.0.status == "starting");
            }
            if entries
                .values()
                .filter(|v| v.0.status == "running" || v.0.status == "starting")
                .count()
                >= 32
            {
                return Err("터널은 최대 32개입니다.".into());
            }
            if entries
                .get(&id)
                .is_some_and(|v| v.0.status == "running" || v.0.status == "starting")
            {
                return Err("이미 실행 중인 터널입니다.".into());
            }
            entries.insert(
                id.clone(),
                (
                    Status {
                        id: id.clone(),
                        connection_id: connection.clone(),
                        name: c.name.clone(),
                        kind: c.kind.clone(),
                        port: c.port,
                        host: c.host.clone(),
                        target_port: c.target_port,
                        status: "starting".into(),
                        message: String::new(),
                    },
                    stop,
                ),
            );
        }
        let setup = async {
            if c.kind == "remote" {
                let assigned = tokio::time::timeout(
                    Duration::from_secs(10),
                    handle.tcpip_forward("127.0.0.1", c.port as u32),
                )
                .await
                .map_err(|_| "원격 바인딩 시간 초과")?
                .map_err(|_| "서버가 원격 포워딩을 거부했습니다.")?;
                let port = if c.port == 0 { assigned as u16 } else { c.port };
                let (tx, rx) = mpsc::channel(32);
                connections
                    .forwards
                    .lock()
                    .unwrap()
                    .insert((connection.clone(), port), tx);
                Ok::<_, String>((None, Some(rx), port))
            } else {
                let listener = TcpListener::bind(("127.0.0.1", c.port))
                    .await
                    .map_err(|_| "로컬 포트를 열 수 없습니다. 포트 충돌을 확인하세요.")?;
                let port = listener.local_addr().map_err(|_| "포트 확인 실패")?.port();
                Ok((Some(listener), None, port))
            }
        }
        .await;
        let (listener, mut forwarded, port) = match setup {
            Ok(v) => v,
            Err(e) => {
                if let Some(v) = self.entries.lock().unwrap().get_mut(&id) {
                    v.0.status = "error".into();
                    v.0.message = e.clone();
                }
                return Err(e);
            }
        };
        {
            let mut entries = self.entries.lock().unwrap();
            let v = entries.get_mut(&id).unwrap();
            v.0.port = port;
            v.0.status = "running".into();
            v.0.message = format!("127.0.0.1:{port}");
        }
        let tunnels = self.clone();
        let task = id.clone();
        tokio::spawn(async move {
            let mut children = JoinSet::new();
            {
                let serve = async {
                    loop {
                        tokio::select! {
                            Some(_)=children.join_next(), if !children.is_empty()=>{},
                            socket=async{listener.as_ref().unwrap().accept().await},if listener.is_some() && children.len()<64=>{
                                let Ok((mut socket,_))=socket else{break;};let h=handle.clone();let c=c.clone();
                                children.spawn(async move {
                                    let destination=if c.kind=="dynamic" {match tokio::time::timeout(Duration::from_secs(10),socks(&mut socket)).await {Ok(Ok(v))=>v,_=>return}}else{(c.host,c.target_port)};
                                    let result=tokio::time::timeout(Duration::from_secs(10),h.channel_open_direct_tcpip(destination.0,destination.1 as u32,"127.0.0.1",0)).await;
                                    let channel=match result {Ok(Ok(v))=>v,_=>{if c.kind=="dynamic"{let _=socket.write_all(&[5,5,0,1,0,0,0,0,0,0]).await;}return;}};
                                    if c.kind=="dynamic"&&socket.write_all(&[5,0,0,1,127,0,0,1,0,0]).await.is_err(){return;}
                                    let _=tokio::io::copy_bidirectional(&mut socket,&mut channel.into_stream()).await;
                                });
                            },
                            incoming=async{forwarded.as_mut().unwrap().recv().await},if forwarded.is_some() && children.len()<64=>{
                                let Some(channel)=incoming else{break;};let c=c.clone();children.spawn(async move {if let Ok(Ok(mut socket))=tokio::time::timeout(Duration::from_secs(10),TcpStream::connect((c.host.as_str(),c.target_port))).await{let _=tokio::io::copy_bidirectional(&mut socket,&mut channel.into_stream()).await;}});
                            }
                        }
                    }
                };
                if !*disconnected.borrow() && !*stopped.borrow() {
                    tokio::select! {_=serve=>{},_=stopped.changed()=>{},_=disconnected.changed()=>{}}
                }
            }
            children.abort_all();
            while children.join_next().await.is_some() {}
            if c.kind == "remote" {
                connections
                    .forwards
                    .lock()
                    .unwrap()
                    .remove(&(connection, port));
                let _ = tokio::time::timeout(
                    Duration::from_secs(5),
                    handle.cancel_tcpip_forward("127.0.0.1", port as u32),
                )
                .await;
            }
            if let Some(v) = tunnels.entries.lock().unwrap().get_mut(&task) {
                v.0.status = "stopped".into();
                v.0.message = "터널 종료 · 연결과 리스너 정리됨".into();
            }
        });
        Ok(id)
    }
}
async fn socks(socket: &mut TcpStream) -> Result<(String, u16)> {
    if socket.read_u8().await.map_err(|_| "SOCKS 읽기 실패")? != 5 {
        return Err("SOCKS5 필요".into());
    }
    let count = socket.read_u8().await.map_err(|_| "SOCKS 읽기 실패")?;
    let mut methods = vec![0; count as usize];
    socket
        .read_exact(&mut methods)
        .await
        .map_err(|_| "SOCKS 읽기 실패")?;
    if !methods.contains(&0) {
        let _ = socket.write_all(&[5, 255]).await;
        return Err("지원하지 않는 인증".into());
    }
    socket
        .write_all(&[5, 0])
        .await
        .map_err(|_| "SOCKS 응답 실패")?;
    let mut head = [0; 4];
    socket
        .read_exact(&mut head)
        .await
        .map_err(|_| "SOCKS 요청 실패")?;
    if head[..3] != [5, 1, 0] {
        let _ = socket.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return Err("TCP CONNECT만 지원".into());
    }
    let host = match head[3] {
        1 => {
            let mut bytes = [0; 4];
            socket
                .read_exact(&mut bytes)
                .await
                .map_err(|_| "주소 오류")?;
            std::net::Ipv4Addr::from(bytes).to_string()
        }
        4 => {
            let mut bytes = [0; 16];
            socket
                .read_exact(&mut bytes)
                .await
                .map_err(|_| "주소 오류")?;
            std::net::Ipv6Addr::from(bytes).to_string()
        }
        3 => {
            let count = socket.read_u8().await.map_err(|_| "주소 오류")?;
            let mut bytes = vec![0; count as usize];
            socket
                .read_exact(&mut bytes)
                .await
                .map_err(|_| "주소 오류")?;
            let host = String::from_utf8(bytes).map_err(|_| "도메인 오류")?;
            if host.is_empty()
                || !host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            {
                return Err("도메인 오류".into());
            }
            host
        }
        _ => {
            let _ = socket.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return Err("주소 유형 오류".into());
        }
    };
    let port = socket.read_u16().await.map_err(|_| "포트 오류")?;
    if port == 0 {
        return Err("포트 오류".into());
    }
    Ok((host, port))
}
