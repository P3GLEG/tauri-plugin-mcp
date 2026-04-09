use crate::models::ScreenshotResponse;
use crate::{Error, Result};
use image;
use log::{debug, error, info};
use tauri::Runtime;

// Import shared functionality
use crate::desktop::ScreenshotContext;
use crate::platform::shared::{finalize_screenshot, get_window_title_from_handle, handle_screenshot_task};
use crate::shared::ScreenshotParams;

// Linux/Unix implementation for taking screenshots using xcap
pub async fn take_screenshot<R: Runtime>(
    params: ScreenshotParams,
    window_context: ScreenshotContext<R>,
) -> Result<ScreenshotResponse> {
    // Clone necessary parameters for use in the closure
    let params_clone = params.clone();
    let window_label = params
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Get application name from params or use a default
    let application_name = params.application_name.clone().unwrap_or_default();

    // Get window title from the handle (works with both Window and WebviewWindow)
    let window_title = get_window_title_from_handle(&window_context.window_handle)?;

    handle_screenshot_task(move || {
        info!("[TAURI-MCP] Looking for window with title: {} (label: {})", window_title, window_label);

        // Get all windows using xcap
        let xcap_windows = match xcap::Window::all() {
            Ok(windows) => windows,
            Err(e) => return Err(Error::WindowOperationFailed(format!("Failed to get window list: {}", e))),
        };

        info!("[TAURI-MCP] Found {} windows through xcap", xcap_windows.len());

        // Find the target window
        if let Some(window) = find_window(&xcap_windows, &window_title, &application_name) {
            // Capture image directly from the window
            let image = match window.capture_image() {
                Ok(img) => img,
                Err(e) => return Err(Error::WindowOperationFailed(format!("Failed to capture window image: {}", e))),
            };

            info!("[TAURI-MCP] Successfully captured window image: {}x{}",
                  image.width(), image.height());

            // Convert to DynamicImage for further processing
            let dynamic_image = image::DynamicImage::ImageRgba8(image);

            finalize_screenshot(dynamic_image, &params_clone)
        } else {
            Err(Error::WindowOperationFailed(
                format!("Window not found. Searched for title='{}', app='{}'. \
                Found {} xcap windows. Please ensure the window is visible and not minimized.",
                window_title, application_name, xcap_windows.len())
            ))
        }
    }).await
}

// Helper function to find the window in the xcap window list
fn find_window(xcap_windows: &[xcap::Window], window_title: &str, application_name: &str) -> Option<xcap::Window> {
    let application_name_lower = application_name.to_lowercase();
    let window_title_lower = window_title.to_lowercase();

    info!(
        "[TAURI-MCP] Searching for window with title: '{}', app_name: '{}' (case-insensitive)",
        window_title,
        application_name
    );

    // Debug all windows to help with troubleshooting
    debug!("[TAURI-MCP] ============= ALL WINDOWS =============");
    for window in xcap_windows {
        if !window.is_minimized().unwrap_or(false) {
            debug!(
                "[TAURI-MCP] Window: title='{}', app_name='{}'",
                window.title().unwrap_or_default(),
                window.app_name().unwrap_or_default()
            );
        }
    }
    debug!("[TAURI-MCP] ======================================");

    // Step 1: First pass - direct application name match (highest priority)
    if !application_name_lower.is_empty() {
        for window in xcap_windows {
            if window.is_minimized().unwrap_or(false) {
                continue;
            }

            let app_name = window.app_name().unwrap_or_default().to_lowercase();

            // Direct match for application name
            if app_name.contains(&application_name_lower) {
                info!(
                    "[TAURI-MCP] Found window by app name: '{}'",
                    window.app_name().unwrap_or_default()
                );
                return Some(window.clone());
            }
        }
    }

    // Step 2: Exact window title match
    for window in xcap_windows {
        if window.is_minimized().unwrap_or(false) {
            continue;
        }

        if window.title().unwrap_or_default() == window_title {
            info!(
                "[TAURI-MCP] Found window by exact title match: '{}'",
                window.title().unwrap_or_default()
            );
            return Some(window.clone());
        }
    }

    // Step 3: Case-insensitive window title match
    for window in xcap_windows {
        if window.is_minimized().unwrap_or(false) {
            continue;
        }

        if window.title().unwrap_or_default().to_lowercase() == window_title_lower {
            info!(
                "[TAURI-MCP] Found window by case-insensitive title match: '{}'",
                window.title().unwrap_or_default()
            );
            return Some(window.clone());
        }
    }

    // Step 4: Partial window title match (title contains search string)
    for window in xcap_windows {
        if window.is_minimized().unwrap_or(false) {
            continue;
        }

        if window.title().unwrap_or_default().to_lowercase().contains(&window_title_lower) {
            info!(
                "[TAURI-MCP] Found window by partial title match: '{}'",
                window.title().unwrap_or_default()
            );
            return Some(window.clone());
        }
    }

    // Step 5: Partial app name match with title
    for window in xcap_windows {
        if window.is_minimized().unwrap_or(false) {
            continue;
        }

        let app_name = window.app_name().unwrap_or_default().to_lowercase();

        // Check if app name appears in the requested title or vice versa
        if app_name.contains(&window_title_lower) || window_title_lower.contains(&app_name) {
            info!(
                "[TAURI-MCP] Found window by partial app name match: '{}'",
                window.app_name().unwrap_or_default()
            );
            return Some(window.clone());
        }
    }

    error!(
        "[TAURI-MCP] No matching window found for '{}' or '{}'",
        window_title, application_name
    );
    None
}
