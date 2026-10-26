//! Optional ffprobe support: finding an installed copy, installing one with winget,
//! and reading duration and resolution from its JSON output.
use crate::catalog::Result;
use crate::media_info::MediaInfo;
use serde_json::Value;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const EXE: &str = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
/// winget package with a small FFmpeg build that includes ffprobe; installs per user, no admin rights.
pub const WINGET_PACKAGE: &str = "Gyan.FFmpeg.Essentials";
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Builds a command that never flashes a console window on Windows.
fn quiet(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.stdin(Stdio::null());
    command
}

/// First line of `ffprobe -version` when `path` is a working ffprobe.
pub fn version(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let output = quiet(path).arg("-version").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    line.starts_with("ffprobe version").then(|| line.to_string())
}

/// Places ffprobe is commonly installed: PATH, winget, Chocolatey, Scoop, and manual folders.
fn candidates() -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join(EXE)).collect())
        .unwrap_or_default();
    let env = |key: &str| std::env::var_os(key).map(PathBuf::from);
    if let Some(local) = env("LOCALAPPDATA") {
        let winget = local.join("Microsoft").join("WinGet");
        // A fresh winget install updates the user PATH, but not this process's copy of it.
        found.push(winget.join("Links").join(EXE));
        if let Ok(packages) = std::fs::read_dir(winget.join("Packages")) {
            for package in packages.flatten().filter(|p| p.file_name().to_string_lossy().contains("FFmpeg")) {
                if let Ok(builds) = std::fs::read_dir(package.path()) {
                    found.extend(builds.flatten().map(|b| b.path().join("bin").join(EXE)));
                }
            }
        }
    }
    if let Some(data) = env("ProgramData") {
        found.push(data.join("chocolatey").join("bin").join(EXE));
    }
    if let Some(home) = env("USERPROFILE") {
        found.push(home.join("scoop").join("shims").join(EXE));
    }
    if let Some(programs) = env("ProgramFiles") {
        found.push(programs.join("ffmpeg").join("bin").join(EXE));
    }
    found.push(PathBuf::from(r"C:\ffmpeg\bin").join(EXE));
    found
}

/// The first working ffprobe found on this computer.
pub fn detect() -> Option<PathBuf> {
    candidates().into_iter().find(|p| version(p).is_some())
}

pub fn winget_available() -> bool {
    cfg!(windows)
        && quiet(Path::new("winget"))
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
}

/// Installs FFmpeg (with ffprobe) through winget, reporting its output, then looks for ffprobe.
pub fn install(cancel: &AtomicBool, progress: &dyn Fn(String)) -> Result<PathBuf> {
    if !winget_available() {
        return Err("winget is not available on this computer. Install ffprobe manually and choose ffprobe.exe.".into());
    }
    progress(format!("Installing {WINGET_PACKAGE} with winget…"));
    let mut child = quiet(Path::new("winget"))
        .args(["install", "--id", WINGET_PACKAGE, "--exact", "--source", "winget"])
        .args(["--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start winget: {e}"))?;
    let (sender, lines) = std::sync::mpsc::channel::<String>();
    let mut stdout = child.stdout.take().ok_or("winget output unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut buffer = [0u8; 1024];
        let mut pending = String::new();
        while let Ok(n) = stdout.read(&mut buffer) {
            if n == 0 {
                break;
            }
            pending.push_str(&String::from_utf8_lossy(&buffer[..n]));
            // Progress bars redraw with carriage returns; treat them as line breaks.
            while let Some(end) = pending.find(['\r', '\n']) {
                let line: String = pending.drain(..=end).collect();
                let line = line.trim();
                if !line.is_empty() {
                    let _ = sender.send(line.to_string());
                }
            }
        }
    });
    let mut last = Vec::new();
    let status = loop {
        while let Ok(line) = lines.try_recv() {
            progress(format!("winget: {}", line.chars().take(120).collect::<String>()));
            last.push(line);
            if last.len() > 5 {
                last.remove(0);
            }
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Installation cancelled.".into());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let _ = reader.join();
    // winget also fails with "already installed"; finding ffprobe is what matters.
    detect().ok_or_else(|| {
        format!(
            "ffprobe was not found after installing (winget exit code {}). {}",
            status.code().unwrap_or(-1),
            last.join(" ")
        )
    })
}

/// Reads one file with ffprobe; values stay empty when ffprobe fails, hangs, or finds no video stream.
pub fn read(ffprobe: &Path, file: &Path) -> MediaInfo {
    let child = quiet(ffprobe)
        .args(["-v", "error", "-print_format", "json"])
        .args(["-show_entries", "format=duration:stream=codec_type,width,height,duration:stream_tags=rotate:stream_side_data=rotation:stream_disposition=attached_pic"])
        .arg(file)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return MediaInfo::default();
    };
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(out) = stdout.as_mut() {
            let _ = out.read_to_string(&mut text);
        }
        text
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    reader.join().map(|text| parse(&text)).unwrap_or_default()
}

/// Duration from the container (or the video stream), size from the first real video stream;
/// cover images stored as video streams are skipped, and 90°/270° rotation swaps the sides.
pub fn parse(json: &str) -> MediaInfo {
    let Ok(root) = serde_json::from_str::<Value>(json) else {
        return MediaInfo::default();
    };
    let seconds = |v: &Value| v.as_str().and_then(|s| s.parse::<f64>().ok()).filter(|s| s.is_finite() && *s > 0.0);
    let video = root["streams"].as_array().and_then(|streams| {
        streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"].as_i64() != Some(1))
    });
    let duration = seconds(&root["format"]["duration"]).or_else(|| video.and_then(|v| seconds(&v["duration"])));
    let (mut width, mut height) = (
        video.and_then(|v| v["width"].as_i64()).filter(|w| *w > 0),
        video.and_then(|v| v["height"].as_i64()).filter(|h| *h > 0),
    );
    let rotation = video
        .and_then(|v| {
            v["side_data_list"]
                .as_array()
                .and_then(|list| list.iter().find_map(|d| d["rotation"].as_f64()))
                .or_else(|| v["tags"]["rotate"].as_str().and_then(|r| r.parse().ok()))
        })
        .unwrap_or(0.0);
    if (rotation.abs() as i64) % 180 == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    MediaInfo {
        duration_ms: duration.map(|s| (s * 1000.0).round() as i64),
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_duration_size_rotation_and_skips_cover_art() {
        let info = parse(r#"{"streams":[
            {"codec_type":"video","width":600,"height":600,"disposition":{"attached_pic":1}},
            {"codec_type":"audio"},
            {"codec_type":"video","width":1920,"height":1080,"duration":"10.0","disposition":{"attached_pic":0}}],
            "format":{"duration":"7100.456"}}"#);
        assert_eq!(info, MediaInfo { duration_ms: Some(7_100_456), width: Some(1920), height: Some(1080) });

        let phone = parse(r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,"duration":"4.5",
            "side_data_list":[{"rotation":-90}]}],"format":{}}"#);
        assert_eq!(phone, MediaInfo { duration_ms: Some(4500), width: Some(1080), height: Some(1920) });

        let tagged = parse(r#"{"streams":[{"codec_type":"video","width":1280,"height":720,"tags":{"rotate":"270"}}],"format":{"duration":"N/A"}}"#);
        assert_eq!(tagged, MediaInfo { duration_ms: None, width: Some(720), height: Some(1280) });

        assert_eq!(parse(""), MediaInfo::default());
        assert_eq!(parse(r#"{"streams":[{"codec_type":"audio"}],"format":{"duration":"3"}}"#).width, None);
    }

    #[test]
    fn missing_or_wrong_programs_are_not_ffprobe() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(version(&temp.path().join(EXE)), None);
        let fake = temp.path().join("fake.exe");
        std::fs::write(&fake, b"not a program").unwrap();
        assert_eq!(version(&fake), None);
        assert_eq!(read(&fake, &fake), MediaInfo::default());
    }
}
