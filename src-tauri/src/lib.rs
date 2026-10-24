mod catalog;
mod preferences;

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

struct AppState {
    workspace: Arc<Mutex<Option<Workspace>>>,
    cancel: Arc<AtomicBool>,
    /// App-wide preferences file; None when the OS config folder is unavailable.
    preferences: Option<PathBuf>,
}
impl AppState {
    fn preferences(&self) -> preferences::Preferences {
        self.preferences
            .as_deref()
            .map(preferences::load)
            .unwrap_or_default()
    }
    fn update_preferences(&self, change: impl FnOnce(&mut preferences::Preferences)) -> Result<()> {
        let Some(path) = &self.preferences else {
            return Ok(());
        };
        let mut current = preferences::load(path);
        change(&mut current);
        preferences::save(path, &current)
    }
    /// Failing to record the last workspace must not block opening it.
    fn remember(&self, ws: &Workspace) {
        let _ = self.update_preferences(|p| p.last_workspace = Some(ws.root.clone()));
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Request {
    Startup,
    Snapshot,
    Preferences,
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
        #[serde(default)]
        reopen_last: Option<bool>,
        #[serde(default)]
        column_widths: Option<Value>,
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
            if lock.is_none() {
                let args: Vec<_> = std::env::args().collect();
                let requested = args
                    .iter()
                    .position(|a| a == "--workspace")
                    .and_then(|i| args.get(i + 1))
                    .map(PathBuf::from);
                if let Some(path) = requested {
                    let ws = Workspace::open(&path)?;
                    state.remember(&ws);
                    *lock = Some(ws);
                } else if let preferences::Preferences {
                    reopen_last: true,
                    last_workspace: Some(path),
                } = state.preferences()
                {
                    if !path.is_dir() {
                        return Err(format!(
                            "The last workspace was not found: {}",
                            path.display()
                        ));
                    }
                    let ws = Workspace::open(&path).map_err(|e| {
                        format!("Could not reopen the last workspace ({}): {e}", path.display())
                    })?;
                    *lock = Some(ws);
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
            let ws = lock.as_ref().unwrap();
            state.remember(ws);
            return serialized(ws.snapshot()?);
        }
        Request::Preferences => {
            return Ok(json!({ "reopen_last": state.preferences().reopen_last }));
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
            reopen_last,
            column_widths,
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
            if let Some(widths) = column_widths {
                ws.set_setting("column_widths", widths)?;
            }
            if let Some(reopen) = reopen_last {
                state.update_preferences(|p| p.reopen_last = reopen)?;
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
        Request::Startup | Request::Open { .. } | Request::Preferences => unreachable!(),
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
        preferences: state.preferences.clone(),
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
        .invoke_handler(tauri::generate_handler![catalog, cancel_operation])
        .setup(|app| {
            let preferences = app
                .path()
                .app_config_dir()
                .ok()
                .map(|dir| dir.join("preferences.json"));
            app.manage(AppState {
                workspace: Arc::default(),
                cancel: Arc::default(),
                preferences,
            });
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Filterer · Video Explorer");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Failed to start Filterer");
}
