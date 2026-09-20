// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Cheap CLI: --version / --help must answer without opening a window.
    // This runs before Tauri's single-instance lock, so `vtnexa --version`
    // prints even when the app is already running (instead of just focusing
    // the existing window — the behavior you just hit).
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("VTNexa {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "VTNexa {} - private, review-gated agentic workspace\n\nUsage: vtnexa [OPTIONS]\n\nOptions:\n  -h, --help       Show help\n  -V, --version    Show version\n      --uninstall  Remove VTNexa (per-user ~/.local install; also hints for system-wide)\n\nSkills (ready-made, in .vtnexa/skills/*.md - invoke as /name in Commander):\n  /commit   - conventional commit message for staged changes\n  /review   - review staged diff for bugs then style\n  /explain  - bottom-up file/function explainer\n  /map      - trace a feature across files\n  /fix      - fix an error from root cause + verify\n  /refactor - clean up a file without changing behavior\n  /test     - write or run tests for the last change\n  /docs     - docstrings for changed functions\n  /scaffold - create a project non-interactively, verified\n  Add your own: .vtnexa/skills/<name>.md (first content line is the description)\n  Project AGENTS.md / CLAUDE.md is auto-loaded into every turn.",
            env!("CARGO_PKG_VERSION")
        );
        return;
    }
    if args.iter().any(|a| a == "--uninstall") {
        let home = std::env::var("HOME").unwrap_or_default();
        if home.is_empty() {
            eprintln!("HOME not set — cannot locate ~/.local install");
            std::process::exit(1);
        }
        let home_path = std::path::PathBuf::from(&home);
        let mut removed: Vec<String> = Vec::new();
        let candidates = [
            home_path.join(".local/bin/vtnexa"),
            home_path.join(".local/lib/VTNexa"),
            home_path.join(".local/share/applications/VTNexa.desktop"),
            // legacy names from before the rename
            home_path.join(".local/bin/vtaitool"),
            home_path.join(".local/lib/vtaitool"),
            home_path.join(".local/share/applications/vtaitool.desktop"),
        ];
        for p in &candidates {
            if p.exists() {
                let res = if p.is_dir() {
                    std::fs::remove_dir_all(p)
                } else {
                    std::fs::remove_file(p)
                };
                match res {
                    Ok(_) => removed.push(p.display().to_string()),
                    Err(e) => eprintln!("failed to remove {}: {}", p.display(), e),
                }
            }
        }
        // Icons: any vtnexa.png / vtaitool.png under hicolor
        let icons_root = home_path.join(".local/share/icons/hicolor");
        if icons_root.exists() {
            fn walk(dir: &std::path::Path, out: &mut Vec<String>) {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for e in entries.flatten() {
                        let p = e.path();
                        let is_icon = p
                            .file_name()
                            .map(|n| n == "vtnexa.png" || n == "vtaitool.png")
                            .unwrap_or(false);
                        if p.is_dir() {
                            walk(&p, out);
                        } else if is_icon && std::fs::remove_file(&p).is_ok() {
                            out.push(p.display().to_string());
                        }
                    }
                }
            }
            walk(&icons_root, &mut removed);
        }
        let _ = std::process::Command::new("update-desktop-database")
            .arg(home_path.join(".local/share/applications"))
            .status();
        let _ = std::process::Command::new("gtk-update-icon-cache")
            .args(["-f", icons_root.to_string_lossy().as_ref()])
            .status();
        let system = std::path::Path::new("/usr/bin/vtnexa").exists()
            || std::path::Path::new("/usr/lib/VTNexa").exists()
            || std::path::Path::new("/usr/share/applications/VTNexa.desktop").exists();
        if removed.is_empty() && !system {
            println!("VTNexa not found in ~/.local — nothing to remove.");
        } else {
            if !removed.is_empty() {
                println!("VTNexa uninstalled — removed:");
                for r in &removed {
                    println!("  {}", r);
                }
            }
            if system {
                println!("System-wide install detected at /usr — also run: sudo dpkg -r vt-nexa");
            }
        }
        return;
    }
    vtnexa_lib::run()
}
