//! Bounded, persistent transfer scheduler. Authentication stays in Connections.
use crate::{
    sftp::{self, Plan, Source, Transfer},
    ssh::Connections,
    storage::{Result, Store},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

const MAX_JOBS: usize = 100;
const MAX_NODES: usize = 10_000;
const MAX_ALL_NODES: usize = 20_000;
const MAX_DEPTH: usize = 64;
const MAX_ACTIVE: usize = 2;
const MAX_RECORD: usize = 16 * 1024 * 1024;
const MAX_TOTAL_RECORD: usize = 64 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
struct Node {
    plan: Plan,
    directory: bool,
    state: String,
    // Final destination; the leaf engine writes to a private sibling first.
    local: PathBuf,
    remote: String,
    target: Option<Source>,
    prepared: bool,
    #[serde(default)]
    error: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    version: u32,
    root: Plan,
    policy: String,
    scanned: bool,
    nodes: Vec<Node>,
    order: u64,
    legacy: bool,
}
struct Job {
    record: Record,
    cancel: watch::Sender<bool>,
    requested: String,
    current: Option<usize>,
}
#[derive(Default)]
struct State {
    jobs: Vec<Job>,
    active: HashSet<String>,
}
#[derive(Default)]
pub struct Transfers {
    state: Mutex<State>,
    store: Mutex<Option<Arc<Store>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub name: String,
    pub status: String,
    pub size: u64,
    pub directory: bool,
    pub message: String,
}

fn active(status: &str) -> bool {
    matches!(status, "running" | "scanning" | "discarding")
}
fn terminal(status: &str) -> bool {
    status == "completed"
}
fn policy(value: &str) -> Result<()> {
    if matches!(value, "skip" | "rename" | "overwrite" | "error") {
        Ok(())
    } else {
        Err("잘못된 충돌 정책".into())
    }
}
pub fn component(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 255
        || matches!(name, "." | "..")
        || name.chars().any(|c| c.is_control() || "/\\:".contains(c))
    {
        return Err("안전하지 않은 파일 이름 · 경로 이탈을 차단했습니다.".into());
    }
    #[cfg(windows)]
    {
        let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        if name.ends_with([' ', '.'])
            || name.contains(['<', '>', '"', '|', '?', '*'])
            || matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && base.as_bytes()[3].is_ascii_digit())
        {
            return Err("Windows에서 안전하게 저장할 수 없는 파일 이름입니다.".into());
        }
    }
    Ok(())
}
fn remote_path(value: &str) -> Result<()> {
    sftp::path(value)?;
    if !value.starts_with('/')
        || value != "/" && value.split('/').skip(1).any(|p| component(p).is_err())
    {
        return Err("정규화된 원격 절대 경로가 필요합니다.".into());
    }
    Ok(())
}
fn local_path(value: &Path) -> Result<()> {
    if !value.is_absolute()
        || value.as_os_str().len() > 4096
        || value
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("정규화된 로컬 절대 경로가 필요합니다.".into());
    }
    for c in value.components() {
        if let Component::Normal(n) = c {
            component(n.to_str().ok_or("UTF-8 파일 이름이 필요합니다.")?)?;
        }
    }
    Ok(())
}
fn linked(m: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        m.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        m.file_type().is_symlink()
    }
}
async fn local_guard(path: &Path) -> Result<()> {
    local_path(path)?;
    for p in path.ancestors() {
        match tokio::fs::symlink_metadata(p).await {
            Ok(m) if linked(&m) => {
                return Err("링크 또는 junction 경로를 따라가지 않습니다.".into());
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(sftp::failure(e)),
        }
    }
    Ok(())
}
fn stamp(m: &std::fs::Metadata) -> Result<Source> {
    Ok(Source {
        size: m.len(),
        modified: m
            .modified()
            .map_err(sftp::failure)?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(sftp::failure)?
            .as_nanos()
            .to_string(),
    })
}
fn target_key(p: &Plan) -> String {
    if p.upload {
        format!("{}:{}", p.destination, p.remote)
    } else {
        let p = p.local.to_string_lossy().replace('\\', "/");
        if cfg!(windows) { p.to_lowercase() } else { p }
    }
}
fn overlaps(a: &str, b: &str) -> bool {
    a == b
        || a.strip_prefix(b).is_some_and(|v| v.starts_with('/'))
        || b.strip_prefix(a).is_some_and(|v| v.starts_with('/'))
}

impl Transfers {
    fn persist(&self, r: &Record) -> Result<()> {
        let value = serde_json::to_string(r).map_err(sftp::failure)?;
        if value.len() > MAX_RECORD {
            return Err("전송 기록이 16MiB 상한을 초과했습니다.".into());
        }
        if let Some(store) = self.store.lock().unwrap().as_ref() {
            let size:i64=store.0.lock().unwrap().query_row("SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM settings WHERE key LIKE 'queue:%' AND key!=?",[format!("queue:{}",r.root.view.id)],|r|r.get(0)).map_err(crate::storage::db_error)?;
            if size as usize + value.len() > MAX_TOTAL_RECORD {
                return Err("전송 큐 기록은 전체 64MiB까지입니다. 완료 기록을 정리하세요.".into());
            }
            store.set_setting(&format!("queue:{}", r.root.view.id), &value)?;
        }
        Ok(())
    }
    pub fn recover(&self, store: Arc<Store>) -> Result<()> {
        let values: Vec<(String, String)> = {
            let db = store.0.lock().unwrap();
            let size:i64=db.query_row("SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM settings WHERE key LIKE 'queue:%' OR key LIKE 'transfer:%'",[],|r|r.get(0)).map_err(crate::storage::db_error)?;
            if size as usize > MAX_TOTAL_RECORD {
                return Err("복구 큐 기록이 64MiB 상한을 초과했습니다.".into());
            }
            let mut query=db.prepare("SELECT key,value FROM settings s WHERE key LIKE 'queue:%' OR (key LIKE 'transfer:%' AND NOT EXISTS (SELECT 1 FROM settings q WHERE q.key='queue:' || substr(s.key,10))) ORDER BY key LIMIT 101").map_err(crate::storage::db_error)?;
            query
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(crate::storage::db_error)?
                .collect::<std::result::Result<_, _>>()
                .map_err(crate::storage::db_error)?
        };
        if values.len() > MAX_JOBS {
            return Err("복구 큐가 100개 상한을 초과했습니다.".into());
        }
        let mut recovered = Vec::new();
        let mut total = 0;
        for (key, value) in values {
            if value.len() > MAX_RECORD {
                return Err("전송 복구 기록 크기 초과".into());
            }
            let mut r: Record = if key.starts_with("transfer:") {
                let p: Plan = serde_json::from_str(&value)
                    .map_err(|_| "이전 전송 기록을 해석할 수 없습니다.")?;
                Record {
                    version: 1,
                    root: p.clone(),
                    policy: "error".into(),
                    scanned: true,
                    nodes: vec![Node {
                        local: p.local.clone(),
                        remote: p.remote.clone(),
                        plan: p,
                        directory: false,
                        state: "pending".into(),
                        target: None,
                        prepared: true,
                        error: String::new(),
                    }],
                    order: recovered.len() as u64,
                    legacy: true,
                }
            } else {
                serde_json::from_str(&value).map_err(|_| "전송 큐 기록을 해석할 수 없습니다.")?
            };
            validate_record(&r)?;
            total += r.nodes.len();
            if total > MAX_ALL_NODES {
                return Err("복구 큐 항목 상한 초과".into());
            }
            if !terminal(&r.root.view.status) && r.root.view.status != "cancelled" {
                r.root.view.status = "paused".into();
                r.root.view.message =
                    "재시작 복구 · 같은 서버에 다시 연결하고 재개를 눌러 확인하세요.".into();
            }
            recovered.push(Job {
                record: r,
                cancel: watch::channel(false).0,
                requested: String::new(),
                current: None,
            });
        }
        let mut state = self.state.lock().unwrap();
        if !state.jobs.is_empty() {
            return Err("실행 중 큐에는 복구할 수 없습니다.".into());
        }
        *self.store.lock().unwrap() = Some(store.clone());
        // Persist the migration before deleting each old record.
        for job in &recovered {
            self.persist(&job.record)?;
            store
                .0
                .lock()
                .unwrap()
                .execute(
                    "DELETE FROM settings WHERE key=?",
                    [format!("transfer:{}", job.record.root.view.id)],
                )
                .map_err(crate::storage::db_error)?;
        }
        state.jobs = recovered;
        Ok(())
    }
    pub fn list(&self) -> Vec<Transfer> {
        let state = self.state.lock().unwrap();
        let mut jobs: Vec<_> = state.jobs.iter().collect();
        jobs.sort_by_key(|j| j.record.order);
        jobs.into_iter()
            .map(|j| j.record.root.view.clone())
            .collect()
    }
    pub fn items(&self, id: &str, offset: usize) -> Result<Vec<Item>> {
        let s = self.state.lock().unwrap();
        let r = &s
            .jobs
            .iter()
            .find(|j| j.record.root.view.id == id)
            .ok_or("전송 작업 없음")?
            .record;
        Ok(r.nodes
            .iter()
            .skip(offset)
            .take(100)
            .map(|n| Item {
                name: if r.root.upload {
                    n.remote.clone()
                } else {
                    n.local.to_string_lossy().into_owned()
                },
                status: if n.error.is_empty() {
                    n.state.clone()
                } else {
                    "failed".into()
                },
                message: n.error.clone(),
                size: n.plan.source.as_ref().map_or(0, |s| s.size),
                directory: n.directory,
            })
            .collect())
    }
    pub fn start(
        self: &Arc<Self>,
        connections: Arc<Connections>,
        connection: String,
        remote: String,
        local: PathBuf,
        upload: bool,
    ) -> Result<String> {
        self.enqueue(
            connections,
            connection,
            vec![(remote, local)],
            upload,
            "error",
            true,
        )
        .map(|mut ids| ids.remove(0))
    }
    #[allow(clippy::too_many_arguments)]
    pub fn enqueue(
        self: &Arc<Self>,
        connections: Arc<Connections>,
        connection: String,
        roots: Vec<(String, PathBuf)>,
        upload: bool,
        conflict: &str,
        legacy: bool,
    ) -> Result<Vec<String>> {
        policy(conflict)?;
        connections.ready(&connection)?;
        if roots.is_empty() || roots.len() > MAX_JOBS {
            return Err("선택은 1~100개입니다.".into());
        }
        let c = connections.control(&connection)?;
        let mut state = self.state.lock().unwrap();
        if state.jobs.len() + roots.len() > MAX_JOBS {
            return Err("큐는 최대 100개입니다. 완료/취소 기록을 정리하세요.".into());
        }
        let mut created = Vec::new();
        let mut keys: Vec<String> = state
            .jobs
            .iter()
            .filter(|j| !terminal(&j.record.root.view.status))
            .map(|j| target_key(&j.record.root))
            .collect();
        let order = state.jobs.iter().map(|j| j.record.order).max().unwrap_or(0);
        for (remote, local) in roots {
            remote_path(&remote)?;
            local_path(&local)?;
            let id = uuid::Uuid::new_v4().to_string();
            let p = Plan {
                view: Transfer {
                    id: id.clone(),
                    connection_id: connection.clone(),
                    profile_id: c.profile.id.clone(),
                    name: remote.clone(),
                    direction: if upload { "upload" } else { "download" }.into(),
                    status: "queued".into(),
                    conflict: conflict.into(),
                    message: "대기 · 부분 파일과 생성한 빈 폴더는 취소해도 보존됩니다.".into(),
                    ..Default::default()
                },
                local,
                remote,
                upload,
                destination: crate::editor::destination(&c.profile),
                source: None,
            };
            let key = target_key(&p);
            if keys.iter().any(|k| overlaps(k, &key)) {
                return Err(
                    "다른 미완료 작업과 목적지가 겹칩니다. 먼저 완료하거나 기록을 정리하세요."
                        .into(),
                );
            }
            keys.push(key);
            created.push(Record {
                version: 1,
                root: p,
                policy: conflict.into(),
                scanned: false,
                nodes: vec![],
                order: order + created.len() as u64 + 1,
                legacy,
            });
        }
        // Atomic batch admission: no filesystem work before every root is durable.
        if let Some(store) = self.store.lock().unwrap().as_ref() {
            let mut db = store.0.lock().unwrap();
            let tx = db.transaction().map_err(crate::storage::db_error)?;
            for r in &created {
                tx.execute(
                    "INSERT INTO settings(key,value) VALUES(?,?)",
                    rusqlite::params![
                        format!("queue:{}", r.root.view.id),
                        serde_json::to_string(r).map_err(sftp::failure)?
                    ],
                )
                .map_err(crate::storage::db_error)?;
            }
            tx.commit().map_err(crate::storage::db_error)?;
        }
        let ids = created.iter().map(|r| r.root.view.id.clone()).collect();
        state.jobs.extend(created.into_iter().map(|record| Job {
            record,
            cancel: watch::channel(false).0,
            requested: String::new(),
            current: None,
        }));
        drop(state);
        self.kick(connections);
        Ok(ids)
    }
    pub fn cancel(&self, id: &str) {
        let _ = self.control(&[id.to_owned()], "pause");
    }
    pub fn control(&self, ids: &[String], action: &str) -> Result<()> {
        if ids.is_empty() || ids.len() > MAX_JOBS || !matches!(action, "pause" | "cancel" | "first")
        {
            return Err("잘못된 큐 작업".into());
        }
        let mut s = self.state.lock().unwrap();
        for id in ids {
            if !s.jobs.iter().any(|j| &j.record.root.view.id == id) {
                return Err("전송 작업 없음".into());
            }
        }
        for id in ids {
            if action == "first" {
                let index = s
                    .jobs
                    .iter()
                    .position(|j| &j.record.root.view.id == id)
                    .unwrap();
                if s.jobs[index].record.root.view.status != "queued" {
                    return Err("대기 작업만 순서를 바꿀 수 있습니다.".into());
                }
                let mut ordered: Vec<_> = (0..s.jobs.len()).collect();
                ordered.sort_by_key(|&i| s.jobs[i].record.order);
                ordered.retain(|&i| i != index);
                ordered.insert(0, index);
                if let Some(store) = self.store.lock().unwrap().as_ref() {
                    let mut db = store.0.lock().unwrap();
                    let tx = db.transaction().map_err(crate::storage::db_error)?;
                    for (order, &i) in ordered.iter().enumerate() {
                        let mut r = s.jobs[i].record.clone();
                        r.order = order as u64;
                        tx.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![format!("queue:{}",r.root.view.id),serde_json::to_string(&r).map_err(sftp::failure)?]).map_err(crate::storage::db_error)?;
                    }
                    tx.commit().map_err(crate::storage::db_error)?;
                }
                for (order, i) in ordered.into_iter().enumerate() {
                    s.jobs[i].record.order = order as u64;
                }
                continue;
            }
            let j = s
                .jobs
                .iter_mut()
                .find(|j| &j.record.root.view.id == id)
                .unwrap();
            if terminal(&j.record.root.view.status) {
                continue;
            }
            if j.record.root.view.status == "discarding" {
                return Err("부분 파일 정리 중입니다.".into());
            }
            let status = if action == "pause" {
                "paused"
            } else {
                "cancelled"
            };
            if active(&j.record.root.view.status) {
                j.requested = status.into();
                j.cancel.send_replace(true);
            } else {
                let mut r = j.record.clone();
                r.root.view.status = status.into();
                r.root.view.message =
                    "부분 파일·생성한 빈 폴더 보존 · 재시도 또는 부분 파일 삭제 가능".into();
                self.persist(&r)?;
                j.record = r;
            }
        }
        Ok(())
    }
    pub fn resume(
        self: &Arc<Self>,
        connections: Arc<Connections>,
        id: String,
        profile: String,
        connection: Option<String>,
    ) -> Result<()> {
        let mut s = self.state.lock().unwrap();
        let j = s
            .jobs
            .iter_mut()
            .find(|j| j.record.root.view.id == id)
            .ok_or("전송 작업 없음")?;
        if !matches!(
            j.record.root.view.status.as_str(),
            "paused" | "failed" | "cancelled"
        ) {
            return Err("재개할 수 없는 상태입니다.".into());
        }
        let connection = connection.unwrap_or_else(|| j.record.root.view.connection_id.clone());
        check_connection(&connections, &j.record.root, &connection, &profile)?;
        let mut r = j.record.clone();
        r.root.view.connection_id = connection;
        r.root.view.status = "queued".into();
        r.root.view.message = "사용자 확인 · 재개 대기".into();
        self.persist(&r)?;
        j.record = r;
        j.requested.clear();
        j.cancel.send_replace(false);
        drop(s);
        self.kick(connections);
        Ok(())
    }
    fn kick(self: &Arc<Self>, connections: Arc<Connections>) {
        let mut s = self.state.lock().unwrap();
        while s.active.len() < MAX_ACTIVE {
            let index = s
                .jobs
                .iter()
                .enumerate()
                .filter(|(_, j)| j.record.root.view.status == "queued")
                .min_by_key(|(_, j)| j.record.order)
                .map(|(i, _)| i);
            let Some(index) = index else { break };
            let j = &mut s.jobs[index];
            j.record.root.view.status = if j.record.scanned || j.record.legacy {
                "running"
            } else {
                "scanning"
            }
            .into();
            let id = j.record.root.view.id.clone();
            let rx = j.cancel.subscribe();
            s.active.insert(id.clone());
            let queue = self.clone();
            let connections = connections.clone();
            tokio::spawn(async move {
                queue.worker(connections, id, rx).await;
            });
        }
    }
    fn update(&self, id: &str, edit: impl FnOnce(&mut Record)) -> Result<()> {
        let mut s = self.state.lock().unwrap();
        let other: usize = s
            .jobs
            .iter()
            .filter(|j| j.record.root.view.id != id)
            .map(|j| j.record.nodes.len())
            .sum();
        let j = s
            .jobs
            .iter_mut()
            .find(|j| j.record.root.view.id == id)
            .ok_or("전송 작업 없음")?;
        let mut r = j.record.clone();
        edit(&mut r);
        if other + r.nodes.len() > MAX_ALL_NODES {
            return Err("전체 큐 항목은 20,000개까지입니다.".into());
        }
        self.persist(&r)?;
        j.record = r;
        Ok(())
    }
    fn record(&self, id: &str) -> Result<Record> {
        self.state
            .lock()
            .unwrap()
            .jobs
            .iter()
            .find(|j| j.record.root.view.id == id)
            .map(|j| j.record.clone())
            .ok_or("전송 작업 없음".into())
    }
    async fn worker(
        self: Arc<Self>,
        connections: Arc<Connections>,
        id: String,
        mut cancelled: watch::Receiver<bool>,
    ) {
        let result=async {
            let r=self.record(&id)?;
            check_connection(&connections,&r.root,&r.root.view.connection_id,&r.root.view.profile_id)?;
            let c=connections.control(&r.root.view.connection_id)?;
            let mut stopped=c.stop.subscribe();
            let committing=std::sync::atomic::AtomicBool::new(false);
            let work=self.execute(&connections,&id,cancelled.clone(),&committing);
            tokio::pin!(work);
            tokio::select! {biased;
                r=&mut work=>r,
                _=cancelled.changed()=>{
                    // FTP finishes/aborts its data command; final rename is allowed to settle.
                    if committing.load(std::sync::atomic::Ordering::SeqCst) || c.profile.protocol!="ssh" {
                        tokio::time::timeout(Duration::from_secs(20),&mut work).await.unwrap_or_else(|_|Err("중단 · 응답 시간 초과 · 부분 파일 보존".into()))
                    }else{Err("일시 중지 · 부분 파일 보존".into())}
                },
                _=stopped.changed()=>Err("연결 종료 · 부분 파일 보존".into())
            }
        }.await;
        {
            let mut s = self.state.lock().unwrap();
            if let Some(j) = s.jobs.iter_mut().find(|j| j.record.root.view.id == id) {
                j.record.root.view.status = if result.is_ok() {
                    "completed".into()
                } else if !j.requested.is_empty() {
                    j.requested.clone()
                } else if j.record.legacy {
                    "paused".into()
                } else {
                    "failed".into()
                };
                if let Err(error) = &result
                    && j.requested.is_empty()
                    && let Some(index) = j.current
                    && let Some(n) = j.record.nodes.get_mut(index)
                {
                    n.error = error.clone();
                }
                j.record.root.view.message = result
                    .err()
                    .unwrap_or_else(|| "전송 완료 · 완료 항목은 다시 전송하지 않습니다.".into());
                if let Err(e) = self.persist(&j.record) {
                    j.record.root.view.status = "failed".into();
                    j.record.root.view.message = format!("복구 기록 저장 실패: {e}");
                }
            }
            s.active.remove(&id);
        }
        self.kick(connections);
    }
}

fn check_connection(c: &Connections, p: &Plan, id: &str, profile: &str) -> Result<()> {
    let c1 = c.control(id)?;
    if c1.profile.id != profile
        || profile != p.view.profile_id
        || crate::editor::destination(&c1.profile) != p.destination
    {
        return Err("처음 전송한 서버 세션에 연결하세요.".into());
    }
    c.ready(id)
}
fn validate_record(r: &Record) -> Result<()> {
    if r.version != 1 || r.nodes.len() > MAX_NODES {
        return Err("지원하지 않는 전송 큐 기록".into());
    }
    policy(&r.policy)?;
    remote_path(&r.root.remote)?;
    local_path(&r.root.local)?;
    uuid::Uuid::parse_str(&r.root.view.id).map_err(|_| "전송 ID 오류")?;
    let mut ids = HashSet::new();
    for n in &r.nodes {
        uuid::Uuid::parse_str(&n.plan.view.id).map_err(|_| "항목 ID 오류")?;
        if !ids.insert(&n.plan.view.id) {
            return Err("중복 항목 ID".into());
        }
        remote_path(&n.remote)?;
        local_path(&n.local)?;
        remote_path(&n.plan.remote)?;
        local_path(&n.plan.local)?;
        let mut expected = n.clone();
        expected.plan.local = n.local.clone();
        expected.plan.remote = n.remote.clone();
        staging(&mut expected, r.legacy);
        if n.plan.local != expected.plan.local
            || n.plan.remote != expected.plan.remote
            || n.plan.upload != r.root.upload
            || n.plan.destination != r.root.destination
            || n.plan.view.profile_id != r.root.view.profile_id
        {
            return Err("복구 항목의 경로 또는 서버 정보가 일치하지 않습니다.".into());
        }
        let local_base = r.root.local.parent().ok_or("로컬 부모 경로 없음")?;
        let remote_base = r
            .root
            .remote
            .rsplit_once('/')
            .ok_or("원격 부모 경로 없음")?
            .0;
        if !n.local.starts_with(local_base)
            || !n
                .remote
                .strip_prefix(remote_base)
                .is_some_and(|s| s.starts_with('/'))
        {
            return Err("복구 경로가 선택한 폴더를 벗어납니다.".into());
        }
    }
    Ok(())
}

struct Metadata {
    directory: bool,
    link: bool,
    source: Option<Source>,
}
struct Backend<'a> {
    connections: &'a Connections,
    id: String,
    sftp: Option<russh_sftp::client::SftpSession>,
    ftp: Option<Arc<crate::ftp::Session>>,
}
impl<'a> Backend<'a> {
    async fn open(connections: &'a Connections, id: &str) -> Result<Self> {
        let ftp = connections.control(id)?.profile.protocol != "ssh";
        Ok(Self {
            connections,
            id: id.into(),
            sftp: if ftp {
                None
            } else {
                Some(sftp::open(connections, id).await?)
            },
            ftp: if ftp {
                Some(connections.ftp_session(id)?)
            } else {
                None
            },
        })
    }
    async fn listing(&self, path: &str) -> Result<sftp::Listing> {
        if let Some(f) = &self.ftp {
            crate::ftp::list(f, path).await
        } else {
            sftp::list(self.connections, &self.id, path).await
        }
    }
    async fn remote_meta(&self, path: &str) -> Result<Option<Metadata>> {
        remote_path(path)?;
        if path == "/" {
            return Ok(Some(Metadata {
                directory: true,
                link: false,
                source: None,
            }));
        }
        if let Some(s) = &self.sftp {
            match s.symlink_metadata(path).await {
                Ok(m) => Ok(Some(Metadata {
                    directory: m.file_type().is_dir(),
                    link: m.file_type().is_symlink()
                        || !(m.file_type().is_file() || m.file_type().is_dir()),
                    source: if m.file_type().is_file() {
                        Some(Source {
                            size: m.size.ok_or("파일 크기 없음")?,
                            modified: m.mtime.ok_or("수정 시각 없음")?.to_string(),
                        })
                    } else {
                        None
                    },
                })),
                Err(russh_sftp::client::error::Error::Status(s))
                    if s.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
                {
                    Ok(None)
                }
                Err(e) => Err(sftp::failure(e)),
            }
        } else {
            let (parent, name) = path.rsplit_once('/').ok_or("원격 경로 오류")?;
            let parent = if parent.is_empty() { "/" } else { parent };
            let listing = self.listing(parent).await?;
            if listing.path.trim_end_matches('/') != parent.trim_end_matches('/') {
                return Err("FTP 경로가 링크 또는 다른 경로로 해석되었습니다.".into());
            }
            if let Some(e) = listing.entries.into_iter().find(|e| e.name == name) {
                let source = if !e.directory && !e.symlink {
                    let mut ftp = self.ftp.as_ref().unwrap().open().await?;
                    let size = ftp.size(path).await.map_err(sftp::failure)? as u64;
                    let modified = ftp
                        .mdtm(path)
                        .await
                        .map_err(|_| "FTP 전송에는 SIZE/MDTM 지원이 필요합니다.")?
                        .to_string();
                    let _ = ftp.quit().await;
                    Some(Source { size, modified })
                } else {
                    None
                };
                Ok(Some(Metadata {
                    directory: e.directory,
                    link: e.symlink,
                    source,
                }))
            } else {
                Ok(None)
            }
        }
    }
    async fn remote_guard(&self, path: &str, include_leaf: bool) -> Result<()> {
        remote_path(path)?;
        let parts: Vec<_> = path.split('/').filter(|p| !p.is_empty()).collect();
        let count = if include_leaf {
            parts.len()
        } else {
            parts.len().saturating_sub(1)
        };
        let mut current = String::new();
        for part in parts.into_iter().take(count) {
            current.push('/');
            current.push_str(part);
            match self.remote_meta(&current).await? {
                Some(m) if m.link => return Err("원격 링크를 따라가지 않습니다.".into()),
                Some(_) => {}
                None => break,
            }
        }
        Ok(())
    }
    async fn target(&self, n: &Node) -> Result<Option<Metadata>> {
        if n.plan.upload {
            self.remote_meta(&n.remote).await
        } else {
            local_meta(&n.local).await
        }
    }
    async fn source(&self, p: &Plan) -> Result<Source> {
        if let Some(f) = &self.ftp {
            crate::ftp::transfer_source(f, p).await
        } else {
            sftp::source(self.sftp.as_ref().unwrap(), p).await
        }
    }
    async fn mkdir(&self, n: &Node) -> Result<()> {
        if n.plan.upload {
            if let Some(s) = &self.sftp {
                s.create_dir(&n.remote).await.map_err(sftp::failure)
            } else {
                crate::ftp::change(self.ftp.as_ref().unwrap(), "mkdir", &n.remote, "").await
            }
        } else {
            tokio::fs::create_dir(&n.local).await.map_err(sftp::failure)
        }
    }
    async fn remove_part(&self, p: &Plan, ready: bool) -> Result<()> {
        if p.upload {
            let path = if ready {
                p.remote.clone()
            } else {
                format!("{}.dachsterm-{}.part", p.remote, p.view.id)
            };
            self.remote_guard(&path, false).await?;
            if let Some(m) = self.remote_meta(&path).await? {
                if m.directory || m.link {
                    return Err("부분 파일이 일반 파일이 아닙니다.".into());
                }
                if let Some(s) = &self.sftp {
                    s.remove_file(path).await.map_err(sftp::failure)?;
                } else {
                    crate::ftp::change(self.ftp.as_ref().unwrap(), "delete", &path, "").await?;
                }
            }
        } else {
            let path = if ready {
                p.local.clone()
            } else {
                p.local
                    .with_file_name(format!(".dachsterm-{}.part", p.view.id))
            };
            local_guard(&path).await?;
            if let Some(m) = local_meta(&path).await? {
                if m.directory || m.link {
                    return Err("부분 파일이 일반 파일이 아닙니다.".into());
                }
                tokio::fs::remove_file(path).await.map_err(sftp::failure)?;
            }
        }
        Ok(())
    }
    // A crash between rename and checkpoint is resolved by full byte comparison,
    // never by treating size equality as proof of completion.
    async fn equal_destination(&self, p: &Plan, remote: &str, local: &Path) -> Result<bool> {
        use tokio::io::AsyncReadExt;
        let original = p.source.as_ref().ok_or("원본 기록 없음")?;
        if &self.source(p).await? != original {
            return Err("원본이 변경되어 복구를 중단했습니다.".into());
        }
        let target = if p.upload {
            self.remote_meta(remote).await?
        } else {
            local_meta(local).await?
        };
        let Some(m) = target else { return Ok(false) };
        if m.link || m.directory || m.source.as_ref().map(|s| s.size) != Some(original.size) {
            return Ok(false);
        }
        let local_file = if p.upload { &p.local } else { local };
        let remote_file = if p.upload { remote } else { &p.remote };
        local_guard(local_file).await?;
        self.remote_guard(remote_file, true).await?;
        let mut a = tokio::fs::File::open(local_file)
            .await
            .map_err(sftp::failure)?;
        let equal = if let Some(s) = &self.sftp {
            let mut b = s.open(remote_file).await.map_err(sftp::failure)?;
            sftp::prefix(&mut a, &mut b, original.size).await.is_ok()
                && b.read(&mut [0]).await.map_err(sftp::failure)? == 0
        } else {
            let mut ftp = self.ftp.as_ref().unwrap().open().await?;
            let mut b = ftp
                .retr_as_stream(remote_file)
                .await
                .map_err(sftp::failure)?;
            let equal = sftp::prefix(&mut a, &mut b, original.size).await.is_ok();
            if equal && b.read(&mut [0]).await.map_err(sftp::failure)? == 0 {
                b.finish().await.map_err(sftp::failure)?;
                true
            } else {
                let _ = ftp.abort(b).await;
                false
            }
        };
        Ok(equal && &self.source(p).await? == original)
    }
    async fn commit(&self, n: &Node) -> Result<()> {
        local_guard(&n.local).await?;
        self.remote_guard(&n.remote, true).await?;
        let target = self.target(n).await?;
        let backup = format!("{}.dachsterm-{}.backup", n.remote, n.plan.view.id);
        let recovering_backup = if self.ftp.is_some() && n.plan.upload && n.target.is_some() {
            let m = self.remote_meta(&backup).await?;
            if m.as_ref().is_some_and(|m| m.link || m.directory)
                || m.as_ref().is_some_and(|m| m.source != n.target)
            {
                return Err("덮어쓰기 백업이 변경되었습니다. 자동 정리를 중단합니다.".into());
            }
            m.is_some()
        } else {
            false
        };
        if target.as_ref().is_some_and(|m| m.link || m.directory)
            || !(target.as_ref().and_then(|m| m.source.as_ref()) == n.target.as_ref()
                || target.is_none() && recovering_backup)
        {
            return Err("전송 중 대상이 변경되었습니다. 부분 파일을 보존했습니다.".into());
        }
        if n.plan.upload {
            if let Some(s) = &self.sftp {
                if n.target.is_some() {
                    // OpenSSH atomic replace extension; unsupported servers fail safely.
                    let h = self.connections.handle(&self.id)?;
                    let channel = h.channel_open_session().await.map_err(sftp::failure)?;
                    channel
                        .request_subsystem(true, "sftp")
                        .await
                        .map_err(sftp::failure)?;
                    let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
                    let version = raw.init().await.map_err(sftp::failure)?;
                    if !version.extensions.contains_key("posix-rename@openssh.com") {
                        return Err("서버가 안전한 덮어쓰기(posix-rename)를 지원하지 않습니다. 이름 변경을 사용하세요.".into());
                    }
                    let mut data = Vec::new();
                    for path in [&n.plan.remote, &n.remote] {
                        data.extend_from_slice(&(path.len() as u32).to_be_bytes());
                        data.extend_from_slice(path.as_bytes());
                    }
                    match raw
                        .extended("posix-rename@openssh.com", data)
                        .await
                        .map_err(sftp::failure)?
                    {
                        russh_sftp::protocol::Packet::Status(s)
                            if s.status_code == russh_sftp::protocol::StatusCode::Ok => {}
                        _ => return Err("SFTP 덮어쓰기 실패 · 부분 파일 보존".into()),
                    }
                } else {
                    s.rename(&n.plan.remote, &n.remote)
                        .await
                        .map_err(sftp::failure)?;
                }
            } else {
                let mut ftp = self.ftp.as_ref().unwrap().open().await?;
                if n.target.is_some() && !recovering_backup {
                    ftp.rename(&n.remote, &backup)
                        .await
                        .map_err(|_| "FTP 기존 파일 백업 실패 · 기존 파일 보존")?;
                }
                if ftp.rename(&n.plan.remote, &n.remote).await.is_err() {
                    if n.target.is_some() {
                        let _ = ftp.rename(&backup, &n.remote).await;
                    }
                    return Err("FTP 교체 실패 · 부분 파일/기존 파일 백업 보존 · 같은 서버에서 재시도하세요.".into());
                }
                if n.target.is_some() {
                    ftp.rm(&backup).await.map_err(
                        |_| "전송 완료 후 기존 파일 백업 정리 실패 · 재개하면 확인 후 정리합니다.",
                    )?;
                }
                let _ = ftp.quit().await;
            }
        } else if n.target.is_some() {
            tokio::fs::rename(&n.plan.local, &n.local)
                .await
                .map_err(sftp::failure)?;
        } else {
            tokio::fs::hard_link(&n.plan.local, &n.local)
                .await
                .map_err(sftp::failure)?;
            tokio::fs::remove_file(&n.plan.local)
                .await
                .map_err(sftp::failure)?;
        }
        Ok(())
    }
    async fn finish_backup(&self, n: &Node, completed: bool) -> Result<()> {
        if self.ftp.is_none() || !n.plan.upload || n.target.is_none() {
            return Ok(());
        }
        let backup = format!("{}.dachsterm-{}.backup", n.remote, n.plan.view.id);
        self.remote_guard(&backup, true).await?;
        if let Some(m) = self.remote_meta(&backup).await? {
            if m.directory || m.link || m.source != n.target {
                return Err("기존 파일 백업이 변경되어 자동 정리를 중단합니다.".into());
            }
            let mut ftp = self.ftp.as_ref().unwrap().open().await?;
            if completed {
                ftp.rm(&backup).await.map_err(sftp::failure)?;
            } else if self.remote_meta(&n.remote).await?.is_none() {
                ftp.rename(&backup, &n.remote)
                    .await
                    .map_err(|_| "기존 파일 백업 복원 실패 · 큐와 백업을 보존합니다.")?;
            } else {
                return Err(
                    "기존 파일 백업이 남아 있습니다. 먼저 재개하여 교체 결과를 확인하세요.".into(),
                );
            }
            let _ = ftp.quit().await;
        }
        Ok(())
    }
}
async fn local_meta(path: &Path) -> Result<Option<Metadata>> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(m) => Ok(Some(Metadata {
            directory: m.is_dir(),
            link: linked(&m) || !(m.is_file() || m.is_dir()),
            source: if m.is_file() { Some(stamp(&m)?) } else { None },
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(sftp::failure(e)),
    }
}
fn check_cancel(rx: &watch::Receiver<bool>) -> Result<()> {
    if *rx.borrow() {
        Err("중단 · 부분 파일과 생성한 빈 폴더 보존".into())
    } else {
        Ok(())
    }
}
fn staging(n: &mut Node, legacy: bool) {
    if legacy {
        return;
    }
    if n.plan.upload {
        let parent = n.remote.rsplit_once('/').unwrap().0;
        n.plan.remote = format!("{parent}/.dachsterm-{}.ready", n.plan.view.id);
    } else {
        n.plan.local = n
            .local
            .with_file_name(format!(".dachsterm-{}.ready", n.plan.view.id));
    }
}
impl Transfers {
    async fn scan(
        &self,
        b: &Backend<'_>,
        r: &Record,
        rx: &watch::Receiver<bool>,
    ) -> Result<Vec<Node>> {
        let mut stack = vec![(r.root.local.clone(), r.root.remote.clone(), 0)];
        let mut nodes = Vec::new();
        let mut names = HashSet::new();
        let mut budget = 0usize;
        while let Some((local, remote, depth)) = stack.pop() {
            check_cancel(rx)?;
            if depth > MAX_DEPTH || nodes.len() + stack.len() >= MAX_NODES {
                return Err("폴더 탐색 상한: 10,000개 항목 / 깊이 64".into());
            }
            local_guard(&local).await?;
            b.remote_guard(&remote, !r.root.upload).await?;
            let meta = if r.root.upload {
                local_meta(&local).await?
            } else {
                b.remote_meta(&remote).await?
            }
            .ok_or("전송 원본이 없습니다.")?;
            if meta.link {
                return Err(
                    "링크·junction·특수 파일은 전송하지 않습니다. 선택에서 제외하세요.".into(),
                );
            }
            let mut p = r.root.clone();
            p.local = local.clone();
            p.remote = remote.clone();
            p.source = if meta.directory {
                None
            } else {
                Some(b.source(&p).await?)
            };
            p.view.id = if nodes.is_empty() {
                r.root.view.id.clone()
            } else {
                uuid::Uuid::new_v4().to_string()
            };
            let key = target_key(&p);
            if !names.insert(key) {
                return Err("중복 목적지 또는 대소문자 충돌을 발견했습니다.".into());
            }
            budget += local.as_os_str().len() + remote.len() + 512;
            if budget > 4 * 1024 * 1024 {
                return Err("폴더 탐색 경로 메모리 상한 4MiB".into());
            }
            let mut n = Node {
                plan: p,
                directory: meta.directory,
                state: "pending".into(),
                local: local.clone(),
                remote: remote.clone(),
                target: None,
                prepared: false,
                error: String::new(),
            };
            staging(&mut n, r.legacy);
            nodes.push(n);
            if meta.directory {
                let children = if r.root.upload {
                    let mut dir = tokio::fs::read_dir(&local).await.map_err(sftp::failure)?;
                    let mut children = Vec::new();
                    while let Some(e) = dir.next_entry().await.map_err(sftp::failure)? {
                        check_cancel(rx)?;
                        if nodes.len() + stack.len() + children.len() >= MAX_NODES {
                            return Err("폴더 탐색 항목 상한 10,000".into());
                        }
                        let name = e
                            .file_name()
                            .into_string()
                            .map_err(|_| "UTF-8 파일 이름이 필요합니다.")?;
                        component(&name)?;
                        children.push(name);
                    }
                    children
                } else {
                    b.listing(&remote)
                        .await?
                        .entries
                        .into_iter()
                        .map(|e| e.name)
                        .collect()
                };
                if nodes.len() + stack.len() + children.len() > MAX_NODES {
                    return Err("폴더 탐색 항목 상한 10,000".into());
                }
                let mut children = children;
                children.sort();
                for name in children.into_iter().rev() {
                    component(&name)?;
                    stack.push((
                        local.join(&name),
                        format!("{}/{name}", remote.trim_end_matches('/')),
                        depth + 1,
                    ));
                }
            }
            if nodes.len() % 32 == 0 {
                tokio::task::yield_now().await;
            }
        }
        Ok(nodes)
    }
    async fn execute(
        &self,
        connections: &Connections,
        id: &str,
        cancelled: watch::Receiver<bool>,
        committing: &std::sync::atomic::AtomicBool,
    ) -> Result<()> {
        let mut r = self.record(id)?;
        check_cancel(&cancelled)?;
        let b = Backend::open(connections, &r.root.view.connection_id).await?;
        if !r.scanned {
            let nodes = self.scan(&b, &r, &cancelled).await?;
            let total = nodes
                .iter()
                .filter_map(|n| n.plan.source.as_ref())
                .try_fold(0u64, |a, s| a.checked_add(s.size))
                .ok_or("전체 파일 크기 범위 초과")?;
            self.update(id, |r| {
                r.nodes = nodes;
                r.scanned = true;
                r.root.view.files = r.nodes.len();
                r.root.view.total = total;
                r.root.view.status = "running".into();
            })?;
            r = self.record(id)?;
        }
        for index in 0..r.nodes.len() {
            check_cancel(&cancelled)?;
            let mut n = r.nodes[index].clone();
            n.plan.view.connection_id = r.root.view.connection_id.clone();
            if matches!(n.state.as_str(), "completed" | "skipped") {
                continue;
            }
            n.error.clear();
            {
                let mut s = self.state.lock().unwrap();
                if let Some(j) = s.jobs.iter_mut().find(|j| j.record.root.view.id == id) {
                    j.current = Some(index);
                    j.record.nodes[index].error.clear();
                    j.record.root.view.current = if n.plan.upload {
                        n.remote.clone()
                    } else {
                        n.local.to_string_lossy().into_owned()
                    };
                }
            }
            local_guard(&n.local).await?;
            local_guard(&n.plan.local).await?;
            b.remote_guard(&n.remote, true).await?;
            b.remote_guard(&n.plan.remote, true).await?;
            if !n.prepared {
                let target = b.target(&n).await?;
                if target.as_ref().is_some_and(|m| m.link) {
                    return Err("대상 링크는 변경하지 않습니다.".into());
                }
                if let Some(m) = target {
                    if n.directory && m.directory { /* merge, preserve existing contents */
                    } else if r.policy == "skip" {
                        for child in &mut r.nodes[index..] {
                            if child.local == n.local
                                || n.directory && child.local.starts_with(&n.local)
                            {
                                child.state = "skipped".into();
                            }
                        }
                        self.update(id, |record| {
                            record.nodes = r.nodes.clone();
                            refresh(record);
                        })?;
                        continue;
                    } else if r.policy == "rename" {
                        let old_local = n.local.clone();
                        let old_remote = n.remote.clone();
                        let suffix = format!(" (DachsTerm {})", &n.plan.view.id[..8]);
                        if n.plan.upload {
                            n.remote = format!("{}{suffix}", n.remote);
                        } else {
                            let name = n
                                .local
                                .file_name()
                                .and_then(|s| s.to_str())
                                .ok_or("파일 이름 오류")?;
                            n.local = n.local.with_file_name(format!("{name}{suffix}"));
                        }
                        // Rebase destination descendants without changing their source paths.
                        for child in &mut r.nodes[index..] {
                            if n.plan.upload {
                                if child.remote == old_remote {
                                    child.remote = n.remote.clone();
                                } else if let Some(rest) =
                                    child.remote.strip_prefix(&(old_remote.clone() + "/"))
                                {
                                    child.remote = format!("{}/{rest}", n.remote);
                                }
                            } else if let Ok(rest) = child.local.strip_prefix(&old_local) {
                                child.local = n.local.join(rest);
                            }
                            staging(child, r.legacy);
                        }
                        staging(&mut n, r.legacy);
                        if b.target(&n).await?.is_some() {
                            return Err(
                                "자동 변경 이름도 이미 있습니다. 대상 이름을 바꾸세요.".into()
                            );
                        }
                    } else if r.policy == "overwrite" && !n.directory && !m.directory {
                        n.target = m.source;
                    } else {
                        return Err("대상 항목이 이미 있거나 파일/폴더 종류가 다릅니다.".into());
                    }
                }
                n.prepared = true;
                r.nodes[index] = n.clone();
                self.update(id, |record| record.nodes = r.nodes.clone())?;
            }
            if n.directory {
                match b.target(&n).await? {
                    Some(m) if m.directory && !m.link => {}
                    None => b.mkdir(&n).await?,
                    _ => return Err("대상 폴더가 변경되었습니다.".into()),
                }
            } else {
                if n.plan.source.is_none() {
                    n.plan.source = Some(b.source(&n.plan).await?);
                    self.update(id, |r| r.nodes[index] = n.clone())?;
                }
                if b.source(&n.plan).await? != *n.plan.source.as_ref().unwrap() {
                    return Err(
                        "원본의 크기 또는 수정 시각이 변경되어 이어쓰기를 중단했습니다.".into(),
                    );
                }
                let final_recovered = n.state == "committing"
                    && b.equal_destination(&n.plan, &n.remote, &n.local).await?;
                if final_recovered {
                    b.finish_backup(&n, true).await?;
                    b.remove_part(&n.plan, false).await?;
                    if !r.legacy {
                        b.remove_part(&n.plan, true).await?;
                    }
                }
                if !final_recovered {
                    let ready = if r.legacy {
                        false
                    } else {
                        b.equal_destination(&n.plan, &n.plan.remote, &n.plan.local)
                            .await?
                    };
                    if !ready {
                        if n.plan.upload {
                            b.remote_guard(
                                &format!("{}.dachsterm-{}.part", n.plan.remote, n.plan.view.id),
                                true,
                            )
                            .await?;
                        } else {
                            local_guard(
                                &n.plan
                                    .local
                                    .with_file_name(format!(".dachsterm-{}.part", n.plan.view.id)),
                            )
                            .await?;
                        }
                        // Mark intent before a leaf commit so crash recovery is deterministic.
                        n.state = if r.legacy {
                            "committing"
                        } else {
                            "transferring"
                        }
                        .into();
                        self.update(id, |r| r.nodes[index] = n.clone())?;
                        let base: u64 = r
                            .nodes
                            .iter()
                            .filter(|n| matches!(n.state.as_str(), "completed" | "skipped"))
                            .filter_map(|n| n.plan.source.as_ref())
                            .map(|s| s.size)
                            .sum();
                        let progress = |done, total| {
                            let mut s = self.state.lock().unwrap();
                            if let Some(j) = s.jobs.iter_mut().find(|j| j.record.root.view.id == id)
                            {
                                let v = &mut j.record.root.view;
                                v.done = base + done;
                                v.current = if n.plan.upload {
                                    n.remote.clone()
                                } else {
                                    n.local.to_string_lossy().into_owned()
                                };
                                v.current_done = done;
                                v.current_total = total;
                            }
                        };
                        let result = if let Some(f) = &b.ftp {
                            crate::ftp::transfer(
                                f,
                                &n.plan,
                                progress,
                                committing,
                                cancelled.clone(),
                            )
                            .await
                        } else {
                            sftp::resumed(b.sftp.as_ref().unwrap(), &n.plan, progress, committing)
                                .await
                        };
                        committing.store(false, std::sync::atomic::Ordering::SeqCst);
                        result?;
                    }
                    check_cancel(&cancelled)?;
                    if !r.legacy {
                        n.state = "committing".into();
                        self.update(id, |r| r.nodes[index] = n.clone())?;
                        committing.store(true, std::sync::atomic::Ordering::SeqCst);
                        let result = b.commit(&n).await;
                        committing.store(false, std::sync::atomic::Ordering::SeqCst);
                        result?;
                    }
                }
            }
            n.state = "completed".into();
            r.nodes[index] = n.clone();
            self.update(id, |r| {
                r.nodes[index] = n;
                refresh(r);
            })?;
        }
        Ok(())
    }
    pub async fn discard(
        &self,
        connections: &Connections,
        id: &str,
        connection: &str,
    ) -> Result<()> {
        let r = {
            let mut s = self.state.lock().unwrap();
            let j = s
                .jobs
                .iter_mut()
                .find(|j| j.record.root.view.id == id)
                .ok_or("전송 작업 없음")?;
            if active(&j.record.root.view.status) || j.record.root.view.status == "queued" {
                return Err("먼저 전송을 일시 중지하세요.".into());
            }
            let r = j.record.clone();
            j.record.root.view.status = "discarding".into();
            r
        };
        let result: Result<()> = async {
            if r.root.upload && r.root.view.status != "completed" {
                check_connection(connections, &r.root, connection, &r.root.view.profile_id)?;
            }
            if r.nodes
                .iter()
                .any(|n| !n.directory && n.state != "completed" && n.state != "skipped")
            {
                if r.root.upload {
                    let b = Backend::open(connections, connection).await?;
                    for n in &r.nodes {
                        if !n.directory && !matches!(n.state.as_str(), "completed" | "skipped") {
                            b.finish_backup(n, false).await?;
                            b.remove_part(&n.plan, false).await?;
                            if !r.legacy {
                                b.remove_part(&n.plan, true).await?;
                            }
                        }
                    }
                } else {
                    for n in &r.nodes {
                        if !n.directory && !matches!(n.state.as_str(), "completed" | "skipped") {
                            let mut paths = vec![
                                n.plan
                                    .local
                                    .with_file_name(format!(".dachsterm-{}.part", n.plan.view.id)),
                            ];
                            if !r.legacy {
                                paths.push(n.plan.local.clone());
                            }
                            for path in paths {
                                local_guard(&path).await?;
                                match tokio::fs::remove_file(path).await {
                                    Ok(()) => {}
                                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                                    Err(e) => return Err(sftp::failure(e)),
                                }
                            }
                        }
                    }
                }
            }
            if let Some(store) = self.store.lock().unwrap().as_ref() {
                store
                    .0
                    .lock()
                    .unwrap()
                    .execute("DELETE FROM settings WHERE key=?", [format!("queue:{id}")])
                    .map_err(crate::storage::db_error)?;
            }
            Ok(())
        }
        .await;
        let mut s = self.state.lock().unwrap();
        if result.is_ok() {
            s.jobs.retain(|j| j.record.root.view.id != id);
        } else if let Some(j) = s.jobs.iter_mut().find(|j| j.record.root.view.id == id) {
            j.record = r;
        }
        result
    }
}
fn refresh(r: &mut Record) {
    let v = &mut r.root.view;
    v.files = r.nodes.len();
    v.finished = r.nodes.iter().filter(|n| n.state == "completed").count();
    v.skipped = r.nodes.iter().filter(|n| n.state == "skipped").count();
    v.done = r
        .nodes
        .iter()
        .filter(|n| matches!(n.state.as_str(), "completed" | "skipped"))
        .filter_map(|n| n.plan.source.as_ref())
        .map(|s| s.size)
        .sum();
    v.current_done = 0;
    v.current_total = 0;
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(path: &Path, status: &str) -> Record {
        let p = Plan {
            view: Transfer {
                id: uuid::Uuid::new_v4().to_string(),
                status: status.into(),
                ..Default::default()
            },
            local: path.join("source"),
            remote: "/tmp/source".into(),
            upload: true,
            destination: "server".into(),
            source: None,
        };
        Record {
            version: 1,
            root: p,
            policy: "skip".into(),
            scanned: false,
            nodes: vec![],
            order: 1,
            legacy: false,
        }
    }
    #[test]
    fn rejects_path_escape_and_windows_aliases() {
        for name in ["..", ".", "a/b", "a\\b", "a:stream", "x\n"] {
            assert!(component(name).is_err(), "{name:?}");
        }
        assert!(component("한글 공백.txt").is_ok());
        #[cfg(windows)]
        for name in ["CON", "NUL.txt", "COM1.txt", "file.", "file "] {
            assert!(component(name).is_err());
        }
        for path in ["relative", "/a/../b", "/a//b"] {
            assert!(remote_path(path).is_err());
        }
        assert!(overlaps("server:/a", "server:/a/b"));
        assert!(!overlaps("server:/a", "server:/ab"));
    }
    #[test]
    fn persistence_recovery_never_autostarts_and_keeps_results() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("db")).unwrap());
        let q = Transfers::default();
        q.recover(store.clone()).unwrap();
        for status in [
            "queued",
            "scanning",
            "running",
            "failed",
            "completed",
            "cancelled",
        ] {
            q.persist(&record(dir.path(), status)).unwrap();
        }
        let recovered = Transfers::default();
        recovered.recover(store).unwrap();
        let views = recovered.list();
        assert_eq!(views.len(), 6);
        assert_eq!(views.iter().filter(|v| v.status == "paused").count(), 4);
        assert!(recovered.state.lock().unwrap().active.is_empty());
    }
    #[test]
    fn queue_order_pause_cancel_and_write_failure() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("db")).unwrap());
        let q = Transfers::default();
        q.recover(store.clone()).unwrap();
        let mut ids = Vec::new();
        for i in 0..3 {
            let mut r = record(dir.path(), "queued");
            r.order = i;
            ids.push(r.root.view.id.clone());
            q.state.lock().unwrap().jobs.push(Job {
                record: r,
                cancel: watch::channel(false).0,
                requested: String::new(),
                current: None,
            });
        }
        q.control(&[ids[2].clone()], "first").unwrap();
        assert_eq!(q.list()[0].id, ids[2]);
        q.control(&ids[..2], "pause").unwrap();
        assert_eq!(q.list().iter().filter(|v| v.status == "paused").count(), 2);
        q.control(&ids[..2], "cancel").unwrap();
        assert_eq!(
            q.list().iter().filter(|v| v.status == "cancelled").count(),
            2
        );
        store
            .0
            .lock()
            .unwrap()
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert!(q.control(&[ids[2].clone()], "pause").is_err());
        assert_eq!(q.list()[0].status, "queued");
    }
    #[tokio::test]
    async fn refuses_link_ancestor() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real");
        tokio::fs::create_dir(&target).await.unwrap();
        let link = dir.path().join("link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&target, &link).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(local_guard(&link.join("file")).await.is_err());
        // Without this the test also passes when every path is refused, as on macOS,
        // where the temporary directory itself sits under the system link /var.
        local_guard(&target.join("file")).await.unwrap();
    }
    #[test]
    fn invalid_version_does_not_erase_queue() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("db")).unwrap());
        let mut r = record(dir.path(), "running");
        r.version = 99;
        store
            .set_setting(
                &format!("queue:{}", r.root.view.id),
                &serde_json::to_string(&r).unwrap(),
            )
            .unwrap();
        assert!(Transfers::default().recover(store.clone()).is_err());
        assert!(
            store
                .setting(&format!("queue:{}", r.root.view.id))
                .unwrap()
                .contains("99")
        );
    }
}
