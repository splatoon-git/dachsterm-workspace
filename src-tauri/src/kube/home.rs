//! Where a tab's cluster settings are kept. An SSH tab has its saved session; a local cluster has
//! no session, so this computer's one choice lives in the settings table (design KV.11).
use super::settings::KubeSettings;
use crate::storage::{Result, Store};

pub enum Home {
    Profile(String),
    Local,
}
impl Home {
    /// Stored settings are checked again before they run anything (design KV.6).
    pub fn check(&self, kube: &KubeSettings) -> Result<()> {
        match self {
            Home::Profile(_) => kube.validate(),
            Home::Local => kube.validate_local(),
        }
    }
}

const LOCAL_KEY: &str = "kubeLocalCluster";

/// Unreadable settings are an error, so a damaged row is not treated as "not set up yet".
pub fn read_local(store: &Store) -> Result<Option<KubeSettings>> {
    serde_json::from_str(&store.setting(LOCAL_KEY)?)
        .map_err(|_| "로컬 클러스터 설정을 읽지 못했습니다.".to_string())
}

pub fn write_local(store: &Store, kube: &KubeSettings) -> Result<()> {
    let text =
        serde_json::to_string(kube).map_err(|_| "로컬 클러스터 설정을 저장하지 못했습니다.")?;
    store.set_setting(LOCAL_KEY, &text)
}

/// Operate mode stays on only for the context it was turned on for. One local entry can reach any
/// cluster in the kubeconfig, and switching to another must not carry a write permission with it.
pub fn save_local(store: &Store, mut kube: KubeSettings) -> Result<()> {
    let old = read_local(store)?;
    kube.operate = old.is_some_and(|old| old.operate && old.context == kube.context);
    write_local(store, &kube)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        (dir, store)
    }

    fn settings(context: &str, operate: bool) -> KubeSettings {
        KubeSettings {
            context: context.into(),
            namespace: String::new(),
            kubectl: "/k/kubectl".into(),
            kubeconfig: String::new(),
            operate,
        }
    }

    #[test]
    fn nothing_stored_is_not_an_error() {
        let (_dir, store) = store();
        assert_eq!(read_local(&store).unwrap(), None);
    }

    #[test]
    fn a_damaged_row_is_an_error() {
        let (_dir, store) = store();
        store.set_setting(LOCAL_KEY, "{not json").unwrap();
        assert!(read_local(&store).is_err());
    }

    #[test]
    fn saving_cannot_switch_operate_on_and_a_new_context_turns_it_off() {
        let (_dir, store) = store();
        save_local(&store, settings("kind-a", true)).unwrap();
        assert!(!read_local(&store).unwrap().unwrap().operate);

        write_local(&store, &settings("kind-a", true)).unwrap();
        save_local(&store, settings("kind-a", false)).unwrap();
        assert!(read_local(&store).unwrap().unwrap().operate);

        save_local(&store, settings("prod", false)).unwrap();
        assert!(!read_local(&store).unwrap().unwrap().operate);
    }
}
