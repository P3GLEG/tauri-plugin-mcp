use serde_json::Value;
use tauri::{AppHandle, Runtime};
use log::info;

use crate::error::Error;
use crate::models::RestartAppRequest;
use crate::socket_server::SocketResponse;

pub async fn handle_restart_app<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: RestartAppRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for restart_app: {}", e)))?;

    // Clamp delay_ms to 100-5000, default 500
    let delay_ms = request.delay_ms.unwrap_or(500).clamp(100, 5000);

    info!("[TAURI_MCP] Scheduling app restart in {}ms", delay_ms);

    let app_handle = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        info!("[TAURI_MCP] Executing app restart now");
        // restart() returns `!` — it terminates the process or blocks forever.
        // This is intentional: the spawned task is fire-and-forget.
        app_handle.restart();
    });

    Ok(SocketResponse {
        success: true,
        data: Some(serde_json::json!({
            "message": format!("Restarting application in {}ms", delay_ms)
        })),
        error: None,
        id: None,
    })
}
