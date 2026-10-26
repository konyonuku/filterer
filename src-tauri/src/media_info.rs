//! Duration and resolution of video files: ffprobe when it is available, otherwise
//! (or when ffprobe finds nothing) Windows media properties, the same data Explorer shows.
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MediaInfo {
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

const WORKERS: usize = 4;

/// Reads several files in parallel; the result keeps the input order.
pub fn read_many(paths: &[PathBuf], ffprobe: Option<&Path>) -> Vec<MediaInfo> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results = std::sync::Mutex::new(vec![MediaInfo::default(); paths.len()]);
    std::thread::scope(|scope| {
        for _ in 0..WORKERS.min(paths.len()) {
            scope.spawn(|| {
                let _com = com::init();
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(path) = paths.get(i) else { break };
                    let info = ffprobe
                        .map(|exe| crate::ffprobe::read(exe, path))
                        .filter(|info| *info != MediaInfo::default())
                        .unwrap_or_else(|| read(path));
                    results.lock().unwrap()[i] = info;
                }
            });
        }
    });
    results.into_inner().unwrap()
}

#[cfg(windows)]
mod com {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    /// COM stays initialized for the worker thread while this guard lives.
    pub struct Guard(bool);
    pub fn init() -> Guard {
        Guard(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
}

#[cfg(not(windows))]
mod com {
    pub fn init() {}
}

#[cfg(windows)]
fn read(path: &std::path::Path) -> MediaInfo {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::Storage::EnhancedStorage::{
        PKEY_Media_Duration, PKEY_Video_FrameHeight, PKEY_Video_FrameWidth,
    };
    use windows::Win32::System::Com::StructuredStorage::{PropVariantToUInt32, PropVariantToUInt64};
    use windows::Win32::System::Com::IBindCtx;
    use windows::Win32::UI::Shell::PropertiesSystem::{
        IPropertyStore, SHGetPropertyStoreFromParsingName, GPS_DEFAULT,
    };
    unsafe {
        let Ok(store) = SHGetPropertyStoreFromParsingName::<_, _, IPropertyStore>(
            // The shell parser expects backslashes; forward slashes make it fail.
            &HSTRING::from(path.to_string_lossy().replace('/', "\\")),
            None::<&IBindCtx>,
            GPS_DEFAULT,
        ) else {
            return MediaInfo::default();
        };
        let number = |key: &PROPERTYKEY, wide: bool| -> Option<i64> {
            let value = store.GetValue(key).ok()?;
            let n = if wide {
                PropVariantToUInt64(&value).ok()? as i64
            } else {
                PropVariantToUInt32(&value).ok()? as i64
            };
            (n > 0).then_some(n)
        };
        MediaInfo {
            // System.Media.Duration is in 100-nanosecond units.
            duration_ms: number(&PKEY_Media_Duration, true).map(|d| d / 10_000),
            width: number(&PKEY_Video_FrameWidth, false),
            height: number(&PKEY_Video_FrameHeight, false),
        }
    }
}

#[cfg(not(windows))]
fn read(_path: &std::path::Path) -> MediaInfo {
    MediaInfo::default()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// A minimal AVI header: Windows reads duration and size from it without decoding frames.
    fn avi(width: u32, height: u32, fps: u32, frames: u32) -> Vec<u8> {
        let mut movi = Vec::new();
        for _ in 0..frames {
            movi.extend(b"00dc");
            movi.extend(4u32.to_le_bytes());
            movi.extend([0xFF, 0xD8, 0xFF, 0xD9]);
        }
        let mut avih = Vec::new();
        for v in [1_000_000 / fps, 0, 0, 0x10, frames, 0, 1, 4, width, height, 0, 0, 0, 0] {
            avih.extend(v.to_le_bytes());
        }
        let mut strh = Vec::new();
        strh.extend(b"vidsMJPG");
        for v in [0u32, 0, 0, 1, fps, 0, frames, 4, u32::MAX, 0] {
            strh.extend(v.to_le_bytes());
        }
        for v in [0u16, 0, width as u16, height as u16] {
            strh.extend(v.to_le_bytes());
        }
        let mut strf = Vec::new();
        strf.extend(40u32.to_le_bytes());
        strf.extend(width.to_le_bytes());
        strf.extend(height.to_le_bytes());
        strf.extend(1u16.to_le_bytes());
        strf.extend(24u16.to_le_bytes());
        strf.extend(b"MJPG");
        for v in [width * height * 3, 0, 0, 0, 0] {
            strf.extend(v.to_le_bytes());
        }
        let chunk = |id: &[u8], body: &[u8]| [id, &(body.len() as u32).to_le_bytes(), body].concat();
        let list = |kind: &[u8], body: &[u8]| chunk(b"LIST", &[kind, body].concat());
        let strl = list(b"strl", &[chunk(b"strh", &strh), chunk(b"strf", &strf)].concat());
        let hdrl = list(b"hdrl", &[chunk(b"avih", &avih), strl].concat());
        chunk(b"RIFF", &[b"AVI ".as_slice(), &hdrl, &list(b"movi", &movi)].concat())
    }

    #[test]
    fn reads_avi_header_and_skips_unreadable_files() {
        let temp = tempfile::tempdir().unwrap();
        let good = temp.path().join("clip é.avi");
        let bad = temp.path().join("bytes.mp4");
        std::fs::write(&good, avi(320, 180, 10, 40)).unwrap();
        std::fs::write(&bad, b"synthetic test bytes").unwrap();
        let infos = read_many(&[good, bad, temp.path().join("missing.mkv")], None);
        assert_eq!(
            infos[0],
            MediaInfo { duration_ms: Some(4000), width: Some(320), height: Some(180) }
        );
        assert_eq!(infos[1].duration_ms, None);
        assert_eq!(infos[2], MediaInfo::default());
    }
}

/// Manual check against real files: `FILTERER_PROBE_DIR=<folder> [FILTERER_FFPROBE=<ffprobe.exe>] cargo test -- --ignored --nocapture probe_folder`.
#[cfg(test)]
#[test]
#[ignore]
fn probe_folder() {
    let dir = std::env::var("FILTERER_PROBE_DIR").expect("set FILTERER_PROBE_DIR");
    let paths: Vec<PathBuf> = walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && crate::catalog::VIDEOS.contains(&e.path().extension().unwrap_or_default().to_string_lossy().to_lowercase().as_str()))
        .map(|e| e.into_path())
        .collect();
    let started = std::time::Instant::now();
    let ffprobe = std::env::var_os("FILTERER_FFPROBE").map(PathBuf::from);
    for (path, info) in paths.iter().zip(read_many(&paths, ffprobe.as_deref())) {
        println!("{:?} {:?}", path.file_name().unwrap(), info);
    }
    println!("{} files in {:?}", paths.len(), started.elapsed());
}
