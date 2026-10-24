mod catalog;

use catalog::{Result, Workspace};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager};

#[derive(Default)]
struct AppState {
    workspace: Arc<Mutex<Option<Workspace>>>,
    cancel: Arc<AtomicBool>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Request {
    Startup,
    Snapshot,
    Open {
        path: PathBuf,
    },
    AddSource {
        path: PathBuf,
        recursive: bool,
    },
    Scan,
    AddField {
        name: String,
        kind: String,
    },
    SetValues {
        ids: Vec<i64>,
        field: i64,
        value: Value,
    },
    SaveFilter {
        name: String,
        query: Value,
    },
    DeleteFilter {
        name: String,
    },
    AddImage {
        id: i64,
        path: PathBuf,
        cover: bool,
    },
    Image {
        id: i64,
    },
    Setting {
        key: String,
        value: Value,
    },
    Options {
        player: String,
        format: String,
        options: catalog::Options,
        #[serde(default)]
        column_order: Option<Vec<String>>,
        #[serde(default)]
        filter_order: Option<Vec<String>>,
    },
    Plan {
        ids: Vec<i64>,
        field: i64,
        multiple: String,
        group: String,
        #[serde(default)]
        overrides: HashMap<String, String>,
    },
    Execute {
        id: String,
        cross_confirmed: bool,
    },
    Reconcile,
    Resume {
        id: String,
    },
    Play {
        ids: Vec<i64>,
        playlist: bool,
    },
}

fn serialized<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn operate(state: &AppState, request: Request, progress: &dyn Fn(String)) -> Result<Value> {
    let mut lock = state
        .workspace
        .lock()
        .map_err(|_| "Failed to lock the workspace state.")?;
    match &request {
        Request::Startup => {
            let args: Vec<_> = std::env::args().collect();
            if let Some(i) = args.iter().position(|a| a == "--workspace") {
                if let Some(path) = args.get(i + 1) {
                    *lock = Some(Workspace::open(Path::new(path))?);
                }
            }
            return match lock.as_ref() {
                Some(ws) => serialized(ws.snapshot()?),
                None => Ok(Value::Null),
            };
        }
        Request::Open { path } => {
            let resolved = catalog::absolute(path)?;
            if lock.as_ref().map(|ws| &ws.root) != Some(&resolved) {
                *lock = Some(Workspace::open(&resolved)?);
            }
            return serialized(lock.as_ref().unwrap().snapshot()?);
        }
        _ => {}
    }
    let ws = lock.as_mut().ok_or("Open a workspace first.")?;
    match request {
        Request::Snapshot => {}
        Request::AddSource { path, recursive } => {
            state.cancel.store(false, Ordering::Relaxed);
            ws.add_source(&path, recursive)?;
            let errors = ws.scan(&state.cancel, progress)?;
            return Ok(json!({"snapshot": ws.snapshot()?, "warnings": errors}));
        }
        Request::Scan => {
            state.cancel.store(false, Ordering::Relaxed);
            let errors = ws.scan(&state.cancel, progress)?;
            return Ok(json!({"snapshot": ws.snapshot()?, "warnings": errors}));
        }
        Request::AddField { name, kind } => ws.add_field(&name, &kind)?,
        Request::SetValues { ids, field, value } => ws.set_values(&ids, field, value)?,
        Request::SaveFilter { name, query } => ws.save_filter(&name, &query)?,
        Request::DeleteFilter { name } => ws.delete_filter(&name)?,
        Request::AddImage { id, path, cover } => ws.add_image(id, &path, cover)?,
        Request::Image { id } => return serialized(ws.image_data(id)?),
        Request::Setting { key, value } => ws.set_setting(&key, value)?,
        Request::Options {
            player,
            format,
            options,
            column_order,
            filter_order,
        } => {
            if !player.is_empty() && !Path::new(&player).is_file() {
                return Err("Check the player executable.".into());
            }
            if !["m3u8", "asx"].contains(&format.as_str()) {
                return Err("Check the playlist format.".into());
            }
            ws.set_options(&options)?;
            ws.set_setting("player", json!(player))?;
            ws.set_setting("playlist_format", json!(format))?;
            if let Some(order) = column_order {
                ws.set_setting("column_order", json!(order))?;
            }
            if let Some(order) = filter_order {
                ws.set_setting("filter_order", json!(order))?;
            }
        }
        Request::Plan {
            ids,
            field,
            multiple,
            group,
            overrides,
        } => return serialized(ws.plan(&ids, field, &multiple, &group, &overrides)?),
        Request::Execute {
            id,
            cross_confirmed,
        } => {
            state.cancel.store(false, Ordering::Relaxed);
            ws.execute(&id, cross_confirmed, &state.cancel, progress)?;
        }
        Request::Reconcile => {
            let remaining = ws.reconcile()?;
            return Ok(json!({"snapshot": ws.snapshot()?, "remaining": remaining}));
        }
        Request::Resume { id } => return serialized(ws.resume_plan(&id)?),
        Request::Play { ids, playlist } => {
            ws.play(&ids, playlist)?;
            return Ok(Value::Null);
        }
        Request::Startup | Request::Open { .. } => unreachable!(),
    }
    serialized(ws.snapshot()?)
}

#[tauri::command]
async fn catalog(
    request: Request,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Value> {
    let state = AppState {
        workspace: state.workspace.clone(),
        cancel: state.cancel.clone(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        operate(&state, request, &|message| {
            let _ = app.emit("catalog-progress", message);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_operation(state: tauri::State<'_, AppState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![catalog, cancel_operation])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Filterer · Video Explorer");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Failed to start Filterer");
}
