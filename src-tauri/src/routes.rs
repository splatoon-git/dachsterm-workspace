//! A route is owned by one terminal connection; hops are never pooled or forwarded to agents.
use crate::storage::{Profile, Result};
use std::collections::HashSet;

pub const MAX_HOPS: usize = 4;

pub fn resolve(target: &Profile, profiles: &[Profile]) -> Result<Vec<Profile>> {
    fn visit(
        p: &Profile,
        all: &[Profile],
        seen: &mut HashSet<String>,
        out: &mut Vec<Profile>,
    ) -> Result<()> {
        if p.protocol != "ssh" && !p.jump_ids.is_empty() {
            return Err("SSH 세션만 경유 설정을 사용할 수 있습니다.".into());
        }
        if !seen.insert(p.id.clone()) {
            return Err("경유 경로에 자기 참조·순환·중복 홉이 있습니다.".into());
        }
        if seen.len() > MAX_HOPS + 1 {
            return Err("점프 호스트는 최종 서버 외 최대 4홉입니다.".into());
        }
        for id in &p.jump_ids {
            let hop = all
                .iter()
                .find(|h| &h.id == id)
                .ok_or("경유 프로필이 없습니다.")?;
            if hop.protocol != "ssh" {
                return Err("경유지는 SSH 프로필이어야 합니다.".into());
            }
            visit(hop, all, seen, out)?;
        }
        out.push(p.clone());
        Ok(())
    }
    let mut result = Vec::new();
    visit(target, profiles, &mut HashSet::new(), &mut result)?;
    Ok(result)
}

pub fn describe<'a>(route: impl Iterator<Item = &'a Profile>) -> String {
    route
        .map(|h| format!("{} ({}:{})", h.name, h.host, h.port))
        .collect::<Vec<_>>()
        .join(" → ")
}
pub fn validate(profiles: &[Profile]) -> Result<()> {
    for p in profiles {
        resolve(p, profiles)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordered_nested_routes_reject_cycles_missing_duplicate_and_limit() {
        let mut all: Vec<_> = (0..6)
            .map(|i| {
                let mut p = crate::storage::tests::profile();
                p.id = i.to_string();
                p
            })
            .collect();
        all[2].jump_ids = vec!["0".into(), "1".into()];
        assert_eq!(
            resolve(&all[2], &all)
                .unwrap()
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["0", "1", "2"]
        );
        all[0].jump_ids = vec!["2".into()];
        assert!(validate(&all).is_err());
        all[0].jump_ids = vec!["missing".into()];
        assert!(validate(&all).is_err());
        all[0].jump_ids.clear();
        all[2].jump_ids = vec!["0".into(), "0".into()];
        assert!(validate(&all).is_err());
        for (i, profile) in all.iter_mut().enumerate().skip(1) {
            profile.jump_ids = vec![(i - 1).to_string()];
        }
        assert!(resolve(&all[4], &all).is_ok());
        assert!(resolve(&all[5], &all).is_err());
    }
}
