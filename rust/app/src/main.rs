//! WechatVibe Rust entry point.
//!
//! The data layer (crypto, WAL, SQLite shard query, snapshot, native service, Win32 discovery)
//! is already ported and proven in sibling crates. This binary is the process-orchestration
//! layer: it owns startup, readiness, the GUI process, and shutdown, then delegates the
//! 100+ HTTP endpoints to the project's existing backend launcher.
//!
//! Messages are ASCII on purpose: `Start.bat` runs under a GBK console code page, and the
//! original script deliberately avoids non-ASCII output for the same reason.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Locate the installation. The release binary lives at
/// `<root>/rust/app/target/release/wechatvibe.exe`; running from the root also works.
fn project_root() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        let mut candidate = exe.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
        for _ in 0..3 {
            candidate.pop();
        }
        if candidate.join("Start.bat").is_file() && candidate.join("scripts").is_dir() {
            return candidate;
        }
    }
    std::env::current_dir().unwrap_or_default()
}

fn python_exe(root: &Path) -> PathBuf {
    let venv = root.join(".venv/Scripts/python.exe");
    if venv.is_file() {
        venv
    } else {
        PathBuf::from("python")
    }
}

fn hidden(cmd: &mut Command) {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Run a Python helper and parse its last JSON output line into a `serde_json::Value`.
/// Parse a JSON object from stdout, tolerating a non-zero exit when a valid object exists.
/// The status helper intentionally exits 1 when the service is down while still printing
/// `{"state": "unavailable"}` on stdout, so the exit code must not discard that payload.
fn parse_json_line(stdout: &str) -> Option<Value> {
    stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .and_then(|line| serde_json::from_str(line).ok())
}

fn python_json(root: &Path, args: &[&str]) -> Result<Value, String> {
    let mut cmd = Command::new(python_exe(root));
    cmd.current_dir(root)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hidden(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("cannot start Python helper: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(value) = parse_json_line(&stdout) {
        return Ok(value);
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Python helper failed ({}): {}",
            output.status,
            stderr.trim().lines().last().unwrap_or_default()
        ));
    }
    Err("malformed helper output".to_string())
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Read-only self check. Does not start any service.
fn check(root: &Path) -> i32 {
    println!("[root] {}", root.display());

    let py = python_exe(root);
    println!("[python] {}", py.display());
    if !py.is_file() && py.as_os_str() != "python" {
        println!("[fail] Python executable not found");
        return 1;
    }

    let launcher = root.join("scripts/start-real-client.py");
    let shell = root.join("scripts/real-client-shell.cjs");
    let electron = root.join("node_modules/electron/dist/electron.exe");
    for (label, path) in [
        ("launcher", &launcher),
        ("shell", &shell),
        ("electron", &electron),
    ] {
        println!("[{label}] {}", path.display());
        if !path.is_file() {
            println!("[fail] {label} not found");
            return 1;
        }
    }

    match python_json(
        root,
        &["scripts/start-real-client.py", "--status", "--json"],
    ) {
        Ok(status) => println!(
            "[service] {} state={}",
            text_field(&status, "url").unwrap_or_default(),
            text_field(&status, "state").unwrap_or_default()
        ),
        Err(error) => println!("[service] unavailable: {error}"),
    }
    println!("[check] passed");
    0
}

/// Start the backend (without a GUI), open the Electron shell, and clean up on exit.
fn run(root: &Path) -> i32 {
    let launcher = "scripts/start-real-client.py";
    let started = match python_json(root, &[launcher, "--no-open", "--json"]) {
        Ok(value) => value,
        Err(error) => {
            println!("[fail] cannot start local service: {error}");
            return 1;
        }
    };
    if let Some(reason) = text_field(&started, "startupFailure") {
        println!("[fail] startup failure: {reason}");
        return 1;
    }
    let url = match text_field(&started, "url") {
        Some(url) => url,
        None => {
            println!("[fail] service did not report a URL");
            return 1;
        }
    };
    println!("[service] {url}");

    let electron = root.join("node_modules/electron/dist/electron.exe");
    let shell = root.join("scripts/real-client-shell.cjs");
    let mut child = match Command::new(&electron)
        .current_dir(root)
        .arg(&shell)
        .args(["--client-url", &url])
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            println!("[fail] cannot start GUI: {error}");
            stop(root, launcher);
            return 1;
        }
    };
    let status = child.wait();
    stop(root, launcher);
    match status {
        Ok(status) => {
            println!("[gui] exited with {status}");
            status.code().unwrap_or(0)
        }
        Err(error) => {
            println!("[fail] GUI wait failed: {error}");
            1
        }
    }
}

fn stop(root: &Path, launcher: &str) {
    match python_json(root, &[launcher, "--stop-owned-bridge", "--json"]) {
        Ok(value) => println!(
            "[cleanup] stopped={}",
            value
                .get("stopped")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        ),
        Err(error) => println!("[cleanup] skipped: {error}"),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = project_root();
    let code = if args.iter().any(|arg| arg == "--check") {
        check(&root)
    } else if args.iter().any(|arg| arg == "--stop") {
        stop(&root, "scripts/start-real-client.py");
        0
    } else {
        run(&root)
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_field_ignores_empty_strings() {
        let value = serde_json::json!({"url": "http://127.0.0.1:1", "state": ""});
        assert_eq!(text_field(&value, "url"), Some("http://127.0.0.1:1".into()));
        assert_eq!(text_field(&value, "state"), None);
        assert_eq!(text_field(&value, "missing"), None);
    }

    #[test]
    fn project_root_resolves_from_source_tree() {
        // `CARGO_MANIFEST_DIR` is `<root>/rust/app`.
        let app = Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = app.parent().and_then(Path::parent).unwrap();
        assert!(root.join("Start.bat").is_file(), "{}", root.display());
        assert!(root.join("scripts/start-real-client.py").is_file());
    }
}
