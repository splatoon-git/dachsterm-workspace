//! Include discovery lists paths first. Only explicitly approved regular files are read.
use crate::storage::Result;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
#[derive(Serialize)]
pub struct Plan {
    pub token: String,
    pub files: Vec<String>,
}
struct Pending {
    root: PathBuf,
    source: PathBuf,
    files: Vec<String>,
    encoding: String,
    created: Instant,
}
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static PLANS: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    PLANS.get_or_init(Default::default)
}
fn regular(root: &Path, path: &Path) -> Result<PathBuf> {
    let p = path
        .canonicalize()
        .map_err(|_| "Include 파일 경로를 확인할 수 없습니다.")?;
    if !p.starts_with(root)
        || std::fs::symlink_metadata(path)
            .map_err(|_| "Include 파일 확인 실패")?
            .file_type()
            .is_symlink()
        || !p.is_file()
    {
        return Err("Include 경로 이탈·링크·일반 파일 아님".into());
    }
    Ok(p)
}
pub fn plan(source: &Path, encoding: &str) -> Result<Plan> {
    let root = source
        .parent()
        .ok_or("설정 루트 오류")?
        .canonicalize()
        .map_err(|_| "설정 루트 오류")?;
    let source = regular(&root, source)?;
    let mut files = Vec::new();
    let mut visited = 0;
    fn list(
        root: &Path,
        dir: &Path,
        depth: usize,
        files: &mut Vec<String>,
        visited: &mut usize,
    ) -> Result<()> {
        if depth > 8 {
            return Err("Include 탐색 깊이 8단계 초과".into());
        }
        for e in std::fs::read_dir(dir).map_err(|_| "Include 목록 읽기 실패")? {
            *visited += 1;
            if *visited > 1000 {
                return Err("Include 목록 1000개 초과".into());
            }
            let e = e.map_err(|_| "Include 목록 읽기 실패")?;
            let kind = e.file_type().map_err(|_| "파일 종류 오류")?;
            if kind.is_symlink() {
                continue;
            }
            let p = e.path().canonicalize().map_err(|_| "파일 경로 오류")?;
            if !p.starts_with(root) {
                return Err("설정 루트 밖의 링크는 허용하지 않습니다.".into());
            }
            if kind.is_dir() {
                list(root, &p, depth + 1, files, visited)?;
            } else if kind.is_file() {
                files.push(
                    p.strip_prefix(root)
                        .map_err(|_| "설정 루트 오류")?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
        Ok(())
    }
    list(&root, &root, 0, &mut files, &mut visited)?;
    files.sort();
    let token = uuid::Uuid::new_v4().to_string();
    let mut plans = pending().lock().unwrap();
    plans.retain(|_, p| p.created.elapsed() < Duration::from_secs(600));
    if plans.len() >= 4 {
        plans.clear();
    }
    plans.insert(
        token.clone(),
        Pending {
            root,
            source,
            files: files.clone(),
            encoding: encoding.into(),
            created: Instant::now(),
        },
    );
    Ok(Plan { token, files })
}
fn expand(plan: &Pending, approved: &HashSet<String>) -> Result<String> {
    fn read(
        plan: &Pending,
        path: &Path,
        approved: &HashSet<String>,
        stack: &mut HashSet<PathBuf>,
        bytes: &mut usize,
        reads: &mut usize,
    ) -> Result<String> {
        let path = regular(&plan.root, path)?;
        *reads += 1;
        if *reads > 64 || stack.len() >= 8 || !stack.insert(path.clone()) {
            return Err("Include 순환·깊이·64파일 읽기 제한".into());
        }
        let data = zeroize::Zeroizing::new(crate::maintenance::read_config(&path)?);
        *bytes += data.len();
        if *bytes > crate::maintenance::MAX_CONFIG_BYTES {
            return Err("Include 전체 2MiB 제한".into());
        }
        let text = zeroize::Zeroizing::new(crate::session_transfer::decode(&data, &plan.encoding)?);
        let mut out = String::new();
        for line in text.lines() {
            let w = crate::session_transfer::words(line)?;
            if w.first().is_some_and(|w| w.eq_ignore_ascii_case("include")) {
                if w.len() < 2 {
                    return Err("Include 파일 누락".into());
                }
                for pattern in &w[1..] {
                    if pattern.starts_with('/')
                        || pattern.contains(['\\', ':', '~', '$', '%'])
                        || pattern.split('/').any(|v| v == ".." || v == ".")
                    {
                        return Err("Include는 선택한 루트 안의 상대 경로만 지원합니다.".into());
                    }
                    let matched: Vec<_> = plan
                        .files
                        .iter()
                        .filter(|name| crate::session_transfer::glob(pattern, name))
                        .collect();
                    if matched.is_empty() {
                        return Err("Include 일치 파일이 없습니다. 적용을 중단했습니다.".into());
                    }
                    for name in matched {
                        if !approved.contains(name) {
                            return Err(format!("Include 목록에서 읽기 승인이 필요합니다: {name}"));
                        }
                        out.push_str(&read(
                            plan,
                            &plan.root.join(name),
                            approved,
                            stack,
                            bytes,
                            reads,
                        )?);
                    }
                }
            } else {
                out.push_str(line);
                out.push('\n');
            }
        }
        stack.remove(&path);
        Ok(out)
    }
    read(
        plan,
        &plan.source,
        approved,
        &mut HashSet::new(),
        &mut 0,
        &mut 0,
    )
}
#[tauri::command]
pub fn config_include_preview(
    token: String,
    files: Vec<String>,
) -> Result<crate::session_transfer::Preview> {
    let mut plans = pending().lock().unwrap();
    let plan = plans
        .get(&token)
        .ok_or("Include 미리보기가 만료되었습니다.")?;
    if plan.created.elapsed() > Duration::from_secs(600) {
        return Err("Include 미리보기가 만료되었습니다.".into());
    }
    if files.iter().any(|f| !plan.files.contains(f)) {
        return Err("목록에 없는 Include 파일".into());
    }
    let text = zeroize::Zeroizing::new(expand(plan, &files.into_iter().collect())?);
    let result = crate::session_transfer::parse(text.as_bytes(), "openssh", "utf-8")?;
    plans.remove(&token);
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn include_requires_approval_and_blocks_cycle_escape() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        std::fs::write(root.join("config"), "Include child\n").unwrap();
        std::fs::write(root.join("child"), "Host lab\n User tester\n").unwrap();
        let p = Pending {
            source: root.join("config"),
            root: root.clone(),
            files: vec!["config".into(), "child".into()],
            encoding: "utf-8".into(),
            created: Instant::now(),
        };
        assert!(expand(&p, &HashSet::new()).is_err());
        let allowed = HashSet::from(["child".into(), "config".into()]);
        assert!(expand(&p, &allowed).unwrap().contains("Host lab"));
        std::fs::write(root.join("child"), "Include config").unwrap();
        assert!(expand(&p, &allowed).is_err());
        std::fs::write(root.join("config"), "Include ../outside").unwrap();
        assert!(expand(&p, &allowed).is_err());
    }
}
