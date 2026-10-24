use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::UNIX_EPOCH,
};
use uuid::Uuid;
use walkdir::WalkDir;

pub type Result<T> = std::result::Result<T, String>;
trait Readable<T> {
    fn readable(self) -> Result<T>;
}
impl<T, E: std::fmt::Display> Readable<T> for std::result::Result<T, E> {
    fn readable(self) -> Result<T> {
        self.map_err(|e| e.to_string())
    }
}
pub const VIDEOS: &[&str] = &[
    "mp4", "mkv", "avi", "wmv", "mov", "m4v", "webm", "ts", "mts", "mpg", "mpeg", "flv",
];
const IMAGES: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp"];
fn ext(p: &Path) -> String {
    p.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
}
fn sidecar(p: &Path) -> bool {
    IMAGES.contains(&ext(p).as_str())
        || ["nfo", "srt", "ass", "ssa", "sub", "idx", "vtt"].contains(&ext(p).as_str())
}
fn path_text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
pub fn absolute(p: &Path) -> Result<PathBuf> {
    // Avoid persisting Windows verbatim prefixes: stored paths use normal absolute form.
    let p = fs::canonicalize(p).readable()?;
    #[cfg(windows)]
    {
        let s = path_text(&p);
        if let Some(s) = s.strip_prefix("\\\\?\\UNC\\") {
            return Ok(PathBuf::from(format!("\\\\{s}")));
        }
        if let Some(s) = s.strip_prefix("\\\\?\\") {
            return Ok(PathBuf::from(s));
        }
    }
    Ok(p)
}
fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err("Operation cancelled. Completed moves are kept.".into())
    } else {
        Ok(())
    }
}
fn stamp(time: std::io::Result<std::time::SystemTime>) -> u64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Signature {
    size: u64,
    modified: u64,
    created: u64,
}
fn signature(path: &Path) -> Result<Signature> {
    let m = fs::symlink_metadata(path).readable()?;
    if !m.is_file() || m.file_type().is_symlink() {
        return Err(format!(
            "Only regular files can be moved: {}",
            path.display()
        ));
    }
    Ok(Signature {
        size: m.len(),
        modified: stamp(m.modified()),
        created: stamp(m.created()),
    })
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Field {
    pub id: i64,
    pub name: String,
    pub kind: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ImageRef {
    pub id: i64,
    pub path: String,
    pub cover: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Video {
    pub id: i64,
    pub path: String,
    pub size: u64,
    pub values: Value,
    pub images: Vec<ImageRef>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Source {
    pub path: String,
    pub recursive: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct SavedFilter {
    pub name: String,
    pub query: Value,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct History {
    pub id: String,
    pub created: String,
    pub status: String,
    pub payload: Value,
}
#[derive(Serialize)]
pub struct Snapshot {
    pub root: String,
    pub sources: Vec<Source>,
    pub fields: Vec<Field>,
    pub videos: Vec<Video>,
    pub folders: Vec<SavedFilter>,
    pub history: Vec<History>,
    pub player: String,
    pub playlist_format: String,
    pub column_order: Vec<String>,
    pub filter_order: Vec<String>,
    pub column_widths: HashMap<String, f64>,
    pub options: Options,
}
pub const PAGE_SIZES: &[u32] = &[25, 50, 100, 200, 500];
#[derive(Clone, Serialize, Deserialize)]
pub struct Options {
    pub unclassified_folder: String,
    pub shared_folder: String,
    pub page_size: u32,
    pub visible_fields: u32,
}
impl Default for Options {
    fn default() -> Self {
        Options {
            unclassified_folder: "Unclassified".into(),
            shared_folder: "Multiple values".into(),
            page_size: 100,
            visible_fields: 6,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct MoveItem {
    pub media_id: i64,
    pub video: bool,
    pub source: PathBuf,
    pub target: PathBuf,
    signature: Signature,
    pub cross: bool,
    pub state: String,
    hash: Option<String>,
    temporary: Option<PathBuf>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct MovePlan {
    pub id: String,
    pub created: String,
    pub items: Vec<MoveItem>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

pub struct Workspace {
    pub root: PathBuf,
    meta: PathBuf,
    db: Connection,
    _lock: File,
    pub preview: Option<MovePlan>,
}
impl Workspace {
    pub fn open(root: &Path) -> Result<Self> {
        let root = absolute(root)?;
        if !root.is_dir() {
            return Err("Select a workspace folder.".into());
        }
        let meta = root.join(".video-workspace");
        fs::create_dir_all(&meta).readable()?;
        if !absolute(&meta)?.starts_with(&root) {
            return Err("The management folder points outside the workspace.".into());
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(meta.join("workspace.lock"))
            .readable()?;
        lock.try_lock_exclusive()
            .map_err(|_| "This workspace is in use by another window.".to_string())?;
        let db = Connection::open(meta.join("catalog.sqlite3")).readable()?;
        db.busy_timeout(std::time::Duration::from_secs(10))
            .readable()?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .readable()?;
        if version > 1 {
            return Err("This workspace is not supported by this version.".into());
        }
        db.execute_batch("CREATE TABLE IF NOT EXISTS roots(path TEXT PRIMARY KEY,recursive INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS media(id INTEGER PRIMARY KEY,path TEXT UNIQUE NOT NULL,size INTEGER NOT NULL,modified INTEGER NOT NULL,metadata TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS fields(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,kind TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS images(id INTEGER PRIMARY KEY,media_id INTEGER NOT NULL,path TEXT NOT NULL,cover INTEGER NOT NULL DEFAULT 0,UNIQUE(media_id,path));
            CREATE TABLE IF NOT EXISTS attachments(media_id INTEGER NOT NULL,path TEXT NOT NULL,UNIQUE(media_id,path));
            CREATE TABLE IF NOT EXISTS folders(name TEXT PRIMARY KEY,query TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,created TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
            PRAGMA user_version=1;").readable()?;
        Ok(Self {
            root,
            meta,
            db,
            _lock: lock,
            preview: None,
        })
    }
    pub fn sources(&self) -> Result<Vec<Source>> {
        let mut q = self
            .db
            .prepare("SELECT path,recursive FROM roots ORDER BY path")
            .readable()?;
        let rows = q
            .query_map([], |r| {
                Ok(Source {
                    path: r.get(0)?,
                    recursive: r.get(1)?,
                })
            })
            .readable()?;
        rows.collect::<std::result::Result<_, _>>().readable()
    }
    pub fn fields(&self) -> Result<Vec<Field>> {
        let mut q = self
            .db
            .prepare("SELECT id,name,kind FROM fields ORDER BY id")
            .readable()?;
        let rows = q
            .query_map([], |r| {
                Ok(Field {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                })
            })
            .readable()?;
        rows.collect::<std::result::Result<_, _>>().readable()
    }
    pub fn videos(&self) -> Result<Vec<Video>> {
        let mut images: HashMap<i64, Vec<ImageRef>> = HashMap::new();
        let mut q = self
            .db
            .prepare("SELECT id,media_id,path,cover FROM images ORDER BY cover DESC,id")
            .readable()?;
        for row in q
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(1)?,
                    ImageRef {
                        id: r.get(0)?,
                        path: r.get(2)?,
                        cover: r.get(3)?,
                    },
                ))
            })
            .readable()?
        {
            let (id, image) = row.readable()?;
            images.entry(id).or_default().push(image);
        }
        let mut q = self
            .db
            .prepare("SELECT id,path,size,metadata FROM media ORDER BY path COLLATE NOCASE")
            .readable()?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .readable()?;
        let mut result = Vec::new();
        for row in rows {
            let (id, path, size, data) = row.readable()?;
            result.push(Video {
                id,
                path,
                size,
                values: serde_json::from_str(&data).readable()?,
                images: images.remove(&id).unwrap_or_default(),
            });
        }
        Ok(result)
    }
    pub fn history(&self) -> Result<Vec<History>> {
        let mut q = self
            .db
            .prepare(
                "SELECT id,created,status,payload FROM operations ORDER BY rowid DESC LIMIT 50",
            )
            .readable()?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .readable()?;
        rows.map(|row| {
            let (id, created, status, data) = row.readable()?;
            Ok(History {
                id,
                created,
                status,
                payload: serde_json::from_str(&data).readable()?,
            })
        })
        .collect()
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        let mut q = self
            .db
            .prepare("SELECT name,query FROM folders ORDER BY name")
            .readable()?;
        let folders = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .readable()?
            .map(|r| {
                let (name, query) = r.readable()?;
                Ok(SavedFilter {
                    name,
                    query: serde_json::from_str(&query).readable()?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Snapshot {
            root: path_text(&self.root),
            sources: self.sources()?,
            fields: self.fields()?,
            videos: self.videos()?,
            folders,
            history: self.history()?,
            player: self.setting("player")?.as_str().unwrap_or("").into(),
            playlist_format: self
                .setting("playlist_format")?
                .as_str()
                .unwrap_or("m3u8")
                .into(),
            column_order: serde_json::from_value(self.setting("column_order")?).unwrap_or_default(),
            filter_order: serde_json::from_value(self.setting("filter_order")?).unwrap_or_default(),
            column_widths: serde_json::from_value(self.setting("column_widths")?).unwrap_or_default(),
            options: self.options()?,
        })
    }
    pub fn add_source(&self, path: &Path, recursive: bool) -> Result<()> {
        let path = absolute(path)?;
        if !path.is_dir() || path.starts_with(&self.meta) {
            return Err("Check the source folder.".into());
        }
        self.db
            .execute(
                "INSERT OR REPLACE INTO roots VALUES (?1,?2)",
                params![path_text(&path), recursive],
            )
            .readable()?;
        Ok(())
    }
    pub fn scan(&mut self, cancel: &AtomicBool, progress: &dyn Fn(String)) -> Result<Vec<String>> {
        let mut sources = self.sources()?;
        if self.root.join("videos").is_dir() {
            sources.push(Source {
                path: path_text(&self.root.join("videos")),
                recursive: true,
            });
        }
        let mut seen = HashSet::new();
        let mut errors = Vec::new();
        let tx = self.db.transaction().readable()?;
        for source in sources {
            let iter = WalkDir::new(&source.path)
                .follow_links(false)
                .max_depth(if source.recursive { usize::MAX } else { 1 })
                .into_iter()
                .filter_entry(|e| e.file_name() != ".video-workspace");
            for entry in iter {
                cancelled(cancel)?;
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        errors.push(e.to_string());
                        continue;
                    }
                };
                if !entry.file_type().is_file() || !VIDEOS.contains(&ext(entry.path()).as_str()) {
                    continue;
                }
                let path = match absolute(entry.path()) {
                    Ok(p) => p,
                    Err(e) => {
                        errors.push(e);
                        continue;
                    }
                };
                if !seen.insert(path.clone()) {
                    continue;
                }
                let sig = match signature(&path) {
                    Ok(s) => s,
                    Err(e) => {
                        errors.push(e);
                        continue;
                    }
                };
                tx.execute("INSERT INTO media(path,size,modified) VALUES (?1,?2,?3) ON CONFLICT(path) DO UPDATE SET size=excluded.size,modified=excluded.modified", params![path_text(&path), sig.size as i64, sig.modified as i64]).readable()?;
                if seen.len() % 100 == 0 {
                    progress(format!("Checking {} videos", seen.len()));
                }
            }
        }
        tx.commit().readable()?;
        Ok(errors)
    }
    pub fn add_field(&self, name: &str, kind: &str) -> Result<()> {
        if name.trim().is_empty()
            || name.chars().count() > 60
            || !["text", "number", "date", "tags", "rating"].contains(&kind)
        {
            return Err("Check the field name and type.".into());
        }
        self.db
            .execute(
                "INSERT INTO fields(name,kind) VALUES (?1,?2)",
                params![name.trim(), kind],
            )
            .map_err(|e| format!("The name already exists or could not be saved: {e}"))?;
        Ok(())
    }
    pub fn set_values(&mut self, ids: &[i64], field: i64, value: Value) -> Result<()> {
        if ids.is_empty() {
            return Err("Select at least one video.".into());
        }
        let kind = self
            .fields()?
            .into_iter()
            .find(|f| f.id == field)
            .ok_or("Field not found.")?
            .kind;
        let clean = typed_value(&kind, value)?;
        let tx = self.db.transaction().readable()?;
        for id in ids {
            let data: String = tx
                .query_row("SELECT metadata FROM media WHERE id=?1", [id], |r| r.get(0))
                .readable()?;
            let mut data: Map<String, Value> = serde_json::from_str(&data).readable()?;
            data.insert(field.to_string(), clean.clone());
            tx.execute(
                "UPDATE media SET metadata=?1 WHERE id=?2",
                params![serde_json::to_string(&data).readable()?, id],
            )
            .readable()?;
        }
        tx.commit().readable()
    }
    pub fn save_filter(&self, name: &str, query: &Value) -> Result<()> {
        if name.trim().is_empty() {
            return Err("Enter a name to save.".into());
        }
        self.db
            .execute(
                "INSERT OR REPLACE INTO folders VALUES (?1,?2)",
                params![name.trim(), query.to_string()],
            )
            .readable()?;
        Ok(())
    }
    pub fn delete_filter(&self, name: &str) -> Result<()> {
        self.db
            .execute("DELETE FROM folders WHERE name=?1", [name])
            .readable()?;
        Ok(())
    }
    pub fn setting(&self, key: &str) -> Result<Value> {
        let raw: Option<String> = self
            .db
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .readable()?;
        raw.map(|s| serde_json::from_str(&s).readable())
            .unwrap_or(Ok(Value::Null))
    }
    pub fn set_setting(&self, key: &str, value: Value) -> Result<()> {
        if !["player", "playlist_format", "column_order", "filter_order", "column_widths"].contains(&key) {
            return Err("Unsupported setting.".into());
        }
        if key.ends_with("_order") && serde_json::from_value::<Vec<String>>(value.clone()).is_err()
        {
            return Err("The order must be a list of names.".into());
        }
        if key == "column_widths"
            && !serde_json::from_value::<HashMap<String, f64>>(value.clone())
                .is_ok_and(|w| w.values().all(|v| (30.0..=2000.0).contains(v)))
        {
            return Err("Column widths must be between 30 and 2000 pixels.".into());
        }
        self.write_setting(key, value)
    }
    /// Stored options with defaults filled in for missing or unreadable values.
    pub fn options(&self) -> Result<Options> {
        let default = Options::default();
        let name = |key: &str, fallback: String| -> Result<String> {
            Ok(match self.setting(key)?.as_str() {
                Some(v) if folder_name(v).is_ok() => v.into(),
                _ => fallback,
            })
        };
        let page_size = self.setting("page_size")?.as_u64().map(|v| v as u32);
        let visible = self.setting("visible_fields")?.as_u64().map(|v| v as u32);
        Ok(Options {
            unclassified_folder: name("unclassified_folder", default.unclassified_folder)?,
            shared_folder: name("shared_folder", default.shared_folder)?,
            page_size: page_size
                .filter(|v| PAGE_SIZES.contains(v))
                .unwrap_or(default.page_size),
            visible_fields: visible
                .filter(|v| (1..=50).contains(v))
                .unwrap_or(default.visible_fields),
        })
    }
    pub fn set_options(&self, options: &Options) -> Result<()> {
        let unclassified = options.unclassified_folder.trim();
        let shared = options.shared_folder.trim();
        folder_name(unclassified)?;
        folder_name(shared)?;
        if !PAGE_SIZES.contains(&options.page_size) {
            return Err("Check the number of rows per page.".into());
        }
        if !(1..=50).contains(&options.visible_fields) {
            return Err("Default filters and columns must be between 1 and 50.".into());
        }
        self.write_setting("unclassified_folder", json!(unclassified))?;
        self.write_setting("shared_folder", json!(shared))?;
        self.write_setting("page_size", json!(options.page_size))?;
        self.write_setting("visible_fields", json!(options.visible_fields))
    }
    fn write_setting(&self, key: &str, value: Value) -> Result<()> {
        self.db
            .execute(
                "INSERT OR REPLACE INTO settings VALUES (?1,?2)",
                params![key, value.to_string()],
            )
            .readable()?;
        Ok(())
    }
    pub fn add_image(&mut self, id: i64, path: &Path, cover: bool) -> Result<()> {
        if !self.videos()?.iter().any(|v| v.id == id) {
            return Err("Video not found.".into());
        }
        let path = absolute(path)?;
        if !path.is_file() || !IMAGES.contains(&ext(&path).as_str()) {
            return Err("Select a supported image file.".into());
        }
        let tx = self.db.transaction().readable()?;
        if cover {
            tx.execute("UPDATE images SET cover=0 WHERE media_id=?1", [id])
                .readable()?;
        }
        tx.execute("INSERT INTO images(media_id,path,cover) VALUES (?1,?2,?3) ON CONFLICT(media_id,path) DO UPDATE SET cover=excluded.cover", params![id, path_text(&path), cover]).readable()?;
        tx.commit().readable()
    }
    pub fn image_data(&self, id: i64) -> Result<String> {
        use base64::Engine;
        let path: String = self
            .db
            .query_row("SELECT path FROM images WHERE id=?1", [id], |r| r.get(0))
            .readable()?;
        let path = Path::new(&path);
        if !IMAGES.contains(&ext(path).as_str()) {
            return Err("Unsupported image.".into());
        }
        let file = File::open(path).readable()?;
        let mut data = Vec::new();
        file.take(12_000_001).read_to_end(&mut data).readable()?;
        if data.len() > 12_000_000 {
            return Err("Only images up to 12MB can be displayed.".into());
        }
        let extension = ext(path);
        let mime = if ["jpg", "jpeg"].contains(&extension.as_str()) {
            "jpeg"
        } else {
            &extension
        };
        Ok(format!(
            "data:image/{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(data)
        ))
    }
    fn related(&self, video: &Video) -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
        let path = Path::new(&video.path);
        signature(path)?;
        let files = fs::read_dir(path.parent().ok_or("Invalid video path")?)
            .readable()?
            .collect::<std::io::Result<Vec<_>>>()
            .readable()?
            .into_iter()
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.path())
            .collect::<Vec<_>>();
        let videos: Vec<_> = files
            .iter()
            .filter(|p| VIDEOS.contains(&ext(p).as_str()))
            .collect();
        let mut auto = HashSet::new();
        let mut ambiguous = HashSet::new();
        for file in files.iter().filter(|p| sidecar(p)) {
            let stem = file
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            let owners: Vec<_> = videos
                .iter()
                .filter(|v| {
                    let name = v
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase();
                    stem == name
                        || [".", "-", "_"]
                            .iter()
                            .any(|sep| stem.starts_with(&format!("{name}{sep}")))
                })
                .collect();
            if (owners.len() == 1 && owners[0].as_path() == path)
                || (owners.is_empty() && videos.len() == 1)
            {
                auto.insert(file.clone());
            } else if owners.is_empty() || owners.iter().any(|v| v.as_path() == path) {
                ambiguous.insert(file.clone());
            }
        }
        for table in ["images", "attachments"] {
            let mut q = self
                .db
                .prepare(&format!("SELECT path FROM {table} WHERE media_id=?1"))
                .readable()?;
            for p in q
                .query_map([video.id], |r| r.get::<_, String>(0))
                .readable()?
            {
                auto.insert(PathBuf::from(p.readable()?));
            }
        }
        ambiguous.retain(|p| !auto.contains(p));
        let mut auto: Vec<_> = auto.into_iter().collect();
        auto.sort();
        let mut ambiguous: Vec<_> = ambiguous.into_iter().collect();
        ambiguous.sort();
        Ok((auto, ambiguous))
    }
    pub fn plan(
        &mut self,
        ids: &[i64],
        field: i64,
        multiple: &str,
        group: &str,
        overrides: &HashMap<String, String>,
    ) -> Result<MovePlan> {
        if !self.fields()?.iter().any(|f| f.id == field) {
            return Err("Select the field to organize by.".into());
        }
        if self.has_pending()? {
            return Err(
                "There are interrupted move records to review. Open the move history.".into(),
            );
        }
        let records = self.videos()?;
        let unclassified = self.options()?.unclassified_folder;
        let mut plan = MovePlan {
            id: Uuid::new_v4().to_string(),
            created: now(),
            items: vec![],
            errors: vec![],
            warnings: vec![],
            error: None,
        };
        let mut targets = HashSet::new();
        let mut sources = HashSet::new();
        let mut seen = HashSet::new();
        for id in ids {
            if !seen.insert(id) {
                continue;
            }
            let result = (|| -> Result<()> {
                let video = records
                    .iter()
                    .find(|v| v.id == *id)
                    .ok_or("Video not found.")?;
                let value = &video.values[field.to_string()];
                let values: Vec<String> = match value {
                    Value::Array(a) => a.iter().map(value_text).collect(),
                    Value::Null => vec![],
                    _ => vec![value_text(value)],
                };
                let category = if let Some(name) = overrides.get(&id.to_string()) {
                    name.clone()
                } else if values.len() > 1 {
                    if multiple == "ask" {
                        return Err(format!("Choose a destination: {}", video.path));
                    }
                    group.into()
                } else {
                    values
                        .first()
                        .cloned()
                        .unwrap_or_else(|| unclassified.clone())
                };
                folder_name(&category)?;
                let destination = self.root.join("videos").join(category);
                self.check_destination(&destination)?;
                let (related, ambiguous) = self.related(video)?;
                plan.warnings.extend(
                    ambiguous
                        .iter()
                        .map(|p| format!("Unclear association · left in place: {}", p.display())),
                );
                let mut paths = vec![PathBuf::from(&video.path)];
                paths.extend(related);
                for source in paths {
                    let sig = signature(&source)?;
                    let target = destination.join(source.file_name().ok_or("Invalid file name")?);
                    if source == target {
                        continue;
                    }
                    let key = path_text(&target).to_lowercase();
                    if target.exists() || targets.contains(&key) {
                        return Err(format!(
                            "Destination file name conflict: {}",
                            target.display()
                        ));
                    }
                    if sources.contains(&source) {
                        return Err(format!(
                            "File shared by multiple videos: {}",
                            source.display()
                        ));
                    }
                    for table in ["images", "attachments"] {
                        let shared: bool = self.db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE path=?1 AND media_id<>?2)"), params![path_text(&source), id], |r| r.get(0)).readable()?;
                        if shared {
                            return Err(format!(
                                "File shared with another video: {}",
                                source.display()
                            ));
                        }
                    }
                    let cross = volume_id(&source)? != volume_id(nearest_existing(&destination)?)?;
                    plan.items.push(MoveItem {
                        media_id: *id,
                        video: source == Path::new(&video.path),
                        source: source.clone(),
                        target,
                        signature: sig,
                        cross,
                        state: "planned".into(),
                        hash: None,
                        temporary: None,
                    });
                    targets.insert(key);
                    sources.insert(source);
                }
                Ok(())
            })();
            if let Err(e) = result {
                plan.errors.push(e);
            }
        }
        plan.warnings.sort();
        plan.warnings.dedup();
        self.preview = Some(plan.clone());
        Ok(plan)
    }
    fn check_destination(&self, destination: &Path) -> Result<()> {
        if !destination.starts_with(self.root.join("videos"))
            || !absolute(nearest_existing(destination)?)?.starts_with(&self.root)
        {
            return Err("The destination points outside the workspace.".into());
        }
        Ok(())
    }
    fn has_pending(&self) -> Result<bool> {
        self.db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM operations WHERE status='attention')",
                [],
                |r| r.get(0),
            )
            .readable()
    }
    fn journal(&self, plan: &MovePlan, status: &str) -> Result<()> {
        self.db.execute("INSERT INTO operations VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload", params![plan.id, plan.created, status, serde_json::to_string(plan).readable()?]).readable()?;
        Ok(())
    }
    pub fn execute(
        &mut self,
        id: &str,
        cross_confirmed: bool,
        cancel: &AtomicBool,
        progress: &dyn Fn(String),
    ) -> Result<()> {
        let mut plan = self
            .preview
            .clone()
            .filter(|p| p.id == id)
            .ok_or("Create the move preview again.")?;
        if self.has_pending()? || !plan.errors.is_empty() || plan.items.is_empty() {
            return Err("Check for interrupted records, conflicts, or an empty plan.".into());
        }
        for item in plan.items.iter().filter(|i| i.state != "complete") {
            if signature(&item.source)? != item.signature || item.target.exists() {
                return Err("Files changed after the preview. Check again.".into());
            }
            self.check_destination(item.target.parent().ok_or("Invalid destination path")?)?;
            if (item.cross
                || volume_id(&item.source)? != volume_id(nearest_existing(&item.target)?)?)
                && !cross_confirmed
            {
                return Err("Confirmation is required to move across drives.".into());
            }
        }
        self.journal(&plan, "attention")?;
        let result = (|| -> Result<()> {
            for i in 0..plan.items.len() {
                if plan.items[i].state == "complete" {
                    continue;
                }
                cancelled(cancel)?;
                let item = plan.items[i].clone();
                fs::create_dir_all(item.target.parent().ok_or("Invalid destination path")?)
                    .readable()?;
                self.check_destination(item.target.parent().unwrap())?;
                let cross = volume_id(&item.source)? != volume_id(item.target.parent().unwrap())?;
                if cross && !cross_confirmed {
                    return Err(
                        "The file system changed. Confirm the cross-drive move again.".into(),
                    );
                }
                plan.items[i].state = "moving".into();
                plan.items[i].temporary = Some(
                    item.target
                        .with_file_name(format!(".filterer-{}.partial", Uuid::new_v4())),
                );
                self.journal(&plan, "attention")?;
                progress(format!(
                    "{}/{} · {}",
                    i + 1,
                    plan.items.len(),
                    item.source
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                ));
                let temporary = plan.items[i].temporary.clone().unwrap();
                transfer(
                    &item.source,
                    &item.target,
                    &temporary,
                    &item.signature,
                    cross,
                    cancel,
                    progress,
                    &mut |state, hash| {
                        plan.items[i].state = state.into();
                        if let Some(hash) = hash {
                            plan.items[i].hash = Some(hash);
                        }
                        self.journal(&plan, "attention")
                    },
                )?;
                plan.items[i].state = "moved".into();
                self.journal(&plan, "attention")?;
                self.update_paths(&item)?;
                plan.items[i].state = "complete".into();
                self.journal(&plan, "attention")?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            plan.error = Some(error.clone());
            self.journal(
                &plan,
                if plan
                    .items
                    .iter()
                    .any(|i| !["planned", "complete"].contains(&i.state.as_str()))
                {
                    "attention"
                } else {
                    "stopped"
                },
            )?;
            self.preview = None;
            return Err(error);
        }
        self.journal(&plan, "complete")?;
        self.preview = None;
        Ok(())
    }
    fn update_paths(&mut self, item: &MoveItem) -> Result<()> {
        let sig = signature(&item.target)?;
        let tx = self.db.transaction().readable()?;
        if item.video {
            tx.execute(
                "UPDATE media SET path=?1,size=?2,modified=?3 WHERE id=?4",
                params![
                    path_text(&item.target),
                    sig.size as i64,
                    sig.modified as i64,
                    item.media_id
                ],
            )
            .readable()?;
        }
        for table in ["images", "attachments"] {
            tx.execute(
                &format!("UPDATE {table} SET path=?1 WHERE path=?2"),
                params![path_text(&item.target), path_text(&item.source)],
            )
            .readable()?;
        }
        tx.commit().readable()
    }
    pub fn reconcile(&mut self) -> Result<usize> {
        for record in self
            .history()?
            .into_iter()
            .filter(|r| r.status == "attention")
        {
            let mut plan: MovePlan = serde_json::from_value(record.payload).map_err(|_| {
                "This move record uses an unsupported legacy format and cannot be recovered."
                    .to_string()
            })?;
            for i in 0..plan.items.len() {
                let item = plan.items[i].clone();
                if ["complete", "planned"].contains(&item.state.as_str()) {
                    continue;
                }
                self.check_destination(item.target.parent().ok_or("Invalid destination path")?)?;
                if item.source.exists()
                    && !item.target.exists()
                    && signature(&item.source)? == item.signature
                {
                    plan.items[i].state = "planned".into();
                } else if !item.source.exists() && item.target.is_file() {
                    let verified = if let Some(hash) = &item.hash {
                        hash_file(&item.target, &AtomicBool::new(false))? == *hash
                    } else {
                        signature(&item.target)? == item.signature
                    };
                    if verified {
                        self.update_paths(&item)?;
                        plan.items[i].state = "complete".into();
                    }
                }
            }
            self.journal(
                &plan,
                if plan
                    .items
                    .iter()
                    .all(|i| ["complete", "planned"].contains(&i.state.as_str()))
                {
                    "stopped"
                } else {
                    "attention"
                },
            )?;
        }
        Ok(self
            .history()?
            .iter()
            .filter(|r| r.status == "attention")
            .count())
    }
    pub fn resume_plan(&mut self, id: &str) -> Result<MovePlan> {
        let record = self
            .history()?
            .into_iter()
            .find(|r| r.id == id && r.status == "stopped")
            .ok_or("No interrupted record found to retry.")?;
        let plan: MovePlan = serde_json::from_value(record.payload).map_err(|_| {
            "This move record uses an unsupported legacy format and cannot be retried.".to_string()
        })?;
        self.preview = Some(plan.clone());
        Ok(plan)
    }
    pub fn play(&self, ids: &[i64], playlist: bool) -> Result<()> {
        let videos = self.videos()?;
        let paths: Vec<_> = ids
            .iter()
            .map(|id| {
                videos
                    .iter()
                    .find(|v| v.id == *id)
                    .map(|v| PathBuf::from(&v.path))
                    .ok_or("Video not found.".to_string())
            })
            .collect::<Result<_>>()?;
        if paths.is_empty() || paths.iter().any(|p| !p.is_file()) {
            return Err("The selected videos cannot be accessed.".into());
        }
        let target = if playlist {
            let dir = self.meta.join("playlists");
            fs::create_dir_all(&dir).readable()?;
            let asx = self.setting("playlist_format")? == "asx";
            let target = dir.join(format!(
                "{}.{}",
                Uuid::new_v4(),
                if asx { "asx" } else { "m3u8" }
            ));
            let urls = paths
                .iter()
                .map(|p| {
                    url::Url::from_file_path(p)
                        .map(|u| u.to_string())
                        .map_err(|_| "Failed to convert the playback path".into())
                })
                .collect::<Result<Vec<String>>>()?;
            let text = if asx {
                format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?><asx version=\"3.0\">{}</asx>",
                    urls.iter()
                        .map(|u| format!("<entry><ref href=\"{}\"/></entry>", xml_escape(u)))
                        .collect::<String>()
                )
            } else {
                format!("#EXTM3U\n{}\n", urls.join("\n"))
            };
            fs::write(&target, text).readable()?;
            target
        } else {
            paths[0].clone()
        };
        launch(&target, self.setting("player")?.as_str().unwrap_or(""))
    }
}

pub fn value_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(value_text).collect::<Vec<_>>().join(", "),
        Value::Number(n) if n.as_f64().is_some_and(|v| v.fract() == 0.0) => {
            format!("{:.0}", n.as_f64().unwrap())
        }
        _ => value.to_string(),
    }
}
fn typed_value(kind: &str, value: Value) -> Result<Value> {
    let raw = value_text(&value).trim().to_string();
    if value.is_null() || raw.is_empty() {
        return Ok(Value::Null);
    }
    match kind {
        "number" => {
            let v = raw.parse::<f64>().map_err(|_| "Enter a number.")?;
            if !v.is_finite() {
                return Err("Enter a finite number.".into());
            }
            Ok(json!(v))
        }
        // Star rating: 0 to 5 in half-star steps. Empty means "not rated", which differs from 0.
        "rating" => {
            let v = raw.parse::<f64>().map_err(|_| "Enter a rating from 0 to 5.")?;
            if !(0.0..=5.0).contains(&v) || (v * 2.0).fract() != 0.0 {
                return Err("A rating must be 0 to 5 in steps of 0.5.".into());
            }
            Ok(json!(v))
        }
        "date" => {
            let date = chrono::NaiveDate::parse_from_str(&raw, "%Y-%m-%d")
                .map_err(|_| "Enter the date as YYYY-MM-DD.")?;
            if date.to_string() != raw {
                return Err("Enter the date as YYYY-MM-DD.".into());
            }
            Ok(json!(raw))
        }
        "tags" => {
            let mut seen = HashSet::new();
            let values: Vec<_> = raw
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .filter(|s| seen.insert(s.to_string()))
                .collect();
            Ok(if values.is_empty() {
                Value::Null
            } else {
                json!(values)
            })
        }
        "text" => Ok(json!(raw)),
        _ => Err("Unsupported field type.".into()),
    }
}
fn folder_name(name: &str) -> Result<()> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name.chars().count() > 100
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c));
    let base = name.split('.').next().unwrap_or("").to_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&base.as_str())
        || (1..=9).any(|i| base == format!("COM{i}") || base == format!("LPT{i}"));
    if bad || reserved {
        Err(format!(
            "This value cannot be used as a folder name: {name}"
        ))
    } else {
        Ok(())
    }
}
fn nearest_existing(mut p: &Path) -> Result<&Path> {
    while !p.exists() {
        p = p.parent().ok_or("Check the destination drive.")?;
    }
    Ok(p)
}
fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<String> {
    let mut file = File::open(path).readable()?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 4 * 1024 * 1024];
    loop {
        cancelled(cancel)?;
        let n = file.read(&mut buffer).readable()?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
#[allow(clippy::too_many_arguments)]
fn transfer(
    src: &Path,
    dst: &Path,
    temp: &Path,
    expected: &Signature,
    cross: bool,
    cancel: &AtomicBool,
    progress: &dyn Fn(String),
    phase: &mut dyn FnMut(&str, Option<String>) -> Result<()>,
) -> Result<()> {
    cancelled(cancel)?;
    if signature(src)? != *expected {
        return Err("The source file changed.".into());
    }
    if !cross {
        no_replace(src, dst)?;
        phase("published", None)?;
        return Ok(());
    }
    let result = (|| -> Result<()> {
        let mut source = File::open(src).readable()?;
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp)
            .readable()?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0; 4 * 1024 * 1024];
        let mut total = 0u64;
        loop {
            cancelled(cancel)?;
            let n = source.read(&mut buffer).readable()?;
            if n == 0 {
                break;
            }
            target.write_all(&buffer[..n]).readable()?;
            digest.update(&buffer[..n]);
            total += n as u64;
            progress(format!(
                "Transferred {} / {} MB",
                total / 1_048_576,
                expected.size / 1_048_576
            ));
        }
        target.sync_all().readable()?;
        drop(target);
        drop(source);
        let hash = format!("{:x}", digest.finalize());
        progress("Verifying transfer…".into());
        if total != expected.size
            || hash_file(temp, cancel)? != hash
            || signature(src)? != *expected
        {
            return Err("Transfer verification failed. The source was kept.".into());
        }
        phase("verified", Some(hash))?;
        cancelled(cancel)?;
        no_replace(temp, dst)?;
        phase("published", None)?;
        if signature(src)? != *expected {
            return Err("The source changed, so it was not deleted.".into());
        }
        fs::remove_file(src).readable()
    })();
    if temp.exists() {
        let _ = fs::remove_file(temp);
    }
    result
}

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    fn GetVolumePathNameW(file: *const u16, volume: *mut u16, len: u32) -> i32;
    fn GetVolumeNameForVolumeMountPointW(mount: *const u16, name: *mut u16, len: u32) -> i32;
}
#[cfg(windows)]
fn no_replace(src: &Path, dst: &Path) -> Result<()> {
    // Deliberately omit MOVEFILE_REPLACE_EXISTING and COPY_ALLOWED.
    if unsafe { MoveFileExW(wide(src).as_ptr(), wide(dst).as_ptr(), 0x8) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
#[cfg(target_os = "linux")]
fn no_replace(src: &Path, dst: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let src = std::ffi::CString::new(src.as_os_str().as_bytes()).readable()?;
    let dst = std::ffi::CString::new(dst.as_os_str().as_bytes()).readable()?;
    if unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            src.as_ptr(),
            libc::AT_FDCWD,
            dst.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
#[cfg(not(any(windows, target_os = "linux")))]
fn no_replace(src: &Path, dst: &Path) -> Result<()> {
    fs::hard_link(src, dst).readable()?;
    fs::remove_file(src).readable()
}
#[cfg(windows)]
fn volume_id(path: &Path) -> Result<String> {
    let mut buffer = vec![0u16; 32768];
    if unsafe {
        GetVolumePathNameW(
            wide(path).as_ptr(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut volume = vec![0u16; 32768];
    if unsafe {
        GetVolumeNameForVolumeMountPointW(buffer.as_ptr(), volume.as_mut_ptr(), volume.len() as u32)
    } != 0
    {
        buffer = volume;
    }
    let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    Ok(String::from_utf16_lossy(&buffer[..len]).to_lowercase())
}
#[cfg(unix)]
fn volume_id(path: &Path) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    Ok(fs::metadata(path).readable()?.dev().to_string())
}
fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn launch(path: &Path, player: &str) -> Result<()> {
    use std::process::Command;
    if !player.is_empty() {
        Command::new(player).arg(path).spawn().readable()?;
        return Ok(());
    }
    #[cfg(windows)]
    {
        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteW(
                window: *mut std::ffi::c_void,
                operation: *const u16,
                file: *const u16,
                args: *const u16,
                directory: *const u16,
                show: i32,
            ) -> isize;
        }
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                wide(path).as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if result <= 32 {
            return Err(format!(
                "Could not open with the default player (code {result}). Set a player in settings."
            ));
        }
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open").arg(path).spawn().readable()?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
