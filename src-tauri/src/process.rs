use std::collections::VecDeque;
#[cfg(unix)]
use std::collections::{HashMap, HashSet};
use std::fmt;
#[cfg(any(target_os = "linux", target_os = "android"))]
use std::fs;
use std::io::{self, BufReader, Read, Seek, Write};
#[cfg(any(target_os = "linux", target_os = "android"))]
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
#[cfg(unix)]
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const READ_CHUNK: usize = 8 * 1024;
const TRUNCATION_MARKER_RESERVE: usize = 96;
const DRAIN_GRACE: Duration = Duration::from_secs(2);
const RESPONSE_DRAIN_GRACE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy)]
pub(crate) struct ProcessLimits {
    stdout: usize,
    stderr: usize,
    combined: usize,
}

impl ProcessLimits {
    pub(crate) fn new(stdout: usize, stderr: usize, combined: usize) -> Self {
        Self {
            stdout,
            stderr,
            combined,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StreamKind {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessEnd {
    Exited,
    Response,
    Stopped,
    Cancelled,
}

#[derive(Debug)]
pub(crate) enum ProcessError {
    Spawn(io::Error),
    #[cfg(windows)]
    Tree(String),
    Io(io::Error),
    Input(io::Error),
    Timeout(Duration),
    LineTooLong(usize),
    Protocol(String),
    Sink(String),
}

impl fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(error) => write!(formatter, "cannot start process: {error}"),
            #[cfg(windows)]
            Self::Tree(message) => write!(formatter, "process tree control failed: {message}"),
            Self::Io(error) => write!(formatter, "process I/O failed: {error}"),
            Self::Input(error) => write!(formatter, "process input failed: {error}"),
            Self::Timeout(timeout) => write!(
                formatter,
                "process timed out after {}ms",
                timeout.as_millis()
            ),
            Self::LineTooLong(limit) => write!(formatter, "stdout line exceeded {limit} bytes"),
            Self::Protocol(message) => formatter.write_str(message),
            Self::Sink(message) => write!(formatter, "output sink failed: {message}"),
        }
    }
}

impl std::error::Error for ProcessError {}

#[derive(Debug)]
pub(crate) struct ProcessOutput {
    stdout: BoundedOutput,
    stderr: BoundedOutput,
    code: i32,
    end: ProcessEnd,
}

impl ProcessOutput {
    pub(crate) fn stdout(&self) -> &str {
        self.stdout.as_str()
    }

    pub(crate) fn stderr(&self) -> &str {
        self.stderr.as_str()
    }

    pub(crate) fn stdout_bytes(&self) -> Vec<u8> {
        self.stdout.render_bytes()
    }

    pub(crate) fn stdout_truncated(&self) -> bool {
        self.stdout.truncated
    }

    pub(crate) fn stderr_truncated(&self) -> bool {
        self.stderr.truncated
    }

    pub(crate) fn stdout_bytes_seen(&self) -> u64 {
        self.stdout.total
    }

    pub(crate) fn code(&self) -> i32 {
        self.code
    }

    pub(crate) fn end(&self) -> ProcessEnd {
        self.end
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LineDecision {
    Continue,
    Response,
    Fail(String),
}

pub(crate) type LineObserver = Arc<dyn Fn(&[u8]) -> LineDecision + Send + Sync>;
type ByteHook = Arc<dyn Fn(StreamKind, &[u8]) -> Result<bool, String> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct ProcessOptions {
    timeout: Duration,
    limits: ProcessLimits,
    max_stdout_line: Option<usize>,
    max_stderr_line: Option<usize>,
    line_observer: Option<LineObserver>,
    stdout_hook: Option<ByteHook>,
    stderr_hook: Option<ByteHook>,
    cancel: Option<Arc<AtomicBool>>,
    initial_stdin: Option<Vec<u8>>,
}

impl ProcessOptions {
    pub(crate) fn new(timeout: Duration, limits: ProcessLimits) -> Self {
        Self {
            timeout,
            limits,
            max_stdout_line: None,
            max_stderr_line: None,
            line_observer: None,
            stdout_hook: None,
            stderr_hook: None,
            cancel: None,
            initial_stdin: None,
        }
    }

    pub(crate) fn with_max_stdout_line(mut self, limit: usize) -> Self {
        self.max_stdout_line = Some(limit);
        self
    }

    pub(crate) fn with_max_stderr_line(mut self, limit: usize) -> Self {
        self.max_stderr_line = Some(limit);
        self
    }

    pub(crate) fn with_line_observer(mut self, observer: LineObserver) -> Self {
        self.line_observer = Some(observer);
        self
    }

    pub(crate) fn with_stdout_hook(mut self, hook: ByteHook) -> Self {
        self.stdout_hook = Some(hook);
        self
    }

    pub(crate) fn with_stderr_hook(mut self, hook: ByteHook) -> Self {
        self.stderr_hook = Some(hook);
        self
    }

    pub(crate) fn with_cancel(mut self, cancel: Arc<AtomicBool>) -> Self {
        self.cancel = Some(cancel);
        self
    }

    pub(crate) fn with_initial_stdin(mut self, input: Vec<u8>) -> Self {
        self.initial_stdin = Some(input);
        self
    }
}

struct SharedBudget {
    remaining: AtomicUsize,
}

impl SharedBudget {
    fn new(limit: usize) -> Self {
        Self {
            remaining: AtomicUsize::new(limit),
        }
    }

    fn take(&self, requested: usize) -> usize {
        let mut current = self.remaining.load(Ordering::Acquire);
        loop {
            let grant = current.min(requested);
            match self.remaining.compare_exchange_weak(
                current,
                current - grant,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return grant,
                Err(actual) => current = actual,
            }
        }
    }
}

fn capture_limit(limit: usize) -> usize {
    if limit == 0 {
        0
    } else if limit > TRUNCATION_MARKER_RESERVE {
        limit - TRUNCATION_MARKER_RESERVE
    } else {
        limit / 2
    }
}

fn combined_capture_limit(limit: usize) -> usize {
    let reserve = TRUNCATION_MARKER_RESERVE.saturating_mul(2);
    if limit == 0 {
        0
    } else if limit > reserve {
        limit - reserve
    } else {
        limit / 2
    }
}

#[derive(Debug, Default)]
struct BoundedOutput {
    prefix: Vec<u8>,
    tail: VecDeque<u8>,
    total: u64,
    limit: usize,
    truncated: bool,
    rendered: String,
}

impl BoundedOutput {
    fn new(limit: usize) -> Self {
        Self {
            prefix: Vec::with_capacity(limit.min(READ_CHUNK)),
            tail: VecDeque::new(),
            total: 0,
            limit,
            truncated: false,
            rendered: String::new(),
        }
    }

    fn push(&mut self, bytes: &[u8], budget: &SharedBudget) {
        self.total = self.total.saturating_add(bytes.len() as u64);
        if self.truncated {
            self.append_tail(bytes, budget);
            return;
        }
        let requested = bytes
            .len()
            .min(self.limit.saturating_sub(self.prefix.len()));
        let grant = budget.take(requested);
        self.prefix.extend_from_slice(&bytes[..grant]);
        if grant < bytes.len() {
            self.truncated = true;
            let split = self.prefix.len().saturating_mul(2) / 3;
            let split = split.min(self.prefix.len());
            let tail_bytes = self.prefix.split_off(split);
            self.tail.extend(tail_bytes);
            let append = bytes.len() - grant;
            self.append_tail(&bytes[grant..grant.saturating_add(append)], budget);
        }
    }

    fn append_tail(&mut self, bytes: &[u8], budget: &SharedBudget) {
        if self.tail.len() >= self.limit {
            return;
        }
        let local = self.limit.saturating_sub(self.tail.len());
        let requested = bytes.len().min(local);
        let grant = budget.take(requested);
        for byte in &bytes[..grant] {
            if self.tail.len() == self.limit {
                break;
            }
            self.tail.push_back(*byte);
        }
    }

    fn render_bytes(&self) -> Vec<u8> {
        if !self.truncated {
            return self.prefix.clone();
        }
        let marker = format!(
            "\n…[truncated: retained up to {} of {} bytes]\n",
            self.limit, self.total
        );
        if marker.len() >= self.limit {
            return marker.as_bytes()[..self.limit].to_vec();
        }
        let available = self.limit - marker.len();
        let front_len = self.prefix.len().min(available / 2);
        let tail_len = self.tail.len().min(available - front_len);
        let tail_start = self.tail.len() - tail_len;
        let mut rendered = Vec::with_capacity(self.limit);
        rendered.extend_from_slice(marker.as_bytes());
        rendered.extend_from_slice(&self.prefix[..front_len]);
        rendered.extend(self.tail.iter().skip(tail_start));
        rendered
    }

    fn render(&mut self) {
        let bytes = self.render_bytes();
        let mut rendered = String::from_utf8_lossy(&bytes).into_owned();
        if rendered.len() > self.limit {
            let mut end = self.limit;
            while !rendered.is_char_boundary(end) {
                end -= 1;
            }
            rendered.truncate(end);
        }
        self.rendered = rendered;
    }

    fn as_str(&self) -> &str {
        &self.rendered
    }
}

enum ReaderEvent {
    Response,
    Stop,
    LineTooLong(usize),
    Protocol(String),
    Sink(String),
    Read(io::Error),
    Input(io::Error),
}

fn notify_line(line: &[u8], observer: &Option<LineObserver>, events: &Sender<ReaderEvent>) {
    let Some(observer) = observer else {
        return;
    };
    match observer(line) {
        LineDecision::Continue => {}
        LineDecision::Response => {
            let _ = events.send(ReaderEvent::Response);
        }
        LineDecision::Fail(message) => {
            let _ = events.send(ReaderEvent::Protocol(message));
        }
    }
}

fn read_stream<R: Read>(
    reader: R,
    kind: StreamKind,
    mut capture: BoundedOutput,
    budget: Arc<SharedBudget>,
    options: ProcessOptions,
    events: Sender<ReaderEvent>,
    results: Sender<Result<(StreamKind, BoundedOutput), String>>,
) {
    let mut reader = BufReader::new(reader);
    let mut buffer = [0u8; READ_CHUNK];
    let mut line = Vec::new();
    let mut line_overflow = false;
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) => {
                let _ = events.send(ReaderEvent::Read(error));
                let _ = results.send(Err(format!("{kind:?} reader failed")));
                return;
            }
        };
        let chunk = &buffer[..count];
        capture.push(chunk, &budget);
        let hook = match kind {
            StreamKind::Stdout => options.stdout_hook.as_ref(),
            StreamKind::Stderr => options.stderr_hook.as_ref(),
        };
        if let Some(hook) = hook {
            match hook(kind, chunk) {
                Ok(true) => {
                    let _ = events.send(ReaderEvent::Stop);
                }
                Err(error) => {
                    let _ = events.send(ReaderEvent::Sink(error));
                }
                Ok(false) => {}
            }
        }
        let max_line = match kind {
            StreamKind::Stdout => options.max_stdout_line,
            StreamKind::Stderr => options.max_stderr_line,
        };
        let Some(max_line) = max_line else {
            continue;
        };
        for byte in chunk {
            if line_overflow {
                if *byte == b'\n' {
                    line_overflow = false;
                    line.clear();
                }
                continue;
            }
            if *byte == b'\n' {
                if line.len() < max_line {
                    line.push(*byte);
                    if kind == StreamKind::Stdout {
                        notify_line(&line, &options.line_observer, &events);
                    }
                    line.clear();
                } else {
                    line.clear();
                    let _ = events.send(ReaderEvent::LineTooLong(max_line));
                }
            } else if line.len() >= max_line {
                line.clear();
                line_overflow = true;
                let _ = events.send(ReaderEvent::LineTooLong(max_line));
            } else {
                line.push(*byte);
            }
        }
    }
    if !line_overflow && !line.is_empty() && kind == StreamKind::Stdout {
        notify_line(&line, &options.line_observer, &events);
    }
    capture.render();
    let _ = results.send(Ok((kind, capture)));
}

#[cfg(unix)]
const TREE_CLEANUP_ROUNDS: usize = 32;
#[cfg(unix)]
const TREE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(unix)]
const TREE_POLL_INTERVAL: Duration = Duration::from_millis(2);
#[cfg(unix)]
const MAX_TREE_NODES: usize = 131_072;
#[cfg(unix)]
const MAX_PROCESS_TABLE: usize = 262_144;
#[cfg(any(
    target_os = "macos",
    all(
        unix,
        not(any(target_os = "linux", target_os = "android", target_os = "macos"))
    )
))]
const MAX_PROCESS_ARGS_BYTES: usize = 16 * 1024 * 1024;
#[cfg(unix)]
const TREE_TOKEN_ENV: &str = "VTNEXA_TREE_TOKEN";
#[cfg(unix)]
const TREE_TOKEN_PREFIX: &[u8] = b"VTNEXA_TREE_TOKEN=";

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct ProcessIdentity {
    pid: libc::pid_t,
    start_time: u64,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug)]
struct ProcessRecord {
    identity: ProcessIdentity,
    ppid: libc::pid_t,
    state: u8,
}

#[cfg(unix)]
struct ProcessSnapshot {
    records: HashMap<libc::pid_t, ProcessRecord>,
    children: HashMap<libc::pid_t, Vec<libc::pid_t>>,
    marked: HashMap<libc::pid_t, ProcessIdentity>,
}

#[cfg(unix)]
fn invalid_process_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[cfg(unix)]
fn process_is_gone(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
        || matches!(error.raw_os_error(), Some(libc::ESRCH) | Some(libc::ENOENT))
}

#[cfg(unix)]
fn environment_has_exact_token(data: &[u8], token: &str) -> bool {
    if token.is_empty() || token.as_bytes().contains(&0) {
        return false;
    }
    data.split(|byte| *byte == 0).any(|entry| {
        entry
            .strip_prefix(TREE_TOKEN_PREFIX)
            .is_some_and(|value| value == token.as_bytes())
    })
}

#[cfg(unix)]
fn pid_from_u32(pid: u32) -> io::Result<libc::pid_t> {
    let pid = libc::pid_t::try_from(pid)
        .map_err(|_| io::Error::other("process ID exceeds the platform limit"))?;
    if pid <= 0 {
        return Err(io::Error::other("process ID is invalid"));
    }
    Ok(pid)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn linux_proc_path(root: &Path, pid: libc::pid_t, name: &str) -> PathBuf {
    root.join(pid.to_string()).join(name)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_linux_record_at(root: &Path, pid: libc::pid_t) -> io::Result<ProcessRecord> {
    let text = fs::read_to_string(linux_proc_path(root, pid, "stat"))?;
    let open = text
        .find('(')
        .ok_or_else(|| invalid_process_data("proc stat has no command field"))?;
    let close = text
        .rfind(')')
        .ok_or_else(|| invalid_process_data("proc stat has no command terminator"))?;
    if close <= open {
        return Err(invalid_process_data("proc stat command field is invalid"));
    }
    let parsed_pid = text[..open]
        .trim()
        .parse::<libc::pid_t>()
        .map_err(|_| invalid_process_data("proc stat PID is invalid"))?;
    if parsed_pid != pid {
        return Err(invalid_process_data("proc stat PID changed during read"));
    }
    let mut fields = text[close + 1..].split_whitespace();
    let state = fields
        .next()
        .and_then(|value| value.as_bytes().first().copied())
        .ok_or_else(|| invalid_process_data("proc stat state is missing"))?;
    let ppid = fields
        .next()
        .and_then(|value| value.parse::<libc::pid_t>().ok())
        .ok_or_else(|| invalid_process_data("proc stat parent is invalid"))?;
    let _pgrp = fields
        .next()
        .and_then(|value| value.parse::<libc::pid_t>().ok())
        .ok_or_else(|| invalid_process_data("proc stat process group is invalid"))?;
    for _ in 6..=21 {
        fields
            .next()
            .ok_or_else(|| invalid_process_data("proc stat is truncated"))?;
    }
    let start_time = fields
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| invalid_process_data("proc stat start time is invalid"))?;
    Ok(ProcessRecord {
        identity: ProcessIdentity { pid, start_time },
        ppid,
        state,
    })
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_linux_record(pid: libc::pid_t) -> io::Result<ProcessRecord> {
    read_linux_record_at(Path::new("/proc"), pid)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_linux_children_at(root: &Path, pid: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
    let task_root = linux_proc_path(root, pid, "task");
    let entries = fs::read_dir(task_root)?;
    let mut children = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<libc::pid_t>().ok())
            .is_none()
        {
            continue;
        }
        let path = entry.path().join("children");
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if process_is_gone(&error) => continue,
            Err(error) => return Err(error),
        };
        for value in text.split_whitespace() {
            let child = value
                .parse::<libc::pid_t>()
                .map_err(|_| invalid_process_data("proc children PID is invalid"))?;
            if child > 0 {
                children.push(child);
            }
        }
    }
    children.sort_unstable();
    children.dedup();
    Ok(children)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_linux_children(pid: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
    read_linux_children_at(Path::new("/proc"), pid)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn linux_process_has_token_at(root: &Path, pid: libc::pid_t, token: &str) -> io::Result<bool> {
    let data = fs::read(linux_proc_path(root, pid, "environ"))?;
    Ok(environment_has_exact_token(&data, token))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn capture_linux_snapshot_at(
    root: &Path,
    _self_pid: libc::pid_t,
    token: Option<&str>,
) -> io::Result<ProcessSnapshot> {
    let entries = fs::read_dir(root)?;
    let started = Instant::now();
    let mut records = HashMap::new();
    let mut process_count = 0usize;
    for entry in entries {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<libc::pid_t>().ok())
        else {
            continue;
        };
        if pid <= 0 {
            continue;
        }
        process_count += 1;
        if process_count > MAX_PROCESS_TABLE {
            return Err(io::Error::other("proc process table exceeds cleanup bound"));
        }
        if process_count & 255 == 0 && started.elapsed() >= TREE_CLEANUP_TIMEOUT {
            return Err(io::Error::other(
                "proc process scan exceeded cleanup time bound",
            ));
        }
        match read_linux_record_at(root, pid) {
            Ok(record) => {
                records.insert(pid, record);
            }
            Err(error) if process_is_gone(&error) => {}
            Err(error) => return Err(error),
        }
    }
    let mut children: HashMap<libc::pid_t, Vec<libc::pid_t>> = HashMap::new();
    for (&pid, record) in &records {
        if record.ppid > 0 {
            children.entry(record.ppid).or_default().push(pid);
        }
    }
    for values in children.values_mut() {
        values.sort_unstable();
        values.dedup();
    }
    let mut marked = HashMap::new();
    if let Some(token) = token {
        for (&pid, record) in &records {
            match linux_process_has_token_at(root, pid, token) {
                Ok(true) => match read_linux_record_at(root, pid) {
                    Ok(current) if current.identity == record.identity => {
                        marked.insert(pid, record.identity);
                    }
                    Ok(_) => {}
                    Err(error) if process_is_gone(&error) => {}
                    Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {}
                    Err(error) => return Err(error),
                },
                Ok(false) => {}
                Err(error) if process_is_gone(&error) => {}
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(ProcessSnapshot {
        records,
        children,
        marked,
    })
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn capture_linux_snapshot(
    self_pid: libc::pid_t,
    token: Option<&str>,
) -> io::Result<ProcessSnapshot> {
    capture_linux_snapshot_at(Path::new("/proc"), self_pid, token)
}

#[cfg(target_os = "macos")]
fn read_macos_record(pid: libc::pid_t) -> io::Result<ProcessRecord> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut libc::proc_bsdinfo as *mut libc::c_void,
            size,
        )
    };
    if read == 0 {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    }
    if read < size {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    }
    if libc::pid_t::try_from(info.pbi_pid).ok() != Some(pid) {
        return Err(invalid_process_data("proc_pidinfo PID changed during read"));
    }
    let start_time = info
        .pbi_start_tvsec
        .wrapping_mul(1_000_000_000)
        .wrapping_add(info.pbi_start_tvusec);
    Ok(ProcessRecord {
        identity: ProcessIdentity { pid, start_time },
        ppid: libc::pid_t::try_from(info.pbi_ppid)
            .map_err(|_| invalid_process_data("proc_pidinfo parent is invalid"))?,
        state: if info.pbi_status == libc::SZOMB {
            b'Z'
        } else {
            0
        },
    })
}

#[cfg(target_os = "macos")]
fn macos_environment_offset(data: &[u8]) -> io::Result<usize> {
    if data.len() < std::mem::size_of::<libc::c_int>() {
        return Err(invalid_process_data("process arguments are truncated"));
    }
    let argc = i32::from_ne_bytes(
        data[..std::mem::size_of::<libc::c_int>()]
            .try_into()
            .map_err(|_| invalid_process_data("process argument count is invalid"))?,
    );
    if argc < 0 || argc as usize > MAX_PROCESS_TABLE {
        return Err(invalid_process_data("process argument count is invalid"));
    }
    let mut offset = std::mem::size_of::<libc::c_int>();
    if offset > data.len() {
        return Err(invalid_process_data("process arguments are truncated"));
    }
    let executable_end = data[offset..]
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| invalid_process_data("process executable path is unterminated"))?;
    offset = offset
        .checked_add(executable_end)
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| invalid_process_data("process arguments are too large"))?;
    while offset < data.len() && data[offset] == 0 {
        offset += 1;
    }
    for _ in 0..argc as usize {
        if offset > data.len() {
            return Err(invalid_process_data("process arguments are truncated"));
        }
        let relative_end = data[offset..]
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| invalid_process_data("process arguments are unterminated"))?;
        offset = offset
            .checked_add(relative_end)
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| invalid_process_data("process arguments are too large"))?;
    }
    Ok(offset)
}

#[cfg(target_os = "macos")]
fn macos_procargs_has_exact_token(data: &[u8], token: &str) -> io::Result<bool> {
    if token.is_empty() || token.as_bytes().contains(&0) {
        return Ok(false);
    }
    let mut offset = macos_environment_offset(data)?;
    let expected_length = TREE_TOKEN_PREFIX.len().saturating_add(token.len());
    let mut expected = Vec::with_capacity(expected_length);
    expected.extend_from_slice(TREE_TOKEN_PREFIX);
    expected.extend_from_slice(token.as_bytes());
    while offset < data.len() {
        if data[offset] == 0 {
            offset += 1;
            continue;
        }
        let relative_end = data[offset..]
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| invalid_process_data("process environment is unterminated"))?;
        let end = offset + relative_end;
        if &data[offset..end] == expected.as_slice() {
            return Ok(true);
        }
        offset = end + 1;
    }
    Ok(false)
}

#[cfg(target_os = "macos")]
fn read_macos_process_args(pid: libc::pid_t) -> io::Result<Vec<u8>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let miblen = mib.len() as libc::c_uint;
    let mut length: libc::size_t = 0;
    let queried = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            miblen,
            std::ptr::null_mut(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if queried != 0 {
        return Err(io::Error::last_os_error());
    }
    if length == 0 || length > MAX_PROCESS_ARGS_BYTES as libc::size_t {
        return Err(io::Error::other("process arguments exceed cleanup bound"));
    }
    let mut data = vec![0u8; length as usize];
    let mut actual = length;
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            miblen,
            data.as_mut_ptr() as *mut libc::c_void,
            &mut actual,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return Err(io::Error::last_os_error());
    }
    if actual > MAX_PROCESS_ARGS_BYTES as libc::size_t || actual > data.len() as libc::size_t {
        return Err(io::Error::other("process arguments changed during read"));
    }
    data.truncate(actual as usize);
    Ok(data)
}

#[cfg(target_os = "macos")]
fn macos_process_has_token(pid: libc::pid_t, token: &str) -> io::Result<bool> {
    macos_procargs_has_exact_token(&read_macos_process_args(pid)?, token)
}

#[cfg(target_os = "macos")]
fn read_macos_children(pid: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
    let count = unsafe { libc::proc_listchildpids(pid, std::ptr::null_mut(), 0) };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    let count = count as usize;
    if count > MAX_PROCESS_TABLE {
        return Err(io::Error::other(
            "process child table exceeds cleanup bound",
        ));
    }
    let mut children = vec![0 as libc::pid_t; count];
    let bytes = std::mem::size_of_val(&children);
    let got = unsafe {
        libc::proc_listchildpids(
            pid,
            children.as_mut_ptr() as *mut libc::c_void,
            bytes as libc::c_int,
        )
    };
    if got < 0 {
        return Err(io::Error::last_os_error());
    }
    if got as usize > count {
        return Err(invalid_process_data(
            "process child count changed during read",
        ));
    }
    children.truncate(got as usize);
    children.retain(|child| *child > 0);
    Ok(children)
}

#[cfg(target_os = "macos")]
fn capture_macos_snapshot(token: Option<&str>) -> io::Result<ProcessSnapshot> {
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    if count == 0 {
        return Ok(ProcessSnapshot {
            records: HashMap::new(),
            children: HashMap::new(),
            marked: HashMap::new(),
        });
    }
    let count = count as usize;
    if count > MAX_PROCESS_TABLE {
        return Err(io::Error::other("process table exceeds cleanup bound"));
    }
    let mut pids = vec![0 as libc::pid_t; count];
    let bytes = std::mem::size_of_val(&pids);
    let got = unsafe {
        libc::proc_listallpids(pids.as_mut_ptr() as *mut libc::c_void, bytes as libc::c_int)
    };
    if got < 0 {
        return Err(io::Error::last_os_error());
    }
    if got as usize > count {
        return Err(invalid_process_data("process count changed during read"));
    }
    let started = Instant::now();
    let mut records = HashMap::new();
    let mut marked = HashMap::new();
    for (index, pid) in pids.into_iter().take(got as usize).enumerate() {
        if index & 63 == 0 && started.elapsed() >= TREE_CLEANUP_TIMEOUT {
            return Err(io::Error::other(
                "macOS process scan exceeded cleanup time bound",
            ));
        }
        if pid <= 0 {
            continue;
        }
        let record = match read_macos_record(pid) {
            Ok(record) => record,
            Err(error) if process_is_gone(&error) => continue,
            Err(error) => return Err(error),
        };
        if let Some(token) = token {
            if record.state == b'Z' {
                records.insert(pid, record);
                continue;
            }
            match macos_process_has_token(pid, token) {
                Ok(true) => match read_macos_record(pid) {
                    Ok(current) if current.identity == record.identity => {
                        marked.insert(pid, record.identity);
                    }
                    Ok(_) => {}
                    Err(error) if process_is_gone(&error) => {}
                    Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {}
                    Err(error) => return Err(error),
                },
                Ok(false) => {}
                Err(error) if process_is_gone(&error) => {}
                Err(error)
                    if error.kind() == io::ErrorKind::PermissionDenied
                        || matches!(
                            error.raw_os_error(),
                            Some(libc::EACCES) | Some(libc::EPERM)
                        ) => {}
                Err(error) => return Err(error),
            }
        }
        records.insert(pid, record);
    }
    let mut children: HashMap<libc::pid_t, Vec<libc::pid_t>> = HashMap::new();
    for (&pid, record) in &records {
        if record.ppid > 0 {
            children.entry(record.ppid).or_default().push(pid);
        }
    }
    for values in children.values_mut() {
        values.sort_unstable();
        values.dedup();
    }
    if token.is_some() && records.is_empty() {
        return Err(io::Error::other(
            "macOS process records are unavailable for identity marking",
        ));
    }
    Ok(ProcessSnapshot {
        records,
        children,
        marked,
    })
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
const FALLBACK_IDENTITY_COMMANDS: &[&[&str]] = &[
    &["-axww", "-o", "pid=,ppid=,pgid=,lstart=,args="],
    &["-axo", "pid=,ppid=,pgid=,lstart=,args="],
    &["-eo", "pid=,ppid=,pgid=,lstart=,args="],
    &["-ax", "-o", "pid=,ppid=,pgid=,lstart=,args="],
];

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
const FALLBACK_ENVIRONMENT_COMMANDS: &[&[&str]] = &[
    &["-axeww", "-o", "pid=,ppid=,pgid=,lstart=,args="],
    &["-axo", "pid=,ppid=,pgid=,lstart=,args=,e="],
    &["-eo", "pid=,ppid=,pgid=,lstart=,args=,e="],
    &["-ax", "-o", "pid=,ppid=,pgid=,lstart=,args=,e="],
];

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
#[derive(Default)]
struct FallbackPsRecords {
    records: HashMap<libc::pid_t, ProcessRecord>,
    displays: HashMap<libc::pid_t, String>,
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn read_bounded_output<R: Read>(mut reader: R) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(count) > MAX_PROCESS_ARGS_BYTES {
            return Err(io::Error::other(
                "process enumeration output exceeds cleanup bound",
            ));
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn fallback_ps_path() -> io::Result<&'static str> {
    if let Some(path) = FALLBACK_PS_PATH.get() {
        return Ok(*path);
    }
    for candidate in ["/bin/ps", "/usr/bin/ps"] {
        if std::path::Path::new(candidate).is_file() {
            let _ = FALLBACK_PS_PATH.set(candidate);
            return Ok(candidate);
        }
    }
    Err(io::Error::other(
        "process enumeration program is unavailable",
    ))
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn run_bounded_ps(
    args: &[&str],
    token: Option<&str>,
) -> io::Result<(ExitStatus, Vec<u8>, Vec<u8>)> {
    let mut command = Command::new(fallback_ps_path()?);
    command
        .args(args)
        .env_remove(TREE_TOKEN_ENV)
        .env_remove("PS_FORMAT")
        .env_remove("COLUMNS")
        .env("LC_ALL", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(token) = token {
        command.env(TREE_TOKEN_ENV, token);
    }
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("process enumeration stdout is unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("process enumeration stderr is unavailable"))?;
    let stdout_reader = std::thread::spawn(move || read_bounded_output(stdout));
    let stderr_reader = std::thread::spawn(move || read_bounded_output(stderr));
    let deadline = Instant::now() + Duration::from_millis(250);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(io::Error::other("process enumeration timed out"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(1)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(error);
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| io::Error::other("process enumeration reader panicked"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| io::Error::other("process enumeration reader panicked"))??;
    Ok((status, stdout, stderr))
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn run_bounded_ps_variants(
    commands: &[&[&str]],
    token: Option<&str>,
) -> io::Result<(ExitStatus, Vec<u8>, Vec<u8>)> {
    let mut last_error = None;
    for args in commands {
        match run_bounded_ps(args, token) {
            Ok((status, stdout, stderr)) if status.success() => {
                return Ok((status, stdout, stderr));
            }
            Ok(_) => {
                last_error = Some(io::Error::other("process enumeration command failed"));
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| io::Error::other("process enumeration is unavailable")))
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn fallback_start_identity(start: &str) -> u64 {
    let mut start_time = 14695981039346656037u64;
    for byte in start.as_bytes() {
        start_time ^= u64::from(*byte);
        start_time = start_time.wrapping_mul(1099511628211);
    }
    start_time
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn parse_fallback_ps_line(line: &str) -> io::Result<Option<(ProcessRecord, String)>> {
    let mut rest = line.trim();
    if rest.is_empty() {
        return Ok(None);
    }
    let mut fields = Vec::with_capacity(8);
    for _ in 0..8 {
        let trimmed = rest.trim_start();
        let end = trimmed
            .find(|character: char| character.is_whitespace())
            .unwrap_or(trimmed.len());
        if end == 0 {
            return Ok(None);
        }
        fields.push(&trimmed[..end]);
        rest = &trimmed[end..];
    }
    let pid = match fields[0].parse::<libc::pid_t>() {
        Ok(pid) => pid,
        Err(_) => return Ok(None),
    };
    if pid <= 0 {
        return Ok(None);
    }
    let ppid = fields[1]
        .parse::<libc::pid_t>()
        .map_err(|_| invalid_process_data("ps parent is invalid"))?;
    let _pgrp = fields[2]
        .parse::<libc::pid_t>()
        .map_err(|_| invalid_process_data("ps process group is invalid"))?;
    let start = fields[3..8].join(" ");
    let record = ProcessRecord {
        identity: ProcessIdentity {
            pid,
            start_time: fallback_start_identity(&start),
        },
        ppid,
        state: 0,
    };
    Ok(Some((record, rest.trim_start().to_string())))
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn parse_fallback_ps_output(data: &[u8]) -> io::Result<FallbackPsRecords> {
    let text = String::from_utf8_lossy(data);
    let mut output = FallbackPsRecords::default();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let (record, display) = parse_fallback_ps_line(line)?
            .ok_or_else(|| invalid_process_data("fallback process record is invalid"))?;
        if output.records.insert(record.identity.pid, record).is_some()
            && output.records.len() > MAX_PROCESS_TABLE
        {
            return Err(io::Error::other("process table exceeds cleanup bound"));
        }
        output.displays.insert(record.identity.pid, display);
        if output.records.len() > MAX_PROCESS_TABLE {
            return Err(io::Error::other("process table exceeds cleanup bound"));
        }
    }
    Ok(output)
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn fallback_display_has_exact_token(display: &str, token: &str) -> bool {
    if token.is_empty() || token.as_bytes().contains(&0) {
        return false;
    }
    let mut expected = Vec::with_capacity(TREE_TOKEN_PREFIX.len() + token.len());
    expected.extend_from_slice(TREE_TOKEN_PREFIX);
    expected.extend_from_slice(token.as_bytes());
    display
        .split_whitespace()
        .any(|field| field.as_bytes() == expected.as_slice())
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn capture_fallback_snapshot(token: Option<&str>) -> io::Result<ProcessSnapshot> {
    let (_, identity_output, _) = if let Some(index) = FALLBACK_IDENTITY_FORMAT.get() {
        run_bounded_ps(FALLBACK_IDENTITY_COMMANDS[*index], None)?
    } else {
        run_bounded_ps_variants(&FALLBACK_IDENTITY_COMMANDS, None)?
    };
    let identity = parse_fallback_ps_output(&identity_output)?;
    let mut marked = HashMap::new();
    if let Some(token) = token {
        let index = FALLBACK_ENVIRONMENT_FORMAT.get().ok_or_else(|| {
            io::Error::other("fallback process environment enumeration is unavailable")
        })?;
        let (_, environment_output, _) =
            run_bounded_ps(FALLBACK_ENVIRONMENT_COMMANDS[*index], None)?;
        let environment = parse_fallback_ps_output(&environment_output)?;
        if identity.records.is_empty() || environment.records.is_empty() {
            return Err(io::Error::other(
                "fallback process environment enumeration returned no records",
            ));
        }
        for (&pid, record) in &identity.records {
            let Some(environment_record) = environment.records.get(&pid) else {
                continue;
            };
            if environment_record.identity != record.identity {
                return Err(io::Error::other(
                    "fallback process identity changed during environment enumeration",
                ));
            }
            let Some(environment_display) = environment.displays.get(&pid) else {
                continue;
            };
            let Some(identity_display) = identity.displays.get(&pid) else {
                continue;
            };
            let environment_has_token =
                fallback_display_has_exact_token(environment_display, token);
            let command_has_token = fallback_display_has_exact_token(identity_display, token);
            if environment_has_token && command_has_token {
                return Err(io::Error::other(
                    "fallback process environment could not be distinguished from arguments",
                ));
            }
            if environment_has_token {
                marked.insert(pid, record.identity);
            }
        }
    }
    let records = identity.records;
    let mut children: HashMap<libc::pid_t, Vec<libc::pid_t>> = HashMap::new();
    for (&pid, record) in &records {
        if record.ppid > 0 {
            children.entry(record.ppid).or_default().push(pid);
        }
    }
    for values in children.values_mut() {
        values.sort_unstable();
        values.dedup();
    }
    Ok(ProcessSnapshot {
        records,
        children,
        marked,
    })
}

#[cfg(unix)]
fn read_process_record(pid: libc::pid_t) -> io::Result<ProcessRecord> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        return read_linux_record(pid);
    }
    #[cfg(target_os = "macos")]
    {
        return read_macos_record(pid);
    }
    #[cfg(all(
        unix,
        not(any(target_os = "linux", target_os = "android", target_os = "macos"))
    ))]
    {
        return capture_fallback_snapshot(None)?
            .records
            .remove(&pid)
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound));
    }
    #[allow(unreachable_code)]
    Ok(ProcessRecord {
        identity: ProcessIdentity { pid, start_time: 0 },
        ppid: 0,
        state: 0,
    })
}

#[cfg(unix)]
fn read_children_data(pid: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        return read_linux_children(pid);
    }
    #[cfg(target_os = "macos")]
    {
        return read_macos_children(pid);
    }
    #[cfg(all(
        unix,
        not(any(target_os = "linux", target_os = "android", target_os = "macos"))
    ))]
    {
        let _ = pid;
        Ok(Vec::new())
    }
    #[allow(unreachable_code)]
    Ok(Vec::new())
}

#[cfg(unix)]
fn capture_process_snapshot(
    self_pid: libc::pid_t,
    token: Option<&str>,
) -> io::Result<ProcessSnapshot> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        return capture_linux_snapshot(self_pid, token);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = self_pid;
        return capture_macos_snapshot(token);
    }
    #[cfg(all(
        unix,
        not(any(target_os = "linux", target_os = "android", target_os = "macos"))
    ))]
    {
        let _ = self_pid;
        return capture_fallback_snapshot(token);
    }
    #[allow(unreachable_code)]
    Ok(ProcessSnapshot {
        records: HashMap::new(),
        children: HashMap::new(),
        marked: HashMap::new(),
    })
}

#[cfg(any(target_os = "linux", target_os = "android"))]
static SUBREAPER_INIT: OnceLock<Result<(), String>> = OnceLock::new();

#[cfg(target_os = "macos")]
static MACOS_TREE_READY: OnceLock<Result<(), String>> = OnceLock::new();

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
static FALLBACK_TREE_READY: OnceLock<Result<(), String>> = OnceLock::new();

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
static FALLBACK_IDENTITY_FORMAT: OnceLock<usize> = OnceLock::new();

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
static FALLBACK_ENVIRONMENT_FORMAT: OnceLock<usize> = OnceLock::new();

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
static FALLBACK_PS_PATH: OnceLock<&'static str> = OnceLock::new();

#[cfg(unix)]
fn clear_parent_tree_token() {
    std::env::remove_var(TREE_TOKEN_ENV);
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn initialize_unix_tree_ready() -> io::Result<()> {
    clear_parent_tree_token();
    let result = SUBREAPER_INIT.get_or_init(|| {
        let changed = unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) };
        if changed != 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        match fs::read_dir("/proc") {
            Ok(_) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    });
    match result {
        Ok(()) => Ok(()),
        Err(message) => Err(io::Error::other(message.clone())),
    }
}

#[cfg(target_os = "macos")]
fn initialize_macos_tree_ready() -> io::Result<()> {
    clear_parent_tree_token();
    let result = MACOS_TREE_READY.get_or_init(|| {
        let pid = match pid_from_u32(std::process::id()) {
            Ok(pid) => pid,
            Err(error) => return Err(error.to_string()),
        };
        if let Err(error) = capture_macos_snapshot(None) {
            return Err(error.to_string());
        }
        match read_macos_process_args(pid) {
            Ok(data) => match macos_environment_offset(&data) {
                Ok(_) => Ok(()),
                Err(error) => Err(error.to_string()),
            },
            Err(error) => Err(error.to_string()),
        }
    });
    match result {
        Ok(()) => Ok(()),
        Err(message) => Err(io::Error::other(message.clone())),
    }
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn initialize_fallback_tree_ready() -> io::Result<()> {
    clear_parent_tree_token();
    let result = FALLBACK_TREE_READY.get_or_init(|| {
        let probe = match make_tree_token() {
            Ok(probe) => probe,
            Err(error) => return Err(error.to_string()),
        };
        let pid = match pid_from_u32(std::process::id()) {
            Ok(pid) => pid,
            Err(error) => return Err(error.to_string()),
        };
        let mut environment_supported = false;
        for (index, args) in FALLBACK_ENVIRONMENT_COMMANDS.iter().enumerate() {
            let Ok((status, stdout, _)) = run_bounded_ps(args, Some(&probe)) else {
                continue;
            };
            if !status.success() {
                continue;
            }
            let Ok(records) = parse_fallback_ps_output(&stdout) else {
                continue;
            };
            if records
                .displays
                .get(&pid)
                .is_some_and(|display| fallback_display_has_exact_token(display, &probe))
            {
                let _ = FALLBACK_ENVIRONMENT_FORMAT.set(index);
                environment_supported = true;
                break;
            }
        }
        if !environment_supported || FALLBACK_ENVIRONMENT_FORMAT.get().is_none() {
            return Err("fallback process environment enumeration is unavailable".to_string());
        }
        let mut identity_supported = false;
        for (index, args) in FALLBACK_IDENTITY_COMMANDS.iter().enumerate() {
            let Ok((status, stdout, _)) = run_bounded_ps(args, None) else {
                continue;
            };
            if !status.success() {
                continue;
            }
            if let Ok(records) = parse_fallback_ps_output(&stdout) {
                if records.records.contains_key(&pid) {
                    let _ = FALLBACK_IDENTITY_FORMAT.set(index);
                    identity_supported = true;
                    break;
                }
            }
        }
        if identity_supported && FALLBACK_IDENTITY_FORMAT.get().is_some() {
            Ok(())
        } else {
            Err("fallback process identity enumeration is unavailable".to_string())
        }
    });
    match result {
        Ok(()) => Ok(()),
        Err(message) => Err(io::Error::other(message.clone())),
    }
}

#[cfg(unix)]
fn make_tree_token() -> io::Result<String> {
    clear_parent_tree_token();
    let mut random = [0u8; 32];
    getrandom::fill(&mut random)
        .map_err(|_| io::Error::other("secure process tree token generation failed"))?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut token = String::with_capacity(random.len() * 2);
    for byte in random {
        token.push(HEX[(byte >> 4) as usize] as char);
        token.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(token)
}

#[cfg(unix)]
fn required_tree_token() -> io::Result<String> {
    make_tree_token()
}

#[cfg(unix)]
pub(crate) fn ensure_unix_tree_ready() -> io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        return initialize_unix_tree_ready();
    }
    #[cfg(target_os = "macos")]
    {
        return initialize_macos_tree_ready();
    }
    #[cfg(all(
        unix,
        not(any(target_os = "linux", target_os = "android", target_os = "macos"))
    ))]
    {
        return initialize_fallback_tree_ready();
    }
    #[allow(unreachable_code)]
    Ok(())
}

#[cfg(unix)]
pub(crate) fn new_unix_tree_token() -> Option<String> {
    required_tree_token().ok()
}

#[cfg(unix)]
pub(crate) fn unix_tree_token_env() -> &'static str {
    TREE_TOKEN_ENV
}

#[cfg(unix)]
fn remember_error(slot: &mut Option<io::Error>, error: io::Error) {
    if slot.is_none() {
        *slot = Some(error);
    }
}

#[cfg(unix)]
fn token_candidate_start_is_valid(root: ProcessIdentity, candidate: ProcessIdentity) -> bool {
    #[cfg(all(
        unix,
        not(any(target_os = "linux", target_os = "android", target_os = "macos"))
    ))]
    {
        let _ = (root, candidate);
        true
    }
    #[cfg(not(all(
        unix,
        not(any(target_os = "linux", target_os = "android", target_os = "macos"))
    )))]
    {
        candidate.start_time >= root.start_time
    }
}

#[cfg(unix)]
fn identity_running(identity: ProcessIdentity) -> io::Result<bool> {
    match read_process_record(identity.pid) {
        Ok(record) => {
            Ok(record.identity == identity && !matches!(record.state, b'Z' | b'X' | b'x'))
        }
        Err(error) if process_is_gone(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn signal_identity(identity: ProcessIdentity, signal: libc::c_int) -> io::Result<bool> {
    let record = match read_process_record(identity.pid) {
        Ok(record) => record,
        Err(error) if process_is_gone(&error) => return Ok(false),
        Err(error) => return Err(error),
    };
    if record.identity != identity {
        return Ok(false);
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, identity.pid, 0) };
        if pidfd >= 0 {
            let current = read_process_record(identity.pid);
            let result = match current {
                Ok(current) if current.identity == identity => unsafe {
                    libc::syscall(
                        libc::SYS_pidfd_send_signal,
                        pidfd,
                        signal,
                        std::ptr::null::<libc::siginfo_t>(),
                        0,
                    )
                },
                Ok(_) => {
                    unsafe {
                        libc::close(pidfd as libc::c_int);
                    }
                    return Ok(false);
                }
                Err(error) => {
                    unsafe {
                        libc::close(pidfd as libc::c_int);
                    }
                    return if process_is_gone(&error) {
                        Ok(false)
                    } else {
                        Err(error)
                    };
                }
            };
            unsafe {
                libc::close(pidfd as libc::c_int);
            }
            if result == 0 {
                return Ok(true);
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(false);
            }
            return Err(error);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(false);
        }
    }
    let current = match read_process_record(identity.pid) {
        Ok(current) => current,
        Err(error) if process_is_gone(&error) => return Ok(false),
        Err(error) => return Err(error),
    };
    if current.identity != identity {
        return Ok(false);
    }
    if unsafe { libc::kill(identity.pid, signal) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(error)
    }
}

#[cfg(unix)]
fn reap_identity(identity: ProcessIdentity) -> io::Result<bool> {
    let record = match read_process_record(identity.pid) {
        Ok(record) => record,
        Err(error) if process_is_gone(&error) => return Ok(false),
        Err(error) => return Err(error),
    };
    if record.identity != identity {
        return Ok(false);
    }
    let mut status = 0;
    loop {
        let result = unsafe { libc::waitpid(identity.pid, &mut status, libc::WNOHANG) };
        if result == identity.pid {
            return Ok(true);
        }
        if result == 0 {
            return Ok(false);
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if error.raw_os_error() == Some(libc::ECHILD) {
            return Ok(false);
        }
        return Err(error);
    }
}

#[cfg(unix)]
pub(crate) struct UnixTree {
    root: ProcessIdentity,
    token: Option<String>,
    self_pid: libc::pid_t,
    reaps_descendants: bool,
    known: HashMap<libc::pid_t, ProcessIdentity>,
}

#[cfg(unix)]
impl UnixTree {
    pub(crate) fn capture(pid: u32, token: Option<String>) -> io::Result<Self> {
        ensure_unix_tree_ready()?;
        let pid = pid_from_u32(pid)?;
        let root = read_process_record(pid)?.identity;
        let self_pid = pid_from_u32(std::process::id())?;
        let mut tree = Self {
            root,
            token,
            self_pid,
            reaps_descendants: cfg!(any(target_os = "linux", target_os = "android")),
            known: HashMap::from([(pid, root)]),
        };
        tree.refresh()?;
        Ok(tree)
    }

    pub(crate) fn refresh(&mut self) -> io::Result<()> {
        let started = Instant::now();
        let snapshot = capture_process_snapshot(self.self_pid, self.token.as_deref())?;
        if started.elapsed() >= TREE_CLEANUP_TIMEOUT {
            return Err(io::Error::other(
                "managed process tree scan exceeded cleanup time bound",
            ));
        }
        let previous = self.known.clone();
        let mut known = HashMap::new();
        let mut queue = VecDeque::new();
        for (&pid, identity) in &previous {
            if snapshot
                .records
                .get(&pid)
                .is_some_and(|record| record.identity == *identity)
            {
                known.insert(pid, *identity);
                queue.push_back(pid);
            }
        }
        if snapshot
            .records
            .get(&self.root.pid)
            .is_some_and(|record| record.identity == self.root)
        {
            known.insert(self.root.pid, self.root);
            queue.push_back(self.root.pid);
        }
        for (pid, identity) in &snapshot.marked {
            if snapshot
                .records
                .get(pid)
                .is_some_and(|record| record.identity == *identity)
                && token_candidate_start_is_valid(self.root, *identity)
                && known.insert(*pid, *identity).is_none()
            {
                queue.push_back(*pid);
            }
        }
        let mut visited = HashSet::new();
        while let Some(parent) = queue.pop_front() {
            if !visited.insert(parent) {
                continue;
            }
            if visited.len() > MAX_TREE_NODES {
                return Err(io::Error::other(
                    "managed process tree exceeds cleanup bound",
                ));
            }
            let mut children = snapshot.children.get(&parent).cloned().unwrap_or_default();
            match read_children_data(parent) {
                Ok(extra) => children.extend(extra),
                Err(error) if process_is_gone(&error) => {}
                Err(error) => return Err(error),
            }
            for child in children {
                let Some(record) = snapshot.records.get(&child).copied() else {
                    continue;
                };
                if record.ppid != parent
                    && !previous.contains_key(&child)
                    && (snapshot.marked.get(&child) != Some(&record.identity)
                        || !token_candidate_start_is_valid(self.root, record.identity))
                {
                    return Err(io::Error::other("process parent changed during tree scan"));
                }
                if known.insert(child, record.identity).is_none() {
                    queue.push_back(child);
                }
            }
        }
        self.known = known;
        Ok(())
    }

    pub(crate) fn reap_collected(&mut self) -> io::Result<()> {
        let deadline = Instant::now() + TREE_CLEANUP_TIMEOUT;
        let mut failure = None;
        for _ in 0..TREE_CLEANUP_ROUNDS {
            let mut pending = false;
            for identity in self.known.values().copied() {
                if identity.pid == self.root.pid {
                    continue;
                }
                match reap_identity(identity) {
                    Ok(true) => {}
                    Ok(false) => match read_process_record(identity.pid) {
                        Ok(record) if record.identity == identity => {
                            if self.reaps_descendants || !matches!(record.state, b'Z' | b'X' | b'x')
                            {
                                pending = true;
                            }
                        }
                        Ok(_) => {}
                        Err(error) if process_is_gone(&error) => {}
                        Err(error) => remember_error(&mut failure, error),
                    },
                    Err(error) => remember_error(&mut failure, error),
                }
            }
            if let Err(error) = self.refresh() {
                remember_error(&mut failure, error);
            }
            if !pending && failure.is_none() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                remember_error(
                    &mut failure,
                    io::Error::other("managed descendant reaping timed out"),
                );
                break;
            }
            std::thread::sleep(TREE_POLL_INTERVAL);
        }
        Err(failure.unwrap_or_else(|| io::Error::other("managed descendant reaping failed")))
    }

    pub(crate) fn terminate(&mut self) -> io::Result<()> {
        let deadline = Instant::now() + TREE_CLEANUP_TIMEOUT;
        let mut failure = None;
        for round in 0..TREE_CLEANUP_ROUNDS {
            if Instant::now() >= deadline {
                remember_error(
                    &mut failure,
                    io::Error::other("managed process tree cleanup timed out"),
                );
                break;
            }
            if let Err(error) = self.refresh() {
                remember_error(&mut failure, error);
            }
            let mut identities: Vec<_> = self.known.values().copied().collect();
            identities.sort_by_key(|identity| u8::from(identity.pid != self.root.pid));
            for identity in &identities {
                if let Err(error) = signal_identity(*identity, libc::SIGSTOP) {
                    remember_error(&mut failure, error);
                }
            }
            identities.reverse();
            for identity in &identities {
                if let Err(error) = signal_identity(*identity, libc::SIGKILL) {
                    remember_error(&mut failure, error);
                }
                if identity.pid != self.root.pid {
                    if let Err(error) = reap_identity(*identity) {
                        remember_error(&mut failure, error);
                    }
                }
            }
            if let Err(error) = self.refresh() {
                remember_error(&mut failure, error);
            }
            let mut remaining = 0usize;
            for identity in self.known.values().copied() {
                match identity_running(identity) {
                    Ok(true) => remaining += 1,
                    Ok(false) => {}
                    Err(error) => remember_error(&mut failure, error),
                }
            }
            if remaining == 0 && failure.is_none() {
                return Ok(());
            }
            if round + 1 < TREE_CLEANUP_ROUNDS {
                std::thread::sleep(TREE_POLL_INTERVAL);
            }
        }
        Err(failure.unwrap_or_else(|| io::Error::other("managed process tree cleanup failed")))
    }
}

#[cfg(unix)]
fn child_exited(child: &Child) -> io::Result<bool> {
    let pid = pid_from_u32(child.id())?;
    let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    loop {
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(unsafe { info.si_pid() } == pid);
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return Err(error);
    }
}

pub(crate) struct ManagedChild {
    child: Child,
    status: Option<ExitStatus>,
    #[cfg(unix)]
    tree: UnixTree,
    #[cfg(windows)]
    job: Option<crate::windows_job::JobHandle>,
}

impl ManagedChild {
    pub(crate) fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if let Some(status) = self.status {
            return Ok(Some(status));
        }
        #[cfg(unix)]
        {
            self.tree.refresh()?;
            if !child_exited(&self.child)? {
                return Ok(None);
            }
            let cleanup = self.tree.terminate();
            let status = self.child.wait();
            match status {
                Ok(status) => {
                    self.status = Some(status);
                    let reap = self.tree.reap_collected();
                    match (cleanup, reap) {
                        (Err(error), Ok(())) => Err(error),
                        (Ok(()), Err(error)) => Err(error),
                        (Err(cleanup), Err(reap)) => Err(io::Error::other(format!(
                            "{cleanup}; descendant reaping failed: {reap}"
                        ))),
                        (Ok(()), Ok(())) => Ok(Some(status)),
                    }
                }
                Err(wait) => match cleanup {
                    Ok(()) => Err(wait),
                    Err(cleanup) => Err(io::Error::other(format!(
                        "{cleanup}; direct child wait failed: {wait}"
                    ))),
                },
            }
        }
        #[cfg(windows)]
        {
            let Some(status) = self.child.try_wait()? else {
                return Ok(None);
            };
            self.status = Some(status);
            let result = self.signal_job();
            if result.is_err() {
                self.job.take();
            }
            result.map(|()| Some(status))
        }
    }

    pub(crate) fn terminate(&mut self) -> io::Result<ExitStatus> {
        if let Some(status) = self.status {
            return Ok(status);
        }
        #[cfg(unix)]
        {
            let cleanup = self.tree.terminate();
            let status = self.child.wait();
            match status {
                Ok(status) => {
                    self.status = Some(status);
                    let reap = self.tree.reap_collected();
                    match (cleanup, reap) {
                        (Err(error), Ok(())) => Err(error),
                        (Ok(()), Err(error)) => Err(error),
                        (Err(cleanup), Err(reap)) => Err(io::Error::other(format!(
                            "{cleanup}; descendant reaping failed: {reap}"
                        ))),
                        (Ok(()), Ok(())) => Ok(status),
                    }
                }
                Err(wait) => match cleanup {
                    Ok(()) => Err(wait),
                    Err(cleanup) => Err(io::Error::other(format!(
                        "{cleanup}; direct child wait failed: {wait}"
                    ))),
                },
            }
        }
        #[cfg(windows)]
        {
            let tree_result = self.signal_job();
            if tree_result.is_err() {
                self.job.take();
            }
            if let Err(error) = self.child.kill() {
                if let Err(tree_error) = tree_result {
                    return Err(io::Error::other(format!(
                        "{tree_error}; direct child kill failed: {error}"
                    )));
                }
            }
            let status = self.child.wait()?;
            self.status = Some(status);
            Ok(status)
        }
    }

    #[cfg(windows)]
    fn signal_job(&self) -> io::Result<()> {
        self.job
            .as_ref()
            .ok_or_else(|| io::Error::other("Windows Job handle is unavailable"))?
            .try_terminate()
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        if self.status.is_none() {
            let _ = self.terminate();
        }
    }
}

fn configure_managed_command(command: &mut Command) -> io::Result<Option<String>> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        ensure_unix_tree_ready()?;
        command.env_remove(TREE_TOKEN_ENV);
        let token = required_tree_token()?;
        command.env(TREE_TOKEN_ENV, &token);
        Ok(Some(token))
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
        command.creation_flags(CREATE_SUSPENDED);
        Ok(None)
    }
}

pub(crate) fn spawn_managed(command: &mut Command) -> Result<ManagedChild, ProcessError> {
    #[cfg(windows)]
    let job = Some(crate::windows_job::JobHandle::new().map_err(ProcessError::Tree)?);
    // tree_token is only read in the #[cfg(unix)] block below.
    #[cfg_attr(windows, allow(unused_variables))]
    let tree_token = configure_managed_command(command).map_err(ProcessError::Io)?;
    let child = command.spawn().map_err(ProcessError::Spawn)?;
    #[cfg(unix)]
    let tree = match UnixTree::capture(child.id(), tree_token) {
        Ok(tree) => tree,
        Err(error) => {
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProcessError::Io(error));
        }
    };
    #[cfg(windows)]
    {
        let job = job.as_ref().expect("managed Windows Job is unavailable");
        if let Err(error) = job
            .assign(&child)
            .and_then(|()| job.resume_primary_thread(&child))
        {
            job.terminate();
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProcessError::Tree(error));
        }
    }
    Ok(ManagedChild {
        child,
        status: None,
        #[cfg(unix)]
        tree,
        #[cfg(windows)]
        job,
    })
}

fn receive_capture(
    receiver: &Receiver<Result<(StreamKind, BoundedOutput), String>>,
    kind: StreamKind,
    grace: Duration,
    pending: &mut Option<(StreamKind, BoundedOutput)>,
) -> BoundedOutput {
    if let Some((received, capture)) = pending.take() {
        if received == kind {
            return capture;
        }
        *pending = Some((received, capture));
    }
    let deadline = Instant::now() + grace;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return BoundedOutput::default();
        }
        match receiver.recv_timeout(left) {
            Ok(Ok((received, capture))) if received == kind => return capture,
            Ok(Ok((received, capture))) => {
                *pending = Some((received, capture));
            }
            Ok(Err(message)) => {
                return BoundedOutput {
                    rendered: message,
                    ..BoundedOutput::default()
                };
            }
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                return BoundedOutput::default();
            }
        }
    }
}

enum EventOutcome {
    Finish(ProcessEnd, Option<ProcessError>),
}

fn apply_reader_event(event: ReaderEvent, child: &mut ManagedChild) -> EventOutcome {
    let (end, mut failure) = match event {
        ReaderEvent::Response => (ProcessEnd::Response, None),
        ReaderEvent::Stop => (ProcessEnd::Stopped, None),
        ReaderEvent::LineTooLong(limit) => {
            (ProcessEnd::Exited, Some(ProcessError::LineTooLong(limit)))
        }
        ReaderEvent::Protocol(message) => {
            (ProcessEnd::Exited, Some(ProcessError::Protocol(message)))
        }
        ReaderEvent::Sink(message) => (ProcessEnd::Exited, Some(ProcessError::Sink(message))),
        ReaderEvent::Read(error) => (ProcessEnd::Exited, Some(ProcessError::Io(error))),
        ReaderEvent::Input(error) => (ProcessEnd::Exited, Some(ProcessError::Input(error))),
    };
    if let Err(error) = child.terminate() {
        failure = Some(ProcessError::Io(error));
    }
    EventOutcome::Finish(end, failure)
}

pub(crate) fn run_bounded(
    mut command: Command,
    options: ProcessOptions,
) -> Result<ProcessOutput, ProcessError> {
    command
        .stdin(if options.initial_stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_managed(spawn_managed(&mut command)?, options)
}

pub(crate) fn run_managed(
    mut child: ManagedChild,
    options: ProcessOptions,
) -> Result<ProcessOutput, ProcessError> {
    let stdout = match child.child_mut().stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.terminate();
            return Err(ProcessError::Io(io::Error::other("missing stdout pipe")));
        }
    };
    let stderr = match child.child_mut().stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.terminate();
            return Err(ProcessError::Io(io::Error::other("missing stderr pipe")));
        }
    };
    let (event_tx, event_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    if let Some(input) = options.initial_stdin.clone() {
        let Some(mut stdin) = child.child_mut().stdin.take() else {
            let _ = child.terminate();
            return Err(ProcessError::Io(io::Error::other("missing stdin pipe")));
        };
        let input_tx = event_tx.clone();
        std::thread::spawn(move || {
            if let Err(error) = stdin.write_all(&input).and_then(|_| stdin.flush()) {
                let _ = input_tx.send(ReaderEvent::Input(error));
            }
        });
    } else {
        drop(child.child_mut().stdin.take());
    }
    let combined_limit = combined_capture_limit(options.limits.combined);
    let budget = Arc::new(SharedBudget::new(combined_limit));
    let stdout_budget = budget.clone();
    let stdout_options = options.clone();
    let stdout_events = event_tx.clone();
    let stdout_results = result_tx.clone();
    std::thread::spawn(move || {
        let capture = BoundedOutput::new(capture_limit(options.limits.stdout));
        read_stream(
            stdout,
            StreamKind::Stdout,
            capture,
            stdout_budget,
            stdout_options,
            stdout_events,
            stdout_results,
        );
    });
    let stderr_budget = budget.clone();
    let stderr_options = options.clone();
    let stderr_events = event_tx.clone();
    let stderr_results = result_tx.clone();
    std::thread::spawn(move || {
        let capture = BoundedOutput::new(capture_limit(options.limits.stderr));
        read_stream(
            stderr,
            StreamKind::Stderr,
            capture,
            stderr_budget,
            stderr_options,
            stderr_events,
            stderr_results,
        );
    });
    drop(event_tx);
    drop(result_tx);

    let deadline = Instant::now() + options.timeout;
    let mut end = ProcessEnd::Exited;
    let mut code = -1;
    let mut failure = None;
    loop {
        if let Ok(event) = event_rx.try_recv() {
            match apply_reader_event(event, &mut child) {
                EventOutcome::Finish(finished, error) => {
                    end = finished;
                    failure = error;
                    break;
                }
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                code = status.code().unwrap_or(-1);
                if let Ok(event) = event_rx.try_recv() {
                    match apply_reader_event(event, &mut child) {
                        EventOutcome::Finish(finished, error) => {
                            end = finished;
                            failure = error;
                        }
                    }
                }
                break;
            }
            Ok(None) => {}
            Err(error) => {
                let cleanup = child.terminate().err();
                failure = Some(ProcessError::Io(cleanup.unwrap_or(error)));
                break;
            }
        }
        if options
            .cancel
            .as_ref()
            .is_some_and(|cancel| cancel.load(Ordering::Acquire))
        {
            end = ProcessEnd::Cancelled;
            if let Err(error) = child.terminate() {
                failure = Some(ProcessError::Io(error));
            }
            break;
        }
        let now = Instant::now();
        if now >= deadline {
            match child.terminate() {
                Ok(_) => failure = Some(ProcessError::Timeout(options.timeout)),
                Err(error) => failure = Some(ProcessError::Io(error)),
            }
            break;
        }
        if let Ok(event) = event_rx.recv_timeout((deadline - now).min(Duration::from_millis(10))) {
            match apply_reader_event(event, &mut child) {
                EventOutcome::Finish(finished, error) => {
                    end = finished;
                    failure = error;
                    break;
                }
            }
        }
    }
    let grace = if end == ProcessEnd::Exited {
        DRAIN_GRACE
    } else {
        RESPONSE_DRAIN_GRACE
    };
    let mut pending = None;
    let stdout = receive_capture(&result_rx, StreamKind::Stdout, grace, &mut pending);
    let stderr = receive_capture(&result_rx, StreamKind::Stderr, grace, &mut pending);
    match failure {
        Some(error) => Err(error),
        None => Ok(ProcessOutput {
            stdout,
            stderr,
            code,
            end,
        }),
    }
}

struct SinkFile {
    file: std::fs::File,
    retained: u64,
    observed: u64,
    compacted: bool,
}

struct FileSinkInner {
    stdout: SinkFile,
    stderr: SinkFile,
    limits: ProcessLimits,
    combined_retained: u64,
    limit_exceeded: bool,
}

pub(crate) struct CappedFileSink {
    inner: std::sync::Mutex<FileSinkInner>,
}

impl CappedFileSink {
    pub(crate) fn new(stdout: std::fs::File, stderr: std::fs::File, limits: ProcessLimits) -> Self {
        Self {
            inner: std::sync::Mutex::new(FileSinkInner {
                stdout: SinkFile {
                    file: stdout,
                    retained: 0,
                    observed: 0,
                    compacted: false,
                },
                stderr: SinkFile {
                    file: stderr,
                    retained: 0,
                    observed: 0,
                    compacted: false,
                },
                limits,
                combined_retained: 0,
                limit_exceeded: false,
            }),
        }
    }

    pub(crate) fn write(&self, kind: StreamKind, bytes: &[u8]) -> Result<bool, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "output sink lock poisoned".to_string())?;
        let local_limit = match kind {
            StreamKind::Stdout => inner.limits.stdout as u64,
            StreamKind::Stderr => inner.limits.stderr as u64,
        };
        let combined_limit = inner.limits.combined as u64;
        let combined_retained = inner.combined_retained;
        let file = match kind {
            StreamKind::Stdout => &mut inner.stdout,
            StreamKind::Stderr => &mut inner.stderr,
        };
        file.observed = file.observed.saturating_add(bytes.len() as u64);
        let local_available = local_limit.saturating_sub(file.retained) as usize;
        let combined_available = combined_limit.saturating_sub(combined_retained) as usize;
        let accepted = bytes.len().min(local_available).min(combined_available);
        file.file
            .write_all(&bytes[..accepted])
            .map_err(|error| error.to_string())?;
        file.retained = file.retained.saturating_add(accepted as u64);
        let exceeded = accepted < bytes.len();
        if exceeded {
            compact_file(file).map_err(|error| error.to_string())?;
        }
        inner.combined_retained = combined_retained.saturating_add(accepted as u64);
        if exceeded {
            inner.limit_exceeded = true;
            return Ok(true);
        }
        Ok(false)
    }

    pub(crate) fn limit_exceeded(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.limit_exceeded)
            .unwrap_or(true)
    }
}

fn read_file_section(file: &mut std::fs::File, start: u64, length: usize) -> io::Result<Vec<u8>> {
    file.seek(io::SeekFrom::Start(start))?;
    let mut bytes = vec![0u8; length];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn compact_file(sink: &mut SinkFile) -> io::Result<()> {
    if sink.compacted {
        return Ok(());
    }
    let retained = sink.retained as usize;
    let front_len = retained / 3;
    let tail_len = retained - front_len;
    let front = read_file_section(&mut sink.file, 0, front_len)?;
    let tail = read_file_section(&mut sink.file, front_len as u64, tail_len)?;
    sink.file.set_len(0)?;
    sink.file.seek(io::SeekFrom::Start(0))?;
    sink.file.write_all(&front)?;
    sink.file.write_all(&tail)?;
    sink.file.flush()?;
    sink.compacted = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const HELPER_MODE: &str = "VTNEXA_PROCESS_HELPER_MODE";
    const HELPER_PID: &str = "VTNEXA_PROCESS_HELPER_PID";
    #[cfg(unix)]
    const TREE_CHILD_PID: &str = "VTNEXA_TREE_CHILD_PID";
    #[cfg(unix)]
    const TREE_GRANDCHILD_PID: &str = "VTNEXA_TREE_GRANDCHILD_PID";

    fn helper_command(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "process::tests::process_helper", "--nocapture"])
            .env(HELPER_MODE, mode);
        command
    }

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "vtnexa-process-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ))
    }

    fn write_pid() {
        if let Ok(path) = std::env::var(HELPER_PID) {
            let _ = std::fs::write(path, std::process::id().to_string());
        }
    }

    #[cfg(unix)]
    fn tree_command(label: &str, response: bool, wait: bool) -> (Command, PathBuf, PathBuf) {
        let child_path = temp_path(&format!("{label}-child-pid"));
        let grandchild_path = temp_path(&format!("{label}-grandchild-pid"));
        let _ = std::fs::remove_file(&child_path);
        let _ = std::fs::remove_file(&grandchild_path);
        let response = if response {
            "printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":42,\"result\":{\"ok\":true}}'; "
        } else {
            ""
        };
        let wait = if wait { "wait \"$grandchild\"" } else { "" };
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let sleeper = "setsid sleep 30";
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let sleeper = "sleep 30";
        let script = format!(
            "{sleeper} & grandchild=$!; printf '%s' \"$grandchild\" > \"${{{TREE_GRANDCHILD_PID}}}\"; printf '%s' \"$$\" > \"${{{TREE_CHILD_PID}}}\"; {response}{wait}"
        );
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .env(TREE_CHILD_PID, &child_path)
            .env(TREE_GRANDCHILD_PID, &grandchild_path);
        (command, child_path, grandchild_path)
    }

    #[cfg(unix)]
    fn read_pid(path: &std::path::Path) -> i32 {
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
                "managed process tree is still alive: {alive:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn tree_tokens_are_unique_and_parent_marker_is_removed() {
        std::env::set_var(TREE_TOKEN_ENV, "stale");
        let first = required_tree_token().unwrap();
        let second = required_tree_token().unwrap();
        assert!(first != second);
        assert_eq!(first.len(), 64);
        assert!(std::env::var_os(TREE_TOKEN_ENV).is_none());
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn missing_proc_snapshot_fails_closed() {
        let pid = pid_from_u32(std::process::id()).unwrap();
        assert!(capture_linux_snapshot_at(Path::new("/vtnexa-no-proc"), pid, None).is_err());
    }

    #[cfg(target_os = "macos")]
    fn macos_procargs_fixture(arguments: &[&str], environment: &[&str]) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&(arguments.len() as libc::c_int).to_ne_bytes());
        data.extend_from_slice(b"/bin/false\0");
        for argument in arguments {
            data.extend_from_slice(argument.as_bytes());
            data.push(0);
        }
        for entry in environment {
            data.extend_from_slice(entry.as_bytes());
            data.push(0);
        }
        data
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_process_identity_enumeration_compiles() {
        let pid = pid_from_u32(std::process::id()).unwrap();
        let record = read_process_record(pid).unwrap();
        assert_eq!(record.identity.pid, pid);
        let snapshot = capture_macos_snapshot(None).unwrap();
        assert!(snapshot.records.contains_key(&pid));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_environment_token_requires_exact_environment_pair() {
        let token = "a1";
        let command_line = macos_procargs_fixture(
            &["VTNEXA_TREE_TOKEN=a1"],
            &["PATH=/bin", "VTNEXA_TREE_TOKEN=a1"],
        );
        assert!(macos_procargs_has_exact_token(&command_line, token).unwrap());
        let command_only = macos_procargs_fixture(&["VTNEXA_TREE_TOKEN=a1"], &["PATH=/bin"]);
        assert!(!macos_procargs_has_exact_token(&command_only, token).unwrap());
        let false_positive = macos_procargs_fixture(&["x"], &["VTNEXA_TREE_TOKEN=a1x"]);
        assert!(!macos_procargs_has_exact_token(&false_positive, token).unwrap());
        let prefixed = macos_procargs_fixture(&["x"], &["XVTNEXA_TREE_TOKEN=a1"]);
        assert!(!macos_procargs_has_exact_token(&prefixed, token).unwrap());
        let mut padded = Vec::new();
        padded.extend_from_slice(&1i32.to_ne_bytes());
        padded.extend_from_slice(b"/bin/false\0\0\0");
        padded.extend_from_slice(b"x\0VTNEXA_TREE_TOKEN=a1\0");
        assert!(macos_procargs_has_exact_token(&padded, token).unwrap());
    }

    #[cfg(all(
        unix,
        not(any(target_os = "linux", target_os = "android", target_os = "macos"))
    ))]
    #[test]
    fn fallback_process_identity_enumeration_compiles() {
        let pid = pid_from_u32(std::process::id()).unwrap();
        let record = read_process_record(pid).unwrap();
        assert_eq!(record.identity.pid, pid);
    }

    #[cfg(all(
        unix,
        not(any(target_os = "linux", target_os = "android", target_os = "macos"))
    ))]
    #[test]
    fn fallback_environment_token_requires_exact_pair() {
        let line = "123 1 123 Mon Jan 1 00:00:00 2024 command VTNEXA_TREE_TOKEN=abc";
        let (record, display) = parse_fallback_ps_line(line).unwrap().unwrap();
        assert_eq!(record.identity.pid, 123);
        assert!(fallback_display_has_exact_token(&display, "abc"));
        assert!(!fallback_display_has_exact_token(
            "command VTNEXA_TREE_TOKEN=abcd",
            "abc"
        ));
        assert!(!fallback_display_has_exact_token(
            "command XVTNEXA_TREE_TOKEN=abc",
            "abc"
        ));
    }

    #[test]
    fn process_helper() {
        let Ok(mode) = std::env::var(HELPER_MODE) else {
            return;
        };
        match mode.as_str() {
            "noisy" => {
                let stdout = std::io::stdout();
                let stderr = std::io::stderr();
                let mut stdout = stdout.lock();
                let mut stderr = stderr.lock();
                let block = [b'x'; READ_CHUNK];
                for _ in 0..64 {
                    let _ = stdout.write_all(&block);
                    let _ = stderr.write_all(&block);
                }
                let _ = stdout.flush();
                let _ = stderr.flush();
            }
            "timeout" => {
                write_pid();
                std::thread::sleep(Duration::from_secs(30));
            }
            "response" => {
                write_pid();
                println!(
                    "{}",
                    serde_json::json!({"jsonrpc": "2.0", "id": 42, "result": {"ok": true}})
                );
                std::thread::sleep(Duration::from_secs(30));
            }
            "long-line" => {
                println!("{}", "x".repeat(4096));
                std::thread::sleep(Duration::from_secs(30));
            }
            _ => {}
        }
        std::process::exit(0);
    }

    #[cfg(unix)]
    #[test]
    fn short_lived_commands_remain_supported() {
        let output = run_bounded(
            Command::new("true"),
            ProcessOptions::new(Duration::from_secs(2), ProcessLimits::new(1024, 1024, 2048)),
        )
        .unwrap();
        assert_eq!(output.code(), 0);
    }

    #[test]
    fn noisy_output_is_bounded_and_marked() {
        let limits = ProcessLimits::new(8192, 8192, 16384);
        let output = run_bounded(
            helper_command("noisy"),
            ProcessOptions::new(Duration::from_secs(5), limits),
        )
        .unwrap();
        assert!(output.stdout_truncated());
        assert!(output.stderr_truncated());
        assert!(output.stdout().contains("truncated"));
        assert!(output.stderr().contains("truncated"));
        assert!(output.stdout().len() <= 8192);
        assert!(output.stderr().len() <= 8192);
        assert!(output.stdout().len() + output.stderr().len() <= 16384);
        assert!(output.stdout_bytes_seen() > 8192);
    }

    #[test]
    fn timeout_kills_and_reaps_child() {
        let pid_path = temp_path("timeout-pid");
        let _ = std::fs::remove_file(&pid_path);
        let mut command = helper_command("timeout");
        command.env(HELPER_PID, &pid_path);
        let error = run_bounded(
            command,
            ProcessOptions::new(
                Duration::from_millis(500),
                ProcessLimits::new(4096, 4096, 8192),
            ),
        )
        .unwrap_err();
        assert!(matches!(error, ProcessError::Timeout(_)));
        let pid = std::fs::read_to_string(&pid_path)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        #[cfg(unix)]
        {
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                let result = unsafe { libc::kill(pid, 0) };
                if result != 0 {
                    break;
                }
                assert!(Instant::now() < deadline, "child {pid} was not reaped");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(not(unix))]
        let _ = pid;
        let _ = std::fs::remove_file(pid_path);
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn timeout_kills_setsid_root() {
        let pid_path = temp_path("setsid-root-pid");
        let _ = std::fs::remove_file(&pid_path);
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("setsid sh -c 'printf \"%s\" \"$$\" > \"$VTNEXA_SETSID_ROOT_PID\"; exec sleep 30'")
            .env("VTNEXA_SETSID_ROOT_PID", &pid_path);
        let error = run_bounded(
            command,
            ProcessOptions::new(
                Duration::from_millis(200),
                ProcessLimits::new(4096, 4096, 8192),
            ),
        )
        .unwrap_err();
        assert!(matches!(error, ProcessError::Timeout(_)));
        let pid = read_pid(&pid_path);
        assert_processes_gone(&[pid]);
        let _ = std::fs::remove_file(pid_path);
    }

    #[test]
    fn response_stops_child_without_waiting_for_exit() {
        let pid_path = temp_path("response-pid");
        let _ = std::fs::remove_file(&pid_path);
        let mut command = helper_command("response");
        command.env(HELPER_PID, &pid_path);
        let started = Instant::now();
        let output = run_bounded(
            command,
            ProcessOptions::new(
                Duration::from_secs(5),
                ProcessLimits::new(8192, 8192, 16384),
            )
            .with_max_stdout_line(1024)
            .with_line_observer(Arc::new(|line| {
                if serde_json::from_slice::<serde_json::Value>(line)
                    .ok()
                    .and_then(|value| value.get("id").and_then(|id| id.as_u64()))
                    == Some(42)
                {
                    LineDecision::Response
                } else {
                    LineDecision::Continue
                }
            })),
        )
        .unwrap();
        assert_eq!(output.end(), ProcessEnd::Response);
        assert!(started.elapsed() < Duration::from_secs(2));
        let pid = std::fs::read_to_string(&pid_path)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        #[cfg(unix)]
        {
            let deadline = Instant::now() + Duration::from_secs(1);
            while unsafe { libc::kill(pid, 0) } == 0 {
                assert!(Instant::now() < deadline, "child {pid} was not reaped");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(not(unix))]
        let _ = pid;
        let _ = std::fs::remove_file(pid_path);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_shell_grandchild_tree() {
        let (command, child_path, grandchild_path) = tree_command("timeout-tree", false, true);
        let error = run_bounded(
            command,
            ProcessOptions::new(
                Duration::from_millis(500),
                ProcessLimits::new(4096, 4096, 8192),
            ),
        )
        .unwrap_err();
        assert!(matches!(error, ProcessError::Timeout(_)));
        let child = read_pid(&child_path);
        let grandchild = read_pid(&grandchild_path);
        assert_ne!(child, grandchild);
        assert_processes_gone(&[child, grandchild]);
        let _ = std::fs::remove_file(child_path);
        let _ = std::fs::remove_file(grandchild_path);
    }

    #[cfg(unix)]
    #[test]
    fn response_stop_kills_shell_grandchild_tree() {
        let (command, child_path, grandchild_path) = tree_command("response-tree", true, true);
        let output = run_bounded(
            command,
            ProcessOptions::new(
                Duration::from_secs(5),
                ProcessLimits::new(8192, 8192, 16384),
            )
            .with_max_stdout_line(1024)
            .with_line_observer(Arc::new(|line| {
                if serde_json::from_slice::<serde_json::Value>(line)
                    .ok()
                    .and_then(|value| value.get("id").and_then(|id| id.as_u64()))
                    == Some(42)
                {
                    LineDecision::Response
                } else {
                    LineDecision::Continue
                }
            })),
        )
        .unwrap();
        assert_eq!(output.end(), ProcessEnd::Response);
        let child = read_pid(&child_path);
        let grandchild = read_pid(&grandchild_path);
        assert_ne!(child, grandchild);
        assert_processes_gone(&[child, grandchild]);
        let _ = std::fs::remove_file(child_path);
        let _ = std::fs::remove_file(grandchild_path);
    }

    #[cfg(unix)]
    #[test]
    fn direct_exit_kills_shell_grandchild_tree() {
        let (command, child_path, grandchild_path) = tree_command("direct-exit-tree", false, false);
        let output = run_bounded(
            command,
            ProcessOptions::new(Duration::from_secs(2), ProcessLimits::new(4096, 4096, 8192)),
        )
        .unwrap();
        assert_eq!(output.code(), 0);
        let child = read_pid(&child_path);
        let grandchild = read_pid(&grandchild_path);
        assert_ne!(child, grandchild);
        assert_processes_gone(&[child, grandchild]);
        let _ = std::fs::remove_file(child_path);
        let _ = std::fs::remove_file(grandchild_path);
    }

    #[cfg(unix)]
    #[test]
    fn drop_kills_setsid_tree() {
        let (mut command, child_path, grandchild_path) = tree_command("drop-tree", false, true);
        let child = spawn_managed(&mut command).unwrap();
        let child_pid = read_pid(&child_path);
        let grandchild_pid = read_pid(&grandchild_path);
        drop(child);
        assert_processes_gone(&[child_pid, grandchild_pid]);
        let _ = std::fs::remove_file(child_path);
        let _ = std::fs::remove_file(grandchild_path);
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_kills_setsid_tree() {
        let (mut command, child_path, grandchild_path) = tree_command("cancel-tree", false, true);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let cancel = Arc::new(AtomicBool::new(false));
        let child = spawn_managed(&mut command).unwrap();
        let child_pid = read_pid(&child_path);
        let grandchild_pid = read_pid(&grandchild_path);
        let cancel_value = cancel.clone();
        let cancel_thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel_value.store(true, Ordering::Release);
        });
        let result = run_managed(
            child,
            ProcessOptions::new(Duration::from_secs(5), ProcessLimits::new(4096, 4096, 8192))
                .with_cancel(cancel),
        )
        .unwrap();
        cancel_thread.join().unwrap();
        assert_eq!(result.end(), ProcessEnd::Cancelled);
        assert_processes_gone(&[child_pid, grandchild_pid]);
        let _ = std::fs::remove_file(child_path);
        let _ = std::fs::remove_file(grandchild_path);
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_leaves_unmanaged_children_alone() {
        let mut unrelated = Command::new("sleep").arg("30").spawn().unwrap();
        let unrelated_pid = unrelated.id() as i32;
        let (command, child_path, grandchild_path) = tree_command("unmanaged-tree", false, true);
        let result = run_bounded(
            command,
            ProcessOptions::new(Duration::from_secs(5), ProcessLimits::new(4096, 4096, 8192)),
        );
        let child_pid = read_pid(&child_path);
        let grandchild_pid = read_pid(&grandchild_path);
        let unrelated_was_alive = process_exists(unrelated_pid);
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        assert!(matches!(result, Err(ProcessError::Timeout(_))));
        assert!(unrelated_was_alive);
        assert_processes_gone(&[child_pid, grandchild_pid]);
        let _ = std::fs::remove_file(child_path);
        let _ = std::fs::remove_file(grandchild_path);
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn direct_exit_kills_setsid_double_fork_descendant() {
        let child_path = temp_path("double-fork-child-pid");
        let grandchild_path = temp_path("double-fork-grandchild-pid");
        let _ = std::fs::remove_file(&child_path);
        let _ = std::fs::remove_file(&grandchild_path);
        let script = r#"setsid sh -c "sh -c 'printf \"%s\" \"\$\$\" > \"\$VTNEXA_TREE_GRANDCHILD_PID\"; exec sleep 30' </dev/null >/dev/null 2>&1 &" & while [ ! -s "$VTNEXA_TREE_GRANDCHILD_PID" ]; do sleep 0.01; done; printf '%s' "$$" > "$VTNEXA_TREE_CHILD_PID""#;
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .env(TREE_CHILD_PID, &child_path)
            .env(TREE_GRANDCHILD_PID, &grandchild_path);
        let output = run_bounded(
            command,
            ProcessOptions::new(Duration::from_secs(3), ProcessLimits::new(4096, 4096, 8192)),
        )
        .unwrap();
        assert_eq!(output.code(), 0);
        let child = read_pid(&child_path);
        let grandchild = read_pid(&grandchild_path);
        assert_ne!(child, grandchild);
        assert_processes_gone(&[child, grandchild]);
        let _ = std::fs::remove_file(child_path);
        let _ = std::fs::remove_file(grandchild_path);
    }

    #[test]
    fn oversized_line_is_rejected() {
        let error = run_bounded(
            helper_command("long-line"),
            ProcessOptions::new(
                Duration::from_secs(3),
                ProcessLimits::new(8192, 8192, 16384),
            )
            .with_max_stdout_line(128)
            .with_line_observer(Arc::new(|_| LineDecision::Continue)),
        )
        .unwrap_err();
        assert!(matches!(error, ProcessError::LineTooLong(128)));
    }
}
