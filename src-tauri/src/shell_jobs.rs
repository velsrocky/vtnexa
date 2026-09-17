// Background shell jobs: `shell_run` with a poll loop instead of a 30s wall.
// Long work (npm install, builds, test suites) goes here; fast commands keep
// using shell_run. Same screening as shell_run (deny list runs at spawn),
// same workspace confinement. Jobs are collected once: the first poll that
// sees the exit removes the job and returns full (truncated) output.
// Output files are capped (2MB — the job is killed past that) and deleted on
// collect/kill; remaining jobs are reaped when the last window closes.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_JOBS: usize = 8;
const MAX_JOB_AGE: Duration = Duration::from_secs(30 * 60);
const MAX_JOB_FILE_BYTES: u64 = 2 * 1024 * 1024;
const TAIL_CHARS: usize = 8000;

pub(crate) struct ShellJob {
    child: std::process::Child,
    out_path: std::path::PathBuf,
    err_path: std::path::PathBuf,
    started: Instant,
    cmd_preview: String,
}

#[derive(Default)]
pub(crate) struct ShellJobs(pub Mutex<HashMap<String, ShellJob>>);

#[derive(Debug, Serialize)]
pub(crate) struct ShellPoll {
    pub status: String,
    pub code: Option<i32>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub elapsed_ms: u64,
}

pub(crate) fn valid_job_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 || !id.starts_with("job_") {
        return false;
    }
    id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn jobs_dir() -> std::path::PathBuf {
    std::env::temp_dir()
        .join("vtnexa-jobs")
        .join(std::process::id().to_string())
}

fn new_job_id() -> String {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("job_{:x}", nonce)
}

/// Last `max` chars of a file (char-boundary safe), plus total byte size.
pub(crate) fn read_tail(path: &std::path::Path, max: usize) -> (String, u64) {
    let bytes = std::fs::read(path).unwrap_or_default();
    let total = bytes.len() as u64;
    let s = String::from_utf8_lossy(&bytes).to_string();
    if s.len() <= max {
        return (s, total);
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    (
        format!(
            "…[tail: showing last {} of {} chars]\n{}",
            max,
            s.len(),
            &s[start..]
        ),
        total,
    )
}

fn remove_job_files(job: &ShellJob) {
    let _ = std::fs::remove_file(&job.out_path);
    let _ = std::fs::remove_file(&job.err_path);
}

/// Kill + reap + delete files. Idempotent best-effort.
fn kill_job(job: &mut ShellJob) {
    let _ = job.child.kill();
    let _ = job.child.wait();
    remove_job_files(job);
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn shell_bg(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, ShellJobs>,
    ws: tauri::State<'_, crate::WorkspaceRoots>,
    approvals: tauri::State<'_, crate::approvals::ApprovalStore>,
    cwd: String,
    cmd: String,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<String, String> {
    crate::approvals::approval_consume(
        &approvals,
        window.label(),
        "shell_bg",
        &approval_detail,
        &approval_token,
    )?;
    if cmd.is_empty() || cmd.contains('\0') {
        return Err("shell_bg: empty or invalid cmd".to_string());
    }
    if cmd.len() > crate::MAX_CMD_BYTES {
        return Err(format!(
            "shell_bg: cmd too long ({} bytes, max {})",
            cmd.len(),
            crate::MAX_CMD_BYTES
        ));
    }
    // Same backstop as shell_run: refused even if approved blindly.
    if let Some(reason) = crate::shell_deny_reason(&cmd) {
        return Err(reason.replace("shell_run:", "shell_bg:"));
    }
    let dir = if cwd.is_empty() || cwd == "." {
        crate::root_snapshot(&ws, window.label())
    } else {
        let safe = crate::checked_path(&ws, window.label(), cwd, "shell_bg.cwd")?;
        if !safe.is_dir() {
            return Err("shell_bg.cwd: not a directory".to_string());
        }
        safe
    };
    let mut map = jobs.0.lock().map_err(|e| e.to_string())?;
    if map.len() >= MAX_JOBS {
        return Err(format!(
            "shell_bg: too many background jobs ({} max) — poll or kill one first",
            MAX_JOBS
        ));
    }
    std::fs::create_dir_all(jobs_dir()).map_err(|e| e.to_string())?;
    let id = new_job_id();
    let out_path = jobs_dir().join(format!("{}.out", id));
    let err_path = jobs_dir().join(format!("{}.err", id));
    let out_file = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
    let err_file = std::fs::File::create(&err_path).map_err(|e| e.to_string())?;
    let child = std::process::Command::new("sh")
        .arg("-c")
        .arg(&cmd)
        .current_dir(&dir)
        .stdout(std::process::Stdio::from(out_file))
        .stderr(std::process::Stdio::from(err_file))
        .spawn()
        .map_err(|e| e.to_string())?;
    let preview: String = cmd.chars().take(120).collect();
    map.insert(
        id.clone(),
        ShellJob {
            child,
            out_path,
            err_path,
            started: Instant::now(),
            cmd_preview: preview,
        },
    );
    Ok(id)
}

#[tauri::command]
pub(crate) fn shell_poll(
    jobs: tauri::State<'_, ShellJobs>,
    id: String,
) -> Result<ShellPoll, String> {
    if !valid_job_id(&id) {
        return Err("shell_poll: invalid job id".to_string());
    }
    let mut map = jobs.0.lock().map_err(|e| e.to_string())?;
    let job = map.get_mut(&id).ok_or_else(|| {
        "shell_poll: unknown job (already collected, killed, or never existed)".to_string()
    })?;
    let elapsed = job.started.elapsed();
    // Guards first: runaway output and runaway runtime die here, loudly.
    let out_size = std::fs::metadata(&job.out_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let err_size = std::fs::metadata(&job.err_path)
        .map(|m| m.len())
        .unwrap_or(0);
    if out_size + err_size > MAX_JOB_FILE_BYTES {
        let preview = job.cmd_preview.clone();
        kill_job(job);
        let dropped = map.remove(&id);
        if let Some(j) = dropped {
            remove_job_files(&j);
        }
        return Err(format!(
            "shell_poll: {} exceeded 2MB output — killed (cmd: {})",
            id, preview
        ));
    }
    if elapsed > MAX_JOB_AGE {
        kill_job(job);
        map.remove(&id);
        return Err(format!("shell_poll: {} exceeded 30min — killed", id));
    }
    match job.child.try_wait().map_err(|e| e.to_string())? {
        None => {
            let (stdout_tail, _) = read_tail(&job.out_path, TAIL_CHARS);
            let (stderr_tail, _) = read_tail(&job.err_path, TAIL_CHARS);
            Ok(ShellPoll {
                status: "running".to_string(),
                code: None,
                stdout_tail,
                stderr_tail,
                elapsed_ms: elapsed.as_millis() as u64,
            })
        }
        Some(status) => {
            let code = status.code().unwrap_or(-1);
            let (stdout_tail, _) = read_tail(&job.out_path, TAIL_CHARS);
            let (stderr_tail, _) = read_tail(&job.err_path, TAIL_CHARS);
            let _ = job.child.wait();
            let finished = map.remove(&id);
            if let Some(j) = finished {
                remove_job_files(&j);
            }
            Ok(ShellPoll {
                status: "done".to_string(),
                code: Some(code),
                stdout_tail: crate::truncate_chars(stdout_tail, crate::MAX_OUT_CHARS),
                stderr_tail: crate::truncate_chars(stderr_tail, crate::MAX_OUT_CHARS),
                elapsed_ms: elapsed.as_millis() as u64,
            })
        }
    }
}

#[tauri::command]
pub(crate) fn shell_kill(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, ShellJobs>,
    approvals: tauri::State<'_, crate::approvals::ApprovalStore>,
    id: String,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<String, String> {
    crate::approvals::approval_consume(
        &approvals,
        window.label(),
        "shell_kill",
        &approval_detail,
        &approval_token,
    )?;
    if !valid_job_id(&id) {
        return Err("shell_kill: invalid job id".to_string());
    }
    let mut map = jobs.0.lock().map_err(|e| e.to_string())?;
    let mut job = map.remove(&id).ok_or_else(|| {
        "shell_kill: unknown job (already collected, killed, or never existed)".to_string()
    })?;
    kill_job(&mut job);
    Ok(format!("killed {}", id))
}

/// Reap everything (last-window close). Best-effort, never throws.
pub(crate) fn kill_all_jobs(state: &ShellJobs) {
    if let Ok(mut map) = state.0.lock() {
        for (_, mut job) in map.drain() {
            kill_job(&mut job);
        }
    }
    let _ = std::fs::remove_dir_all(jobs_dir());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_ids_are_validated() {
        assert!(valid_job_id("job_abc123"));
        assert!(!valid_job_id(""));
        assert!(!valid_job_id("../../etc/passwd"));
        assert!(!valid_job_id("job_a/b"));
        assert!(!valid_job_id(&format!("job_{}", "x".repeat(70))));
        assert!(valid_job_id(&new_job_id()));
    }

    #[test]
    fn tails_are_bounded_and_char_safe() {
        let dir = std::env::temp_dir().join(format!("vtnexa-tailtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("o.txt");
        // Multi-byte content: naive byte slicing would split a char.
        std::fs::write(&p, "héllo wörld — testing tails").unwrap();
        let (full, total) = read_tail(&p, 1000);
        assert_eq!(full, "héllo wörld — testing tails");
        assert!(total > 0);
        let (tail, _) = read_tail(&p, 7);
        assert!(tail.len() <= 1000);
        assert!(tail.is_char_boundary(0) || tail.starts_with("…[tail:"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
