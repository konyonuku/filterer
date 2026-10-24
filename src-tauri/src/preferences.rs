//! App-wide preferences stored outside any workspace (in the OS app config folder).
use crate::catalog::Result;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub reopen_last: bool,
    pub last_workspace: Option<PathBuf>,
}
impl Default for Preferences {
    fn default() -> Self {
        Preferences {
            reopen_last: true,
            last_workspace: None,
        }
    }
}

/// Missing or unreadable files fall back to the defaults.
pub fn load(path: &Path) -> Preferences {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, preferences: &Preferences) -> Result<()> {
    let fail = |e: std::io::Error| format!("Could not save app preferences: {e}");
    fs::create_dir_all(path.parent().ok_or("Invalid preferences path")?).map_err(fail)?;
    let temporary = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(preferences).map_err(|e| e.to_string())?;
    fs::write(&temporary, text).map_err(fail)?;
    fs::rename(&temporary, path).map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_reopen_and_round_trips() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config").join("preferences.json");
        assert_eq!(load(&path), Preferences::default());
        assert!(load(&path).reopen_last);

        let saved = Preferences {
            reopen_last: false,
            last_workspace: Some(temp.path().join("workspace")),
        };
        save(&path, &saved).unwrap();
        assert_eq!(load(&path), saved);
        save(&path, &Preferences::default()).unwrap();
        assert_eq!(load(&path), Preferences::default());

        fs::write(&path, "not json").unwrap();
        assert_eq!(load(&path), Preferences::default());
        fs::write(&path, r#"{"last_workspace":"C:\\w"}"#).unwrap();
        assert!(load(&path).reopen_last);
    }
}
