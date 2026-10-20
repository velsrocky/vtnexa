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
        // create_new (O_EXCL): fail rather than truncate/follow a pre-planted
        // symlink at the temp path.
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
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

/// Renders a path for display, for the frontend, and for storage.
///
/// `canonicalize()` on Windows returns the extended-length form
/// (`\\?\C:\Users\me\project`). That form is accepted by Win32 calls but it
/// is meaningless to a person, rejected by some tools, and it is what the
/// workspace picker would otherwise show, so it is stripped here.
pub(crate) fn display_path(path: &std::path::Path) -> String {
    let raw = path.to_string_lossy().into_owned();
    let Some(stripped) = raw.strip_prefix(r"\\?\") else {
        return raw;
    };
    // `\\?\UNC\server\share` is the verbatim UNC form; it becomes
    // `\\server\share`.
    match stripped.strip_prefix(r"UNC\") {
        Some(unc) => format!(r"\\{unc}"),
        None => stripped.to_string(),
    }
}

/// Normalizes a path for substring screening: forward slashes, lower case,
/// and without the Windows `\\?\` verbatim prefix that `canonicalize` adds.
///
/// Without the prefix strip, a canonicalized Windows path
/// (`\\?\C:\Users\...\AppData\Local\Temp`) would never match the equivalent
/// non-canonical path, so both the sensitive-pattern check and the temp
/// directory carve-out below would silently miss it.
fn screening_form(path: &std::path::Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/").to_lowercase();
    // `\\?\C:\...` becomes `//?/c:/...`; drop only that prefix and keep the
    // leading slash of POSIX paths, which the system-path prefixes rely on.
    raw.strip_prefix("//?/").unwrap_or(&raw).to_string()
}

/// True when the normalized path sits inside the platform's temporary
/// directory.
///
/// On Windows the scratch directory lives under `%LOCALAPPDATA%\Temp`, so
/// refusing everything under `%APPDATA%` also refuses the temp roots the app
/// and its tests legitimately work in. The temp directory holds no
/// credential material, so it is carved out of the `appdata` refusal below.
fn is_under_temp_dir(normalized: &str) -> bool {
    let temp = screening_form(&std::env::temp_dir());
    let temp = temp.trim_end_matches('/');
    !temp.is_empty() && (normalized == temp || normalized.starts_with(&format!("{temp}/")))
}

pub(crate) fn reject_sensitive(path: &std::path::Path) -> Result<(), String> {
    let s = screening_form(path);
    let under_temp = is_under_temp_dir(&s);
    for pat in [
        ".ssh",
        ".gnupg",
        ".pki",
        "vtai-browser-profile",
        "browser-profile",
        ".bash_history",
        ".zsh_history",
        ".aws/credentials",
        ".config/gh/hosts.yml",
        "appdata",
        "userprofile",
        "windows/system32/config",
        "windows/system32/drivers/etc",
    ] {
        // `appdata` is a credential-store guard on Windows, but the temp
        // directory is a legitimate scratch area underneath it.
        if pat == "appdata" && under_temp {
            continue;
        }
        if s.contains(pat) {
            return Err(format!("refused: sensitive path ({})", pat));
        }
    }
    for prefix in [
        "/etc/",
        "/proc/",
        "/sys/",
        "/dev/",
        "/root/",
        "/boot/",
        "c:/windows/system32/config/",
        "c:/windows/system32/drivers/etc/",
    ] {
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
    fn display_path_strips_the_windows_verbatim_prefix() {
        assert_eq!(
            display_path(std::path::Path::new(r"\\?\C:\Users\me\project")),
            r"C:\Users\me\project"
        );
        assert_eq!(
            display_path(std::path::Path::new(r"\\?\UNC\server\share\file.txt")),
            r"\\server\share\file.txt"
        );
        assert_eq!(
            display_path(std::path::Path::new("/home/me/project")),
            "/home/me/project"
        );
    }

    #[test]
    fn the_temp_directory_is_never_a_sensitive_path() {
        // On Windows the scratch directory lives under `%LOCALAPPDATA%\Temp`,
        // so refusing everything under `%APPDATA%` would block every path
        // the app and its tests legitimately write to.
        let temp = std::env::temp_dir().join("vtnexa-sensitive-probe");
        assert!(
            reject_sensitive(&temp).is_ok(),
            "the temp directory must stay usable"
        );
    }

    #[test]
    fn appdata_outside_the_temp_directory_is_still_refused() {
        // `%APPDATA%` holds credential stores; only the scratch area under it
        // is carved out.
        let appdata = if cfg!(windows) {
            std::path::PathBuf::from(r"C:\Users\someone\AppData\Roaming\VTNexa")
        } else {
            std::path::PathBuf::from("/home/someone/AppData/Roaming/VTNexa")
        };
        let error = reject_sensitive(&appdata).unwrap_err();
        assert!(error.contains("appdata"), "got: {error}");
    }

    #[test]
    fn credential_paths_are_still_refused() {
        for path in [
            "/home/someone/.ssh/id_rsa",
            r"C:\Users\someone\.ssh\id_rsa",
            "/home/someone/.aws/credentials",
            "/home/someone/.config/gh/hosts.yml",
        ] {
            assert!(
                reject_sensitive(std::path::Path::new(path)).is_err(),
                "must refuse {path}"
            );
        }
    }

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
