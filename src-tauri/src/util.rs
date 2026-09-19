// ---- Shared guardrail limits + small fs/path helpers ----
// The P0 guardrail constants and helpers every backend module borrows.
use std::io::Write;

// ---- Safety guardrails (P0) ----
pub(crate) const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const MAX_WRITE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_CMD_BYTES: usize = 20_000;
pub(crate) const MAX_OUT_CHARS: usize = 64 * 1024;
pub(crate) const MAX_LIST_ENTRIES: usize = 5000;

/// Atomic write: temp file in the same dir, fsync, then rename. A crash can
/// never leave a half-written session.json / config file behind.
pub(crate) fn write_atomic(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_file_name(format!(".{}.tmp-{}-{}", name, std::process::id(), nonce));
    let res = (|| -> Result<(), String> {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(content).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        drop(f);
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

pub(crate) fn truncate_chars(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    // truncate on char boundary
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated {} chars]", &s[..end], s.len() - end)
}

pub(crate) fn reject_sensitive(path: &std::path::Path) -> Result<(), String> {
    let s = path.to_string_lossy().to_lowercase();
    // SSH / GPG keys, browser profile (cookies/session), shell history
    for pat in [
        ".ssh",
        ".gnupg",
        ".pki",
        "vtai-browser-profile",
        ".bash_history",
        ".zsh_history",
        ".aws/credentials",
        ".config/gh/hosts.yml",
    ] {
        if s.contains(pat) {
            return Err(format!("refused: sensitive path ({})", pat));
        }
    }
    for prefix in ["/etc/", "/proc/", "/sys/", "/dev/", "/root/", "/boot/"] {
        if s.starts_with(prefix) || s == prefix.trim_end_matches('/') {
            return Err(format!("refused: system path ({})", prefix));
        }
    }
    Ok(())
}

pub(crate) fn safe_absolute(raw: String, what: &str) -> Result<std::path::PathBuf, String> {
    if raw.is_empty() || raw.contains('\0') {
        return Err(format!("{}: empty or invalid path", what));
    }
    if raw.len() > 8192 {
        return Err(format!("{}: path too long", what));
    }
    let p = std::path::PathBuf::from(&raw);
    if !p.is_absolute() {
        return Err(format!(
            "{}: must be absolute (got {:?}). Select a file from the tree so the full path is used.",
            what, raw
        ));
    }
    // Lexical normalize: resolve `.` and `a/b/..` without touching fs.
    let mut norm = std::path::PathBuf::new();
    for comp in p.components() {
        use std::path::Component::*;
        match comp {
            CurDir => {}
            ParentDir => {
                norm.pop();
            }
            other => norm.push(other.as_os_str()),
        }
    }
    reject_sensitive(&norm)?;
    Ok(norm)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_leaves_no_temp_files() {
        let dir = std::env::temp_dir().join(format!("vtnexa-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("session.json");
        write_atomic(&f, b"{\"ok\":1}").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"{\"ok\":1}");
        // Overwrite keeps it atomic: no .tmp-* residue in the directory.
        write_atomic(&f, b"{\"ok\":2}").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"{\"ok\":2}");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp residue: {:?}", leftovers);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
