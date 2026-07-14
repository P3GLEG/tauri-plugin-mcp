use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::{get_emit_target, get_webview_for_eval};
use crate::socket_server::SocketResponse;
use crate::tools::webview::{emit_and_wait, parse_js_response};

#[derive(Debug, Deserialize)]
struct ZoomPayload {
    window_label: Option<String>,
    action: String,
    scale: Option<f64>,
}

/// Handler for manage_zoom — get/set webview zoom level
pub async fn handle_manage_zoom<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let parsed: ZoomPayload = serde_json::from_value(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for manage_zoom: {}", e))
    })?;

    let window_label = parsed.window_label.unwrap_or_else(|| "main".to_string());
    let webview = get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    match parsed.action.as_str() {
        "set" => {
            let scale = parsed.scale.ok_or_else(|| {
                crate::error::Error::Anyhow("'scale' is required for set action".to_string())
            })?;
            webview.set_zoom(scale).map_err(|e| {
                crate::error::Error::Anyhow(format!("Failed to set zoom: {}", e))
            })?;
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"action": "set", "scale": scale}))))
        }
        "get" => {
            let emit_target = get_emit_target(app, &window_label);

            match emit_and_wait(
                app,
                &emit_target,
                "manage-zoom",
                "manage-zoom-response",
                serde_json::json!({"action": "get"}),
                std::time::Duration::from_secs(5),
            ).await {
                Ok(result) => Ok(parse_js_response(&result)),
                Err(e) => Ok(SocketResponse::err(None, format!("Timeout waiting for zoom level: {}", e))),
            }
        }
        _ => Ok(SocketResponse::err(None, format!(
                "Unknown action '{}'. Valid actions: set, get",
                parsed.action
            ))),
    }
}
