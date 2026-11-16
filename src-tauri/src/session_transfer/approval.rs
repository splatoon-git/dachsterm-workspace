//! ProxyCommand approval on import (CG.2). A proxy command runs a program on this PC, so a file
//! alone never saves one: the preview lists each command in full, and only the sessions the user
//! ticks are saved, with their command byte for byte as it was shown. Like the Include plan, the
//! approval is a one-time token that lasts ten minutes.
use super::Preview;
use crate::{AppState, settings::Bundle, storage::Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::State;

const LIFETIME: Duration = Duration::from_secs(600);
const NOT_APPROVED: &str =
    "승인하지 않은 프록시 명령이 있습니다. 미리보기에서 명령을 확인하고 해당 세션을 선택하세요.";
const EXPIRED: &str = "프록시 명령 승인이 만료되었습니다. 파일을 다시 선택하세요.";

/// A preview, with the commands its sessions would run.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewed {
    #[serde(flatten)]
    preview: Preview,
    command_plan: Option<CommandPlan>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandPlan {
    token: String,
    sessions: Vec<Planned>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Planned {
    id: String,
    name: String,
    command: String,
}
/// The sessions whose command the user ticked on the preview.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approved {
    token: String,
    ids: Vec<String>,
}

/// Token → the commands shown and when.
type Plans = Mutex<HashMap<String, (Vec<Planned>, Instant)>>;
fn plans() -> &'static Plans {
    static PLANS: OnceLock<Plans> = OnceLock::new();
    PLANS.get_or_init(Default::default)
}

fn commands(bundle: &Bundle) -> impl Iterator<Item = (&str, &str, &str)> {
    bundle.profiles.iter().filter_map(|p| {
        let command = p.proxy.as_ref()?.command()?;
        Some((p.id.as_str(), p.name.as_str(), command))
    })
}

/// Lists the preview's commands and remembers them for `take`.
pub fn review(preview: Preview) -> Reviewed {
    let sessions: Vec<Planned> = commands(&preview.bundle)
        .map(|(id, name, command)| Planned {
            id: id.into(),
            name: name.into(),
            command: command.into(),
        })
        .collect();
    let command_plan = (!sessions.is_empty()).then(|| {
        let token = uuid::Uuid::new_v4().to_string();
        let mut plans = plans().lock().unwrap();
        plans.retain(|_, (_, created)| created.elapsed() < LIFETIME);
        plans.insert(token.clone(), (sessions.clone(), Instant::now()));
        CommandPlan { token, sessions }
    });
    Reviewed {
        preview,
        command_plan,
    }
}

/// Uses up the approval for the commands in `bundle`: each must be ticked and the same as shown.
pub fn take(bundle: &Bundle, approved: Option<&Approved>) -> Result<()> {
    let wanted: Vec<_> = commands(bundle).collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let approved = approved.ok_or(NOT_APPROVED)?;
    let (planned, created) = plans()
        .lock()
        .unwrap()
        .remove(&approved.token)
        .ok_or(EXPIRED)?;
    if created.elapsed() >= LIFETIME {
        return Err(EXPIRED.into());
    }
    let shown = |id: &str, command: &str| {
        planned
            .iter()
            .any(|p| p.id == id && p.command.as_bytes() == command.as_bytes())
    };
    if wanted
        .iter()
        .any(|(id, _, command)| !approved.ids.iter().any(|a| a == id) || !shown(id, command))
    {
        return Err(NOT_APPROVED.into());
    }
    Ok(())
}

#[tauri::command]
pub fn config_apply(
    state: State<AppState>,
    data: String,
    merges: Option<Vec<crate::settings::Merge>>,
    approved: Option<Approved>,
) -> Result<usize> {
    if data.len() > crate::maintenance::MAX_CONFIG_BYTES {
        return Err("설정 파일은 2MiB 이하여야 합니다.".into());
    }
    let mut bundle: Bundle =
        serde_json::from_str(&data).map_err(|_| "DachsTerm JSON 스키마 오류")?;
    crate::settings::validate_import(&bundle)?;
    take(&bundle, approved.as_ref())?;
    let _guard = state.mutation.lock().unwrap();
    crate::maintenance::snapshot(&state.store, &state.directory)?;
    crate::settings::apply_bundle(&state.store, &mut bundle, &merges.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Proxy;

    fn preview(commands: &[(&str, &str)]) -> Preview {
        let mut preview = Preview::new();
        for (id, command) in commands {
            let mut p = crate::storage::tests::profile();
            p.id = (*id).into();
            p.proxy = Some(Proxy::Command {
                command: (*command).into(),
            });
            preview.bundle.profiles.push(p);
        }
        preview
            .bundle
            .profiles
            .push(crate::storage::tests::profile());
        preview
    }
    fn approve(reviewed: &Reviewed, ids: &[&str]) -> Approved {
        Approved {
            token: reviewed.command_plan.as_ref().unwrap().token.clone(),
            ids: ids.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn only_ticked_commands_as_shown_are_saved_once() {
        let reviewed = review(preview(&[("a", "nc %h %p"), ("b", "ssh -W %h:%p jump")]));
        let plan = reviewed.command_plan.as_ref().unwrap();
        assert_eq!(plan.sessions.len(), 2);
        let json = serde_json::to_value(&reviewed).unwrap();
        assert!(
            json["bundle"].is_object()
                && json["commandPlan"]["sessions"][1]["command"] == "ssh -W %h:%p jump"
        );
        let mut bundle = reviewed.preview.bundle.clone();
        // Without approval, or with an unticked session, nothing is saved.
        assert_eq!(take(&bundle, None).unwrap_err(), NOT_APPROVED);
        bundle.profiles.retain(|p| p.id != "b");
        let changed = {
            let mut b = bundle.clone();
            b.profiles[0].proxy = Some(Proxy::Command {
                command: "nc %h %p; curl evil".into(),
            });
            b
        };
        assert_eq!(
            take(&changed, Some(&approve(&reviewed, &["a"]))).unwrap_err(),
            NOT_APPROVED
        );
        // The failed try used the token up.
        assert_eq!(
            take(&bundle, Some(&approve(&reviewed, &["a"]))).unwrap_err(),
            EXPIRED
        );
        let again = review(preview(&[("a", "nc %h %p"), ("b", "ssh -W %h:%p jump")]));
        assert_eq!(
            take(&bundle, Some(&approve(&again, &["b"]))).unwrap_err(),
            NOT_APPROVED
        );
        let third = review(preview(&[("a", "nc %h %p")]));
        take(&bundle, Some(&approve(&third, &["a"]))).unwrap();
        assert_eq!(
            take(&bundle, Some(&approve(&third, &["a"]))).unwrap_err(),
            EXPIRED
        );
    }

    #[test]
    fn sessions_without_commands_need_no_approval() {
        let reviewed = review(preview(&[]));
        assert!(reviewed.command_plan.is_none());
        take(&reviewed.preview.bundle, None).unwrap();
    }
}
