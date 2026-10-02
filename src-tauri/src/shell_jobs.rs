use crate::process::{self, CappedFileSink, ProcessEnd, ProcessLimits, ProcessOptions};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const MAX_JOBS: usize = 8;
const MAX_JOB_AGE: Duration = Duration::from_secs(30 * 60);
const MAX_JOB_FILE_BYTES: u64 = 2 * 1024 * 1024;
const TAIL_BYTES: usize = 8000;

#[derive(Debug, Clone)]
struct JobResult {
    code: Option<i32>,
    limit_exceeded: bool,
    timed_out: bool,
    cancelled: bool,
    error: Option<String>,
}

pub(crate) struct SupervisedJob {
    owner: String,
    out_path: std::path::PathBuf,
    err_path: std::path::PathBuf,
    started: Instant,
    cmd_preview: String,
    cancel: Arc<AtomicBool>,
    result: Mutex<Option<JobResult>>,
    done: Condvar,
}

impl SupervisedJob {
    fn new(
        owner: String,
        out_path: std::path::PathBuf,
        err_path: std::path::PathBuf,
        started: Instant,
        cmd_preview: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            owner,
            out_path,
            err_path,
            started,
            cmd_preview,
            cancel: Arc::new(AtomicBool::new(false)),
            result: Mutex::new(None),
            done: Condvar::new(),
        })
    }

    fn complete(&self, result: JobResult) {
        if let Ok(mut slot) = self.result.lock() {
            *slot = Some(result);
            self.done.notify_all();
        }
    }

    fn snapshot(&self) -> Option<JobResult> {
        self.result.lock().ok().and_then(|slot| slot.clone())
    }

    fn wait(&self) -> JobResult {
        let mut slot = match self.result.lock() {
            Ok(slot) => slot,
            Err(_) => {
                return JobResult {
                    code: Some(-1),
                    limit_exceeded: false,
                    timed_out: false,
                    cancelled: false,
                    error: Some("background job state unavailable".to_string()),
                }
            }
        };
        while slot.is_none() {
            slot = match self.done.wait(slot) {
                Ok(slot) => slot,
                Err(_) => {
                    return JobResult {
                        code: Some(-1),
                        limit_exceeded: false,
                        timed_out: false,
                        cancelled: false,
                        error: Some("background job state unavailable".to_string()),
                    }
                }
            };
        }
        slot.clone().unwrap_or(JobResult {
            code: Some(-1),
            limit_exceeded: false,
            timed_out: false,
            cancelled: false,
            error: Some("background job ended without a result".to_string()),
        })
    }

    fn remove_files(&self) {
        let _ = std::fs::remove_file(&self.out_path);
        let _ = std::fs::remove_file(&self.err_path);
    }
}

#[derive(Default)]
pub(crate) struct ShellJobs(pub Mutex<HashMap<String, Arc<SupervisedJob>>>);

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

fn owned_job(
    map: &HashMap<String, Arc<SupervisedJob>>,
    id: &str,
    owner: &str,
    action: &str,
) -> Result<Arc<SupervisedJob>, String> {
    let job = map.get(id).cloned().ok_or_else(|| {
        format!(
            "{}: unknown job (already collected, killed, or never existed)",
            action
        )
    })?;
    if job.owner != owner {
        return Err(format!("{}: job belongs to another window", action));
    }
    Ok(job)
}

fn jobs_dir() -> std::path::PathBuf {
    std::env::temp_dir()
        .join("vtnexa-jobs")
        .join(std::process::id().to_string())
}

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

fn new_job_id() -> String {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let sequence = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);
    format!("job_{:x}_{:x}", nonce, sequence)
}

pub(crate) fn read_tail(path: &std::path::Path, max: usize) -> (String, u64) {
    let total = std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return (String::new(), total),
    };
    let read_len = total.min(max as u64) as usize;
    let start = total.saturating_sub(read_len as u64);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (String::new(), total);
    }
    let mut bytes = vec![0u8; read_len];
    if file.read_exact(&mut bytes).is_err() {
        return (String::new(), total);
    }
    let mut value = String::from_utf8_lossy(&bytes).into_owned();
    if total > max as u64 {
        value = format!(
            "…[tail: showing last {} of {} bytes]\n{}",
            max, total, value
        );
    }
    if value.len() > max {
        let mut end = max;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
    (value, total)
}

fn create_job_file(path: &std::path::Path) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| error.to_string())
}

fn supervise(
    child: process::ManagedChild,
    job: Arc<SupervisedJob>,
    sink: Arc<CappedFileSink>,
    max_age: Duration,
) -> JobResult {
    let stdout_sink = sink.clone();
    let stderr_sink = sink.clone();
    let options = ProcessOptions::new(max_age, ProcessLimits::new(0, 0, 0))
        .with_stdout_hook(Arc::new(move |kind, bytes| stdout_sink.write(kind, bytes)))
        .with_stderr_hook(Arc::new(move |kind, bytes| stderr_sink.write(kind, bytes)))
        .with_cancel(job.cancel.clone());
    match process::run_managed(child, options) {
        Ok(output) if sink.limit_exceeded() || output.end() == ProcessEnd::Stopped => JobResult {
            code: Some(output.code()),
            limit_exceeded: true,
            timed_out: false,
            cancelled: false,
            error: None,
        },
        Ok(output) => JobResult {
            code: Some(output.code()),
            limit_exceeded: false,
            timed_out: false,
            cancelled: output.end() == ProcessEnd::Cancelled,
            error: None,
        },
        Err(process::ProcessError::Timeout(_)) => JobResult {
            code: Some(-1),
            limit_exceeded: false,
            timed_out: true,
            cancelled: false,
            error: None,
        },
        Err(error) => JobResult {
            code: Some(-1),
            limit_exceeded: false,
            timed_out: false,
            cancelled: false,
            error: Some(error.to_string()),
        },
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn shell_bg(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, ShellJobs>,
    ws: tauri::State<'_, crate::WorkspaceRoots>,
    approvals: tauri::State<'_, crate::approvals::ApprovalStore>,
    rate_limiter: tauri::State<'_, crate::rate_limiter::RateLimiter>,
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
    rate_limiter.check_turn(window.label())?;
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
    let mut map = jobs.0.lock().map_err(|error| error.to_string())?;
    let owner_job_count = map
        .values()
        .filter(|job| job.owner == window.label())
        .count();
    if owner_job_count >= MAX_JOBS {
        return Err(format!(
            "shell_bg: too many background jobs ({} max) — poll or kill one first",
            MAX_JOBS
        ));
    }
    std::fs::create_dir_all(jobs_dir()).map_err(|error| error.to_string())?;
    let id = new_job_id();
    let out_path = jobs_dir().join(format!("{}.out", id));
    let err_path = jobs_dir().join(format!("{}.err", id));
    let out_file = match create_job_file(&out_path) {
        Ok(file) => file,
        Err(error) => {
            let _ = std::fs::remove_file(&out_path);
            return Err(error);
        }
    };
    let err_file = match create_job_file(&err_path) {
        Ok(file) => file,
        Err(error) => {
            let _ = std::fs::remove_file(&out_path);
            let _ = std::fs::remove_file(&err_path);
            return Err(error);
        }
    };
    let mut command = crate::sandbox::exec_bg_command(&cmd, &dir);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = match process::spawn_managed(&mut command) {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_file(&out_path);
            let _ = std::fs::remove_file(&err_path);
            return Err(error.to_string());
        }
    };
    let limits = ProcessLimits::new(
        MAX_JOB_FILE_BYTES as usize,
        MAX_JOB_FILE_BYTES as usize,
        MAX_JOB_FILE_BYTES as usize,
    );
    let sink = Arc::new(CappedFileSink::new(out_file, err_file, limits));
    let started = Instant::now();
    let job = SupervisedJob::new(
        window.label().to_string(),
        out_path,
        err_path,
        started,
        cmd.chars().take(120).collect(),
    );
    map.insert(id.clone(), job.clone());
    drop(map);
    let supervisor_job = job.clone();
    std::thread::spawn(move || {
        let result = supervise(child, supervisor_job.clone(), sink, MAX_JOB_AGE);
        supervisor_job.complete(result);
    });
    Ok(id)
}

#[tauri::command]
pub(crate) async fn shell_poll(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, ShellJobs>,
    id: String,
) -> Result<ShellPoll, String> {
    if !valid_job_id(&id) {
        return Err("shell_poll: invalid job id".to_string());
    }
    let (job, result) = {
        let map = jobs.0.lock().map_err(|error| error.to_string())?;
        let job = owned_job(&map, &id, window.label(), "shell_poll")?;
        let result = job.snapshot();
        (job, result)
    };
    let elapsed = job.started.elapsed();
    let (stdout_tail, stderr_tail) = tauri::async_runtime::spawn_blocking({
        let out_path = job.out_path.clone();
        let err_path = job.err_path.clone();
        move || {
            (
                read_tail(&out_path, TAIL_BYTES),
                read_tail(&err_path, TAIL_BYTES),
            )
        }
    })
    .await
    .map_err(|error| format!("shell_poll: reader failed: {}", error))?;
    if let Some(result) = result {
        let removed = {
            let mut map = jobs.0.lock().map_err(|error| error.to_string())?;
            let current = owned_job(&map, &id, window.label(), "shell_poll")?;
            if current.owner != job.owner {
                return Err("shell_poll: job belongs to another window".to_string());
            }
            map.remove(&id)
        };
        if removed.is_none() {
            return Err(
                "shell_poll: unknown job (already collected, killed, or never existed)".to_string(),
            );
        }
        job.remove_files();
        if result.limit_exceeded {
            return Err(format!(
                "shell_poll: {} exceeded 2MB output — killed (cmd: {})",
                id, job.cmd_preview
            ));
        }
        if result.timed_out {
            return Err(format!("shell_poll: {} exceeded 30min — killed", id));
        }
        if let Some(error) = result.error {
            return Err(format!("shell_poll: {} failed: {}", id, error));
        }
        return Ok(ShellPoll {
            status: if result.cancelled {
                "killed".to_string()
            } else {
                "done".to_string()
            },
            code: result.code,
            stdout_tail: crate::truncate_chars(stdout_tail.0, crate::MAX_OUT_CHARS),
            stderr_tail: crate::truncate_chars(stderr_tail.0, crate::MAX_OUT_CHARS),
            elapsed_ms: elapsed.as_millis() as u64,
        });
    }
    Ok(ShellPoll {
        status: "running".to_string(),
        code: None,
        stdout_tail: stdout_tail.0,
        stderr_tail: stderr_tail.0,
        elapsed_ms: elapsed.as_millis() as u64,
    })
}

#[tauri::command]
pub(crate) async fn shell_kill(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, ShellJobs>,
    approvals: tauri::State<'_, crate::approvals::ApprovalStore>,
    id: String,
    approval_token: Option<String>,
    approval_detail: Option<String>,
) -> Result<String, String> {
    if !valid_job_id(&id) {
        return Err("shell_kill: invalid job id".to_string());
    }
    let job = {
        let mut map = jobs.0.lock().map_err(|error| error.to_string())?;
        owned_job(&map, &id, window.label(), "shell_kill")?;
        crate::approvals::approval_consume(
            &approvals,
            window.label(),
            "shell_kill",
            &approval_detail,
            &approval_token,
        )?;
        map.remove(&id).ok_or_else(|| {
            "shell_kill: unknown job (already collected, killed, or never existed)".to_string()
        })?
    };
    job.cancel.store(true, Ordering::Release);
    tauri::async_runtime::spawn_blocking({
        let job = job.clone();
        move || job.wait()
    })
    .await
    .map_err(|error| format!("shell_kill: supervisor failed: {}", error))?;
    job.remove_files();
    Ok(format!("killed {}", id))
}

pub(crate) fn kill_jobs_for_window(state: &ShellJobs, owner: &str) {
    let jobs = match state.0.lock() {
        Ok(mut map) => {
            let mut kept = HashMap::new();
            let mut removed = Vec::new();
            for (id, job) in map.drain() {
                if job.owner == owner {
                    removed.push(job);
                } else {
                    kept.insert(id, job);
                }
            }
            *map = kept;
            removed
        }
        Err(_) => return,
    };
    for job in &jobs {
        job.cancel.store(true, Ordering::Release);
    }
    std::thread::spawn(move || {
        for job in jobs {
            job.wait();
            job.remove_files();
        }
    });
}

pub(crate) fn kill_all_jobs(state: &ShellJobs) {
    let jobs = match state.0.lock() {
        Ok(mut map) => map.drain().map(|(_, job)| job).collect::<Vec<_>>(),
        Err(_) => return,
    };
    for job in &jobs {
        job.cancel.store(true, Ordering::Release);
    }
    std::thread::spawn(move || {
        for job in jobs {
            job.wait();
            job.remove_files();
        }
        let _ = std::fs::remove_dir_all(jobs_dir());
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn fixture(label: &str) -> std::path::PathBuf {
        let id = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("vtnexa-jobs-test-{label}-{id}"));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[cfg(unix)]
    fn wait_for_pid(path: &std::path::Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(pid) = std::fs::read_to_string(path) {
                if let Ok(pid) = pid.trim().parse::<i32>() {
                    return pid;
                }
            }
            assert!(Instant::now() < deadline, "PID file was not written");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn process_exists(pid: i32) -> bool {
        if unsafe { libc::kill(pid, 0) } == 0 {
            true
        } else {
            std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    }

    #[cfg(unix)]
    fn assert_processes_gone(pids: &[i32]) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let alive = pids
                .iter()
                .copied()
                .filter(|pid| process_exists(*pid))
                .collect::<Vec<_>>();
            if alive.is_empty() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "background process tree is still alive: {alive:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

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
    fn jobs_are_owned_by_their_window() {
        let dir = fixture("owner");
        let out_path = dir.join("owner.out");
        let err_path = dir.join("owner.err");
        let job = SupervisedJob::new(
            "main".to_string(),
            out_path,
            err_path,
            Instant::now(),
            "echo".to_string(),
        );
        let mut map = HashMap::new();
        map.insert("job_owner".to_string(), job);
        assert!(owned_job(&map, "job_owner", "main", "shell_poll").is_ok());
        let error = match owned_job(&map, "job_owner", "main-2", "shell_poll") {
            Ok(_) => panic!("owner check unexpectedly succeeded"),
            Err(error) => error,
        };
        assert!(error.contains("another window"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tails_are_bounded_and_char_safe() {
        let dir = fixture("tails");
        let path = dir.join("output.txt");
        std::fs::write(&path, "héllo wörld — testing tails").unwrap();
        let (full, total) = read_tail(&path, 1000);
        assert_eq!(full, "héllo wörld — testing tails");
        assert!(total > 0);
        let (tail, total) = read_tail(&path, 7);
        assert!(tail.len() <= 7 || tail.starts_with("…[tail:"));
        assert!(total > 7);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sparse_tail_reads_only_the_bounded_end() {
        let dir = fixture("sparse");
        let path = dir.join("large-output");
        let file = File::create(&path).unwrap();
        file.set_len(128 * 1024 * 1024).unwrap();
        drop(file);
        let (tail, total) = read_tail(&path, 32);
        assert_eq!(total, 128 * 1024 * 1024);
        assert!(tail.len() <= 200);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn background_age_kills_without_poll() {
        let dir = fixture("supervisor-age");
        let out_path = dir.join("job_age.out");
        let err_path = dir.join("job_age.err");
        let out_file = create_job_file(&out_path).unwrap();
        let err_file = create_job_file(&err_path).unwrap();
        let mut command = crate::sandbox::exec_bg_command("sleep 30", &dir);
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let child = process::spawn_managed(&mut command).unwrap();
        let limits = ProcessLimits::new(8192, 8192, 8192);
        let sink = Arc::new(CappedFileSink::new(out_file, err_file, limits));
        let job = SupervisedJob::new(
            "main".to_string(),
            out_path,
            err_path,
            Instant::now(),
            "sleep".to_string(),
        );
        let thread_job = job.clone();
        std::thread::spawn(move || {
            let result = supervise(child, thread_job.clone(), sink, Duration::from_millis(100));
            thread_job.complete(result);
        });
        let result = job.wait();
        assert!(result.timed_out, "result={result:?}");
        assert!(!result.limit_exceeded, "result={result:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn background_expiry_kills_escaped_tree() {
        let dir = fixture("supervisor-expiry-tree");
        let out_path = dir.join("job_expiry_tree.out");
        let err_path = dir.join("job_expiry_tree.err");
        let out_file = create_job_file(&out_path).unwrap();
        let err_file = create_job_file(&err_path).unwrap();
        let child_pid_path = dir.join("child.pid");
        let grandchild_pid_path = dir.join("grandchild.pid");
        let script = "setsid sleep 30 & grandchild=$!; printf '%s' \"$grandchild\" > \"$VTNEXA_BG_GRANDCHILD_PID\"; printf '%s' \"$$\" > \"$VTNEXA_BG_CHILD_PID\"; wait \"$grandchild\"";
        let mut command = std::process::Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .current_dir(&dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("VTNEXA_BG_CHILD_PID", "child.pid")
            .env("VTNEXA_BG_GRANDCHILD_PID", "grandchild.pid");
        let child = process::spawn_managed(&mut command).unwrap();
        let limits = ProcessLimits::new(8192, 8192, 8192);
        let sink = Arc::new(CappedFileSink::new(out_file, err_file, limits));
        let job = SupervisedJob::new(
            "main".to_string(),
            out_path,
            err_path,
            Instant::now(),
            "expiry-tree".to_string(),
        );
        let child_pid = wait_for_pid(&child_pid_path);
        let grandchild_pid = wait_for_pid(&grandchild_pid_path);
        let result = supervise(child, job.clone(), sink, Duration::from_millis(100));
        job.complete(result);
        let result = job.wait();
        assert!(result.timed_out, "result={result:?}");
        assert_processes_gone(&[child_pid, grandchild_pid]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn background_cleanup_kills_shell_grandchild_tree() {
        let dir = fixture("supervisor-tree");
        let out_path = dir.join("job_tree.out");
        let err_path = dir.join("job_tree.err");
        let out_file = create_job_file(&out_path).unwrap();
        let err_file = create_job_file(&err_path).unwrap();
        let child_pid_path = dir.join("child.pid");
        let grandchild_pid_path = dir.join("grandchild.pid");
        let script = "setsid sleep 30 & grandchild=$!; printf '%s' \"$grandchild\" > \"$VTNEXA_BG_GRANDCHILD_PID\"; printf '%s' \"$$\" > \"$VTNEXA_BG_CHILD_PID\"; wait \"$grandchild\"";
        let mut command = std::process::Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .current_dir(&dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("VTNEXA_BG_CHILD_PID", "child.pid")
            .env("VTNEXA_BG_GRANDCHILD_PID", "grandchild.pid");
        let child = process::spawn_managed(&mut command).unwrap();
        let limits = ProcessLimits::new(8192, 8192, 8192);
        let sink = Arc::new(CappedFileSink::new(out_file, err_file, limits));
        let job = SupervisedJob::new(
            "main".to_string(),
            out_path,
            err_path,
            Instant::now(),
            "tree".to_string(),
        );
        let thread_job = job.clone();
        std::thread::spawn(move || {
            let result = supervise(child, thread_job.clone(), sink, Duration::from_secs(5));
            thread_job.complete(result);
        });
        let child_pid = wait_for_pid(&child_pid_path);
        let grandchild_pid = wait_for_pid(&grandchild_pid_path);
        assert_ne!(child_pid, grandchild_pid);
        job.cancel.store(true, Ordering::Release);
        let result = job.wait();
        assert!(result.cancelled, "result={result:?}");
        assert_processes_gone(&[child_pid, grandchild_pid]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn background_output_is_killed_without_poll() {
        let dir = fixture("supervisor");
        let out_path = dir.join("job_test.out");
        let err_path = dir.join("job_test.err");
        let out_file = create_job_file(&out_path).unwrap();
        let err_file = create_job_file(&err_path).unwrap();
        let mut command =
            crate::sandbox::exec_bg_command("while :; do printf '0123456789abcdef\\n'; done", &dir);
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let child = process::spawn_managed(&mut command).unwrap();
        let limits = ProcessLimits::new(8192, 8192, 8192);
        let sink = Arc::new(CappedFileSink::new(out_file, err_file, limits));
        let job = SupervisedJob::new(
            "main".to_string(),
            out_path.clone(),
            err_path.clone(),
            Instant::now(),
            "noisy".to_string(),
        );
        let thread_job = job.clone();
        std::thread::spawn(move || {
            let result = supervise(child, thread_job.clone(), sink, Duration::from_secs(2));
            thread_job.complete(result);
        });
        let result = job.wait();
        assert!(result.limit_exceeded, "result={result:?}");
        assert!(!result.timed_out, "result={result:?}");
        assert!(std::fs::metadata(&out_path).unwrap().len() <= 8192);
        assert!(std::fs::metadata(&err_path).unwrap().len() <= 8192);
        let _ = std::fs::remove_dir_all(dir);
    }
}
