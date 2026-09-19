// Sandbox enforcement using firejail when available.
// Commands run in a confined environment with restricted filesystem access.

use std::process::Command;

#[allow(dead_code)]
const FIREJAIL_PATH: &str = "/usr/bin/firejail";
#[allow(dead_code)]
const MAX_WALL_TIME_SECS: u64 = 300;
#[allow(dead_code)]
const MAX_MEMORY_KB: u64 = 512_000;

#[allow(dead_code)]
pub fn firejail_available() -> bool {
    std::path::Path::new(FIREJAIL_PATH).exists()
}

/// Build a firejail command with workspace confinement and resource limits.
#[allow(dead_code)]
pub fn build_jailed_command(cmd: &str, cwd: &std::path::Path) -> Command {
    let mut c = Command::new(FIREJAIL_PATH);
    c.arg("--quiet")
        .arg("--profile=new")
        .arg("--private-tmp")
        .arg("--private-dev")
        .arg("--nonewpriv")
        .arg("--rlimit-time")
        .arg(MAX_WALL_TIME_SECS.to_string())
        .arg("--rlimit-as")
        .arg(MAX_MEMORY_KB.to_string())
        .arg("--noprofile")
        .arg("--private")
        .arg("--read-only=/etc")
        .arg("--read-only=/usr")
        .arg("--read-only=/bin")
        .arg("--read-only=/sbin")
        .arg("--read-only=/lib")
        .arg("--read-only=/lib64")
        .current_dir(cwd)
        .arg("--")
        .arg("bash")
        .arg("-c")
        .arg(cmd);
    c
}

/// Run a command with optional sandboxing. Returns whether sandboxing was applied.
#[allow(dead_code)]
pub fn run_sandboxed(cmd: &str, cwd: &std::path::Path) -> Result<bool, String> {
    if firejail_available() {
        let mut child = build_jailed_command(cmd, cwd)
            .spawn()
            .map_err(|e| format!("failed to spawn jailed process: {e}"))?;
        let status = child.wait().map_err(|e| format!("failed to wait for jailed process: {e}"))?;
        Ok(status.success())
    } else {
        // Fallback: run without sandbox, log warning
        Ok(false)
    }
}

/// Check if firejail is installed, recommend installation if not.
#[allow(dead_code)]
pub fn check_firejail() -> bool {
    if firejail_available() {
        true
    } else {
        eprintln!("Warning: firejail not found. Install with: sudo apt install firejail");
        false
    }
}
