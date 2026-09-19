// OS-level confinement for agent shell commands, using firejail when installed.
//
// Verified against firejail 0.9.72: workspace read/write and git work; /etc
// (including /etc/shadow) and /usr are read-only; /tmp and /dev are private
// per run; nested `timeout` works, so the 30s wall-clock cap applies inside
// the jail exactly as it does on the direct path.
//
// When firejail is absent, exec_command returns the plain `timeout`-wrapped
// command — the sandbox degrades to the screening-only path, never to a
// second execution.

use std::process::Command;

const FIREJAIL_PATH: &str = "/usr/bin/firejail";

/// Flags verified against firejail 0.9.72. Notably `--nonewprivs` (the
/// `--nonewpriv` spelling is invalid) and no `--rlimit-*` (an unsupported or
/// oversized rlimit makes firejail fail silently — `timeout` caps instead).
const FLAGS: &[&str] = &[
    "--quiet",
    "--noprofile",
    "--private-tmp",
    "--private-dev",
    "--nonewprivs",
    "--read-only=/etc",
    "--read-only=/usr",
    "--read-only=/bin",
    "--read-only=/sbin",
    "--read-only=/lib",
    "--read-only=/lib64",
];

pub(crate) fn firejail_available() -> bool {
    std::path::Path::new(FIREJAIL_PATH).exists()
}

/// The single execution path for `sh -c cmd`: firejail-wrapped when firejail
/// is installed, `timeout`-wrapped otherwise. Runs the payload exactly once;
/// callers must not execute the command a second time without the sandbox.
pub(crate) fn exec_command(cmd: &str, timeout_secs: u64, cwd: &std::path::Path) -> Command {
    let secs = format!("{timeout_secs}s");
    if firejail_available() {
        let mut c = Command::new(FIREJAIL_PATH);
        for flag in FLAGS {
            c.arg(flag);
        }
        c.current_dir(cwd)
            .arg("--")
            .arg("timeout")
            .arg(&secs)
            .arg("sh")
            .arg("-c")
            .arg(cmd);
        c
    } else {
        let mut c = Command::new("timeout");
        c.arg(&secs).arg("sh").arg("-c").arg(cmd).current_dir(cwd);
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_carry_no_known_invalid_options() {
        for flag in FLAGS {
            // All flags are of a verified, supported form: either an
            // --option or --option=value, never a bare prefix of a real
            // option (firejail rejects those hard, e.g. --nonewpriv).
            assert!(flag.starts_with("--"));
            assert_ne!(*flag, "--nonewpriv");
            assert!(!flag.starts_with("--rlimit"));
        }
    }

    #[test]
    fn exec_command_single_command_with_payload() {
        let c = exec_command("echo hi", 30, std::path::Path::new("."));
        let joined = format!("{c:?}");
        assert!(joined.contains("echo hi"));
        assert!(joined.contains("-c"));
    }
}
