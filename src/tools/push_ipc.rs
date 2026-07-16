//! Tauri invoke command that lets the webview-side `invoke()` wrapper
//! (installed by `listener_patch.js`) record observed IPC calls into the
//! Rust-side ring buffer. Best-effort observability channel: minimal
//! validation, previews are capped by the buffer itself.

use crate::ipc_buffer;

#[tauri::command]
pub fn push_ipc(
    name: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    duration_ms: Option<u64>,
    args_preview: Option<String>,
    result_preview: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let name = match name {
        Some(n) if !n.is_empty() => n,
        _ => return Ok(()), // nameless entries are useless — drop silently
    };
    let kind = match kind.as_deref() {
        Some("event") => "event",
        _ => "invoke",
    };
    let status = match status.as_deref() {
        Some("error") => "error",
        Some("emitted") => "emitted",
        _ => "ok",
    };
    ipc_buffer::global().push(kind, name, status, duration_ms, args_preview, result_preview, error);
    Ok(())
}
