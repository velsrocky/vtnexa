use tauri::Manager;

pub(crate) fn next_window_label(app: &tauri::AppHandle) -> String {
    let existing = app.webview_windows().len();
    let mut n = existing + 1;
    loop {
        let label = format!("main-{n}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
        n += 1;
    }
}

/// Open an independent top-level window: own workspace root, PTYs, session,
/// provider, chat. Windows are siblings - no parent/child relationship.
#[tauri::command]
pub(crate) fn create_window(app: tauri::AppHandle) -> Result<String, String> {
    const MAX_WINDOWS: usize = 10;
    if app.webview_windows().len() >= MAX_WINDOWS {
        return Err(format!(
            "create_window: too many windows ({} max) — close one first",
            MAX_WINDOWS
        ));
    }
    let label = next_window_label(&app);
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title("VTNexa")
        .inner_size(1400.0, 900.0)
        .build()
        .map_err(|e| format!("create_window: {e}"))?;
    Ok(label)
}
