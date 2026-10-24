use super::*;
use tempfile::TempDir;

fn fixture() -> (TempDir, Workspace, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let source = temp.path().join("source");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&source).unwrap();
    let ws = Workspace::open(&root).unwrap();
    (temp, ws, source)
}
fn write(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, b"synthetic test bytes").unwrap();
}
fn scan(ws: &mut Workspace, source: &Path) {
    ws.add_source(source, true).unwrap();
    ws.scan(&AtomicBool::new(false), &|_| {}).unwrap();
}
fn prepare(ws: &mut Workspace, source: &Path) -> (i64, i64) {
    write(&source.join("Café vidéo.mp4"));
    scan(ws, source);
    ws.add_field("Performers", "tags").unwrap();
    let id = ws.videos().unwrap()[0].id;
    let field = ws.fields().unwrap()[0].id;
    ws.set_values(&[id], field, json!("Person A, Person B"))
        .unwrap();
    (id, field)
}
fn preview(ws: &mut Workspace, id: i64, field: i64) -> MovePlan {
    ws.plan(&[id], field, "group", "Ensemble", &HashMap::new())
        .unwrap()
}

#[test]
fn workspace_lock_and_reopen() {
    let (_temp, ws, _) = fixture();
    let root = ws.root.clone();
    assert!(Workspace::open(&root).is_err());
    drop(ws);
    assert!(Workspace::open(&root).is_ok());
}
#[test]
fn scan_overlapping_and_nonrecursive_preserves_metadata() {
    let (_temp, mut ws, source) = fixture();
    write(&source.join("first.mp4"));
    write(&source.join("nested/second.MKV"));
    write(&source.join("notes.txt"));
    ws.add_source(&source, false).unwrap();
    ws.scan(&AtomicBool::new(false), &|_| {}).unwrap();
    assert_eq!(ws.videos().unwrap().len(), 1);
    ws.add_field("Score", "number").unwrap();
    let id = ws.videos().unwrap()[0].id;
    ws.set_values(&[id], 1, json!(90)).unwrap();
    scan(&mut ws, &source);
    ws.add_source(&source.join("nested"), true).unwrap();
    ws.scan(&AtomicBool::new(false), &|_| {}).unwrap();
    assert_eq!(ws.videos().unwrap().len(), 2);
    assert_eq!(
        ws.videos()
            .unwrap()
            .iter()
            .find(|v| v.id == id)
            .unwrap()
            .values["1"],
        json!(90.0)
    );
}
#[test]
fn move_related_files_preserves_ids_metadata_and_images() {
    let (_temp, mut ws, source) = fixture();
    let (id, field) = prepare(&mut ws, &source);
    let image = source.join("Café vidéo-poster.jpg");
    write(&image);
    write(&source.join("Café vidéo.ko.srt"));
    write(&source.join("Café vidéo.nfo"));
    ws.add_image(id, &image, true).unwrap();
    let plan = preview(&mut ws, id, field);
    assert!(plan.errors.is_empty());
    assert_eq!(plan.items.len(), 4);
    ws.execute(&plan.id, false, &AtomicBool::new(false), &|_| {})
        .unwrap();
    let video = ws.videos().unwrap().remove(0);
    assert_eq!(video.id, id);
    assert_eq!(
        video.values[&field.to_string()],
        json!(["Person A", "Person B"])
    );
    assert!(Path::new(&video.path).exists());
    assert!(!source.join("Café vidéo.mp4").exists());
    assert!(video.images[0].path.contains("Ensemble"));
    scan(&mut ws, &source);
    assert_eq!(ws.videos().unwrap().len(), 1);
    assert_eq!(ws.history().unwrap()[0].status, "complete");
}
#[test]
fn existing_destination_and_racing_destination_never_overwrite() {
    let (_temp, mut ws, source) = fixture();
    let (id, field) = prepare(&mut ws, &source);
    let plan = preview(&mut ws, id, field);
    let target = &plan.items[0].target;
    write(target);
    fs::write(target, b"keep destination").unwrap();
    assert!(ws
        .execute(&plan.id, false, &AtomicBool::new(false), &|_| {})
        .is_err());
    assert_eq!(fs::read(target).unwrap(), b"keep destination");
    assert!(source.join("Café vidéo.mp4").exists());
    assert!(!preview(&mut ws, id, field).errors.is_empty());
}
#[test]
fn duplicate_names_in_same_batch_block_whole_plan() {
    let (_temp, mut ws, source) = fixture();
    write(&source.join("a/same.mp4"));
    write(&source.join("b/same.mp4"));
    scan(&mut ws, &source);
    ws.add_field("Category", "text").unwrap();
    let ids: Vec<_> = ws.videos().unwrap().iter().map(|v| v.id).collect();
    ws.set_values(&ids, 1, json!("Same category")).unwrap();
    let plan = ws
        .plan(&ids, 1, "group", "Multiple", &HashMap::new())
        .unwrap();
    assert!(!plan.errors.is_empty());
    assert!(ws
        .execute(&plan.id, true, &AtomicBool::new(false), &|_| {})
        .is_err());
}
#[test]
fn source_changed_after_preview_is_rejected() {
    let (_temp, mut ws, source) = fixture();
    let (id, field) = prepare(&mut ws, &source);
    let plan = preview(&mut ws, id, field);
    fs::write(&plan.items[0].source, b"changed bytes of different length").unwrap();
    assert!(ws
        .execute(&plan.id, false, &AtomicBool::new(false), &|_| {})
        .is_err());
}
#[test]
fn multiple_values_need_destination_and_shared_files_warn() {
    let (_temp, mut ws, source) = fixture();
    let (id, field) = prepare(&mut ws, &source);
    write(&source.join("second.mp4"));
    write(&source.join("cover.jpg"));
    let plan = ws
        .plan(&[id], field, "ask", "Ensemble", &HashMap::new())
        .unwrap();
    assert!(!plan.errors.is_empty());
    let plan = ws
        .plan(
            &[id],
            field,
            "ask",
            "Ensemble",
            &HashMap::from([(id.to_string(), "Person A".into())]),
        )
        .unwrap();
    assert!(plan.errors.is_empty());
    assert_eq!(plan.warnings.len(), 1);
}
#[test]
fn shared_registered_image_blocks_move() {
    let (_temp, mut ws, source) = fixture();
    let (id, field) = prepare(&mut ws, &source);
    write(&source.join("other.mp4"));
    scan(&mut ws, &source);
    let image = source.join("cover.jpg");
    write(&image);
    for v in ws.videos().unwrap() {
        ws.add_image(v.id, &image, true).unwrap();
    }
    assert!(!preview(&mut ws, id, field).errors.is_empty());
}
#[test]
fn cancelled_operation_is_resumable() {
    let (_temp, mut ws, source) = fixture();
    let (id, field) = prepare(&mut ws, &source);
    let plan = preview(&mut ws, id, field);
    assert!(ws
        .execute(&plan.id, false, &AtomicBool::new(true), &|_| {})
        .is_err());
    assert_eq!(ws.history().unwrap()[0].status, "stopped");
    ws.resume_plan(&plan.id).unwrap();
    ws.execute(&plan.id, false, &AtomicBool::new(false), &|_| {})
        .unwrap();
    assert_eq!(ws.history().unwrap()[0].status, "complete");
}
#[test]
fn interrupted_rename_reconciles_before_remaining_sidecar_retry() {
    let (_temp, mut ws, source) = fixture();
    let (id, field) = prepare(&mut ws, &source);
    write(&source.join("Café vidéo.nfo"));
    let mut plan = preview(&mut ws, id, field);
    let item = &plan.items[0];
    fs::create_dir_all(item.target.parent().unwrap()).unwrap();
    no_replace(&item.source, &item.target).unwrap();
    plan.items[0].state = "moving".into();
    ws.journal(&plan, "attention").unwrap();
    assert_eq!(ws.reconcile().unwrap(), 0);
    ws.resume_plan(&plan.id).unwrap();
    ws.execute(&plan.id, false, &AtomicBool::new(false), &|_| {})
        .unwrap();
    assert!(ws.root.join("videos/Ensemble/Café vidéo.nfo").exists());
    assert!(!source.join("Café vidéo.nfo").exists());
}
#[test]
fn recovery_never_deletes_both_existing_copies() {
    let (_temp, mut ws, source) = fixture();
    let (id, field) = prepare(&mut ws, &source);
    let mut plan = preview(&mut ws, id, field);
    let item = &plan.items[0];
    fs::create_dir_all(item.target.parent().unwrap()).unwrap();
    fs::copy(&item.source, &item.target).unwrap();
    plan.items[0].state = "published".into();
    ws.journal(&plan, "attention").unwrap();
    assert_eq!(ws.reconcile().unwrap(), 1);
    assert!(plan.items[0].source.exists());
    assert!(plan.items[0].target.exists());
    assert!(preview_pending(&mut ws, id, field));
}
fn preview_pending(ws: &mut Workspace, id: i64, field: i64) -> bool {
    ws.plan(&[id], field, "group", "Ensemble", &HashMap::new())
        .is_err()
}
#[test]
fn forced_cross_volume_branch_verifies_then_deletes() {
    let (temp, _ws, source) = fixture();
    let src = source.join("a.mp4");
    fs::write(&src, vec![3u8; 5 * 1024 * 1024]).unwrap();
    let dst = temp.path().join("target.mp4");
    let partial = temp.path().join("partial");
    let sig = signature(&src).unwrap();
    let mut phases = Vec::new();
    transfer(
        &src,
        &dst,
        &partial,
        &sig,
        true,
        &AtomicBool::new(false),
        &|_| {},
        &mut |phase, _| {
            phases.push(phase.to_string());
            Ok(())
        },
    )
    .unwrap();
    assert!(!src.exists());
    assert!(!partial.exists());
    assert_eq!(fs::metadata(dst).unwrap().len(), sig.size);
    assert_eq!(phases, ["verified", "published"]);
}
#[test]
fn cross_volume_cancellation_preserves_source_and_cleans_partial() {
    let (temp, _ws, source) = fixture();
    let src = source.join("a.mp4");
    write(&src);
    let dst = temp.path().join("target.mp4");
    let partial = temp.path().join("partial");
    let sig = signature(&src).unwrap();
    let cancel = AtomicBool::new(false);
    assert!(transfer(
        &src,
        &dst,
        &partial,
        &sig,
        true,
        &cancel,
        &|_| cancel.store(true, Ordering::Relaxed),
        &mut |_, _| Ok(())
    )
    .is_err());
    assert!(src.exists());
    assert!(!dst.exists());
    assert!(!partial.exists());
}
#[test]
fn move_primitive_never_overwrites() {
    let (temp, _ws, source) = fixture();
    let src = source.join("a.mp4");
    write(&src);
    let dst = temp.path().join("b.mp4");
    fs::write(&dst, b"keep").unwrap();
    assert!(no_replace(&src, &dst).is_err());
    assert!(src.exists());
    assert_eq!(fs::read(dst).unwrap(), b"keep");
}
#[test]
fn fields_reject_invalid_values_and_batch_is_atomic() {
    let (_temp, mut ws, source) = fixture();
    let (id, _) = prepare(&mut ws, &source);
    ws.add_field("Score", "number").unwrap();
    assert!(ws.set_values(&[id], 2, json!("NaN")).is_err());
    assert!(ws.set_values(&[id, 999999], 2, json!(90)).is_err());
    assert!(ws.videos().unwrap()[0].values["2"].is_null());
    assert!(typed_value("date", json!("2026-02-30")).is_err());
    assert_eq!(
        typed_value("tags", json!(" A, B, A ")).unwrap(),
        json!(["A", "B"])
    );
    for name in ["../outside", "a/b", "CON", "COM1", "a:", "trailing."] {
        assert!(folder_name(name).is_err());
    }
}
#[test]
fn schema_v1_values_and_saved_filters_survive_reopen() {
    let (_temp, mut ws, source) = fixture();
    let (id, field) = prepare(&mut ws, &source);
    let query = json!({"mode":"AND", "search":"", "rules":[{"field":field.to_string(),"op":"eq","value":"Person A"}]});
    ws.save_filter("Person A", &query).unwrap();
    let root = ws.root.clone();
    drop(ws);
    let ws = Workspace::open(&root).unwrap();
    let snapshot = ws.snapshot().unwrap();
    assert_eq!(snapshot.videos[0].id, id);
    assert_eq!(snapshot.folders[0].query, query);
}
#[test]
fn scan_3000_small_videos_and_updates_without_duplication() {
    let (_temp, mut ws, source) = fixture();
    for n in 0..3000 {
        write(&source.join(format!("{n:04}.mp4")));
    }
    scan(&mut ws, &source);
    assert_eq!(ws.videos().unwrap().len(), 3000);
    scan(&mut ws, &source);
    assert_eq!(ws.videos().unwrap().len(), 3000);
}
#[test]
fn column_and_filter_order_persist_and_reject_invalid_values() {
    let (_temp, ws, _source) = fixture();
    assert!(ws.snapshot().unwrap().column_order.is_empty());
    ws.set_setting("column_order", json!(["size", "1", "name"]))
        .unwrap();
    ws.set_setting("filter_order", json!(["2", "1"])).unwrap();
    assert!(ws.set_setting("filter_order", json!("1,2")).is_err());
    let root = ws.root.clone();
    drop(ws);
    let snapshot = Workspace::open(&root).unwrap().snapshot().unwrap();
    assert_eq!(snapshot.column_order, ["size", "1", "name"]);
    assert_eq!(snapshot.filter_order, ["2", "1"]);
}

#[test]
fn options_default_validate_and_rename_unclassified_folder() {
    let (_temp, mut ws, source) = fixture();
    let defaults = ws.options().unwrap();
    assert_eq!(defaults.unclassified_folder, "Unclassified");
    assert_eq!(defaults.shared_folder, "Multiple values");
    assert_eq!((defaults.page_size, defaults.visible_fields), (100, 6));

    let bad = |change: fn(&mut Options)| {
        let mut options = Options::default();
        change(&mut options);
        options
    };
    assert!(ws.set_options(&bad(|o| o.unclassified_folder = "a/b".into())).is_err());
    assert!(ws.set_options(&bad(|o| o.shared_folder = " ".into())).is_err());
    assert!(ws.set_options(&bad(|o| o.page_size = 123)).is_err());
    assert!(ws.set_options(&bad(|o| o.visible_fields = 0)).is_err());
    assert_eq!(ws.options().unwrap().page_size, 100);

    ws.set_options(&Options {
        unclassified_folder: " No value ".into(),
        shared_folder: "Several".into(),
        page_size: 50,
        visible_fields: 3,
    })
    .unwrap();
    let saved = ws.snapshot().unwrap().options;
    assert_eq!(saved.unclassified_folder, "No value");
    assert_eq!((saved.shared_folder.as_str(), saved.page_size, saved.visible_fields), ("Several", 50, 3));

    write(&source.join("plain.mp4"));
    scan(&mut ws, &source);
    ws.add_field("Studio", "text").unwrap();
    let id = ws.videos().unwrap()[0].id;
    let field = ws.fields().unwrap()[0].id;
    let plan = preview(&mut ws, id, field);
    assert_eq!(plan.items[0].target, ws.root.join("videos").join("No value").join("plain.mp4"));
}

#[test]
fn rating_accepts_half_steps_and_keeps_unrated_apart_from_zero() {
    let (_temp, mut ws, source) = fixture();
    write(&source.join("a.mp4"));
    write(&source.join("b.mp4"));
    scan(&mut ws, &source);
    ws.add_field("Stars", "rating").unwrap();
    let field = ws.fields().unwrap()[0].id;
    let ids: Vec<i64> = ws.videos().unwrap().iter().map(|v| v.id).collect();
    for ok in ["0", "0.5", "3.5", "5", "4.0"] {
        ws.set_values(&ids[..1], field, json!(ok)).unwrap();
    }
    ws.set_values(&ids[..1], field, json!(4.5)).unwrap();
    for bad in ["-0.5", "5.5", "3.2", "abc", "NaN", "inf"] {
        assert!(ws.set_values(&ids[..1], field, json!(bad)).is_err(), "{bad}");
    }
    ws.set_values(&ids[1..], field, json!("0")).unwrap();
    let videos = ws.videos().unwrap();
    let value = |id: i64| videos.iter().find(|v| v.id == id).unwrap().values.get(&field.to_string()).cloned();
    assert_eq!(value(ids[0]), Some(json!(4.5)));
    assert_eq!(value(ids[1]), Some(json!(0.0)));
    ws.set_values(&ids[1..], field, json!("")).unwrap();
    let videos = ws.videos().unwrap();
    let cleared = videos.iter().find(|v| v.id == ids[1]).unwrap().values.get(&field.to_string()).cloned();
    assert!(matches!(cleared, None | Some(Value::Null)));
}

#[test]
fn column_widths_are_validated_and_returned() {
    let (_temp, ws, _source) = fixture();
    assert!(ws.snapshot().unwrap().column_widths.is_empty());
    assert!(ws.set_setting("column_widths", json!({"name": 10})).is_err());
    assert!(ws.set_setting("column_widths", json!({"name": "wide"})).is_err());
    assert!(ws.set_setting("column_widths", json!(["name"])).is_err());
    ws.set_setting("column_widths", json!({"name": 320, "size": 90.5})).unwrap();
    let widths = ws.snapshot().unwrap().column_widths;
    assert_eq!((widths["name"], widths["size"]), (320.0, 90.5));
    ws.set_setting("column_widths", json!({})).unwrap();
    assert!(ws.snapshot().unwrap().column_widths.is_empty());
}

#[test]
fn hidden_columns_are_a_list_of_names() {
    let (_temp, ws, _source) = fixture();
    assert_eq!(ws.snapshot().unwrap().hidden_columns, vec!["last_played", "format", "folder"]);
    assert!(ws.set_setting("hidden_columns", json!({"size": true})).is_err());
    ws.set_setting("hidden_columns", json!(["size", "3"])).unwrap();
    assert_eq!(ws.snapshot().unwrap().hidden_columns, vec!["size", "3"]);
}

#[test]
fn plays_are_recorded_and_reset() {
    let (_temp, mut ws, source) = fixture();
    write(&source.join("a.mp4"));
    write(&source.join("b.mp4"));
    scan(&mut ws, &source);
    let ids: Vec<i64> = ws.videos().unwrap().iter().map(|v| v.id).collect();
    assert!(ws.videos().unwrap().iter().all(|v| v.plays == 0 && v.last_played.is_none()));
    ws.record_plays(&[ids[0], ids[0], ids[1]]).unwrap();
    ws.record_plays(&ids[..1]).unwrap();
    let videos = ws.videos().unwrap();
    let get = |id: i64| videos.iter().find(|v| v.id == id).unwrap().clone();
    assert_eq!((get(ids[0]).plays, get(ids[1]).plays), (2, 1));
    assert!(get(ids[0]).last_played.is_some());
    ws.reset_plays(&ids[..1]).unwrap();
    let reset = ws.videos().unwrap().into_iter().find(|v| v.id == ids[0]).unwrap();
    assert_eq!((reset.plays, reset.last_played), (0, None));
    assert!(ws.reset_plays(&[]).is_err());
    assert!(ws.snapshot().unwrap().hidden_columns.contains(&"folder".to_string()));
}

#[test]
fn schema_1_workspace_migrates_and_keeps_hidden_columns() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("old");
    fs::create_dir_all(root.join(".video-workspace")).unwrap();
    {
        let db = Connection::open(root.join(".video-workspace").join("catalog.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE media(id INTEGER PRIMARY KEY,path TEXT UNIQUE NOT NULL,size INTEGER NOT NULL,modified INTEGER NOT NULL,metadata TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            INSERT INTO media(path,size,modified) VALUES ('C:\\v\\old.mp4',5,1);
            INSERT INTO settings VALUES ('hidden_columns','[\"size\"]');
            PRAGMA user_version=1;").unwrap();
    }
    let ws = Workspace::open(&root).unwrap();
    let video = &ws.videos().unwrap()[0];
    assert_eq!((video.plays, video.last_played, video.duration_ms), (0, None, None));
    assert_eq!(ws.snapshot().unwrap().hidden_columns, vec!["size", "last_played", "format", "folder"]);
    drop(ws);
    let ws = Workspace::open(&root).unwrap();
    assert_eq!(ws.snapshot().unwrap().hidden_columns.len(), 4);
}

#[test]
fn scan_caches_media_info_until_the_file_changes() {
    let (_temp, mut ws, source) = fixture();
    write(&source.join("a.mp4"));
    scan(&mut ws, &source);
    let pending = |ws: &Workspace| -> i64 {
        ws.db
            .query_row("SELECT count(*) FROM media WHERE info_size IS NOT size OR info_modified IS NOT modified", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(pending(&ws), 0);
    assert_eq!(ws.videos().unwrap()[0].duration_ms, None);
    ws.db.execute("UPDATE media SET size=size+1", []).unwrap();
    assert_eq!(pending(&ws), 1);
    ws.scan(&AtomicBool::new(false), &|_| {}).unwrap();
    assert_eq!(pending(&ws), 0);
}
