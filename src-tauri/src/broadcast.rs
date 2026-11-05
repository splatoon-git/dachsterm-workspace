use crate::{
    AppState,
    local::Locals,
    ssh::{Connections, Input},
    storage::Result,
};
use serde::Serialize;
use std::sync::Mutex;
#[derive(Default)]
pub struct Broadcast {
    ids: Mutex<Vec<String>>,
}
#[derive(Serialize)]
pub struct Target {
    id: String,
    name: String,
    host: String,
    username: String,
}
#[derive(Serialize)]
pub struct Status {
    targets: Vec<Target>,
    selected: Vec<String>,
}
impl Broadcast {
    fn ready(connections: &Connections, locals: &Locals, id: &str) -> bool {
        connections.handle(id).is_ok() || locals.control(id).is_ok_and(|c| c.ready())
    }
    fn refresh(&self, connections: &Connections, locals: &Locals, ids: &mut Vec<String>) {
        // A connection change stops the whole group. A newly authenticated shell
        // must never silently inherit a previous broadcast selection.
        if ids.iter().any(|id| !Self::ready(connections, locals, id)) {
            ids.clear();
        }
    }
    pub fn set(
        &self,
        connections: &Connections,
        locals: &Locals,
        mut selected: Vec<String>,
    ) -> Result<()> {
        selected.sort();
        selected.dedup();
        if selected.len() == 1 || selected.len() > 32 {
            return Err("멀티 입력은 연결 2~32개를 선택하세요.".into());
        }
        for id in &selected {
            if !Self::ready(connections, locals, id) {
                return Err("연결된 터미널만 선택할 수 있습니다.".into());
            }
        }
        *self.ids.lock().unwrap() = selected;
        Ok(())
    }
    pub fn status(&self, connections: &Connections, locals: &Locals) -> Status {
        let mut ids = self.ids.lock().unwrap();
        self.refresh(connections, locals, &mut ids);
        let candidates = connections
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|(id, c)| (id.clone(), c.clone()))
            .collect::<Vec<_>>();
        let mut targets = candidates
            .into_iter()
            .filter(|(id, _)| connections.handle(id).is_ok())
            .map(|(id, c)| Target {
                id,
                name: c.profile.name.clone(),
                host: c.profile.host.clone(),
                username: c.profile.username.clone(),
            })
            .collect::<Vec<_>>();
        targets.extend(locals.active().into_iter().map(|(id, c)| Target {
            id,
            name: c.name.clone(),
            host: "localhost".into(),
            username: "로컬".into(),
        }));
        targets.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        Status {
            targets,
            selected: ids.clone(),
        }
    }
    pub fn send(
        &self,
        connections: &Connections,
        locals: &Locals,
        source: &str,
        window: &str,
        data: &str,
    ) -> Result<()> {
        if data.len() > 32768 {
            return Err("입력은 한 번에 32KiB 이하여야 합니다.".into());
        }
        if locals.control(source).is_ok() {
            if window != "main" {
                return Err("로컬 터미널은 기본 창에서만 입력할 수 있습니다.".into());
            }
        } else {
            connections.control(source)?.broker.check(window)?;
        }
        let mut ids = self.ids.lock().unwrap();
        if ids.iter().any(|id| !Self::ready(connections, locals, id)) {
            ids.clear();
            return Err(
                "대상 연결이 종료되어 멀티 입력을 중지했습니다. 대상을 다시 선택하세요.".into(),
            );
        }
        let selected = if ids.iter().any(|id| id == source) {
            ids.clone()
        } else {
            vec![source.to_string()]
        };
        let mut queues = Vec::new();
        let mut encoded = Vec::new();
        for id in &selected {
            if let Ok(c) = locals.control(id) {
                if !c.ready() {
                    return Err("로컬 터미널이 종료되었습니다.".into());
                }
                queues.push(c.input.clone());
                encoded.push(data.as_bytes().to_vec());
            } else {
                let c = connections.control(id)?;
                queues.push(c.input.clone());
                encoded.push(crate::encoding::encode(data, &c.profile.encoding)?);
            }
        }
        // Reserve every queue before sending to avoid partial delivery on encoding
        // or backpressure failure. Network failures after dispatch remain possible.
        dispatch(&queues, encoded)
    }
}
fn dispatch(queues: &[tokio::sync::mpsc::Sender<Input>], encoded: Vec<Vec<u8>>) -> Result<()> {
    let permits = queues
        .iter()
        .map(|queue| {
            queue
                .try_reserve()
                .map_err(|_| "입력 대상 대기열이 가득 찼습니다. 전송하지 않았습니다.".to_string())
        })
        .collect::<Result<Vec<_>>>()?;
    for (permit, bytes) in permits.into_iter().zip(encoded) {
        permit.send(Input::Data(bytes));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backpressure_does_not_partially_deliver_a_group() {
        let (first, mut first_rx) = tokio::sync::mpsc::channel(1);
        let (second, mut second_rx) = tokio::sync::mpsc::channel(1);
        second.try_send(Input::Data(b"occupied".to_vec())).unwrap();
        let queues = vec![first, second];
        assert!(dispatch(&queues, vec![b"command".to_vec(); 2]).is_err());
        assert!(first_rx.try_recv().is_err());
        assert!(second_rx.try_recv().is_ok());
        assert!(dispatch(&queues, vec![b"command".to_vec(); 2]).is_ok());
        for rx in [&mut first_rx, &mut second_rx] {
            match rx.try_recv().unwrap() {
                Input::Data(bytes) => assert_eq!(bytes, b"command"),
                _ => panic!("expected data"),
            }
        }
    }
}
#[tauri::command]
pub fn broadcast_status(state: tauri::State<AppState>) -> Status {
    state.broadcast.status(&state.connections, &state.locals)
}
#[tauri::command]
pub fn broadcast_set(state: tauri::State<AppState>, ids: Vec<String>) -> Result<()> {
    state.broadcast.set(&state.connections, &state.locals, ids)
}
