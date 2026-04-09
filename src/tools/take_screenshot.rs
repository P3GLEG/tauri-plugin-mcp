use crate::error::{Error, Result};
use crate::shared::ScreenshotParams;
use base64::Engine;
use image::DynamicImage;
use image::codecs::jpeg::JpegEncoder;
use image::ImageEncoder;
use serde_json::Value;
use tauri::{AppHandle, Runtime};
use log::info;
use crate::TauriMcpExt;
use crate::models::ScreenshotRequest;
use crate::socket_server::SocketResponse;

/// Encode a DynamicImage to JPEG with the given quality (image 0.25 API).
fn encode_jpeg(img: &DynamicImage, buf: &mut Vec<u8>, quality: u8) -> Result<()> {
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let encoder = JpegEncoder::new_with_quality(std::io::Cursor::new(buf), quality);
    encoder.write_image(rgba.as_raw(), w, h, image::ExtendedColorType::Rgba8)
        .map_err(|e| Error::WindowOperationFailed(format!("Failed to encode JPEG: {}", e)))
}

/// Resize and compress a DynamicImage to JPEG bytes based on params.
/// Returns (jpeg_bytes, final_width, final_height).
pub fn process_image_to_bytes(
    mut dynamic_image: DynamicImage,
    quality: u8,
    max_width_override: Option<u32>,
    max_size_bytes: u64,
) -> Result<Vec<u8>> {
    // Use max_width if specified, otherwise use a default if image is very large
    let effective_max_width = max_width_override.unwrap_or_else(|| {
        if dynamic_image.width() > 1024 {
            info!("[SCREENSHOT] No max width specified, defaulting to 1024px");
            1024
        } else {
            dynamic_image.width()
        }
    });

    // Handle resizing if the image is too large
    if dynamic_image.width() > effective_max_width {
        info!(
            "[SCREENSHOT] Resizing from {}x{} to maintain max width of {}",
            dynamic_image.width(),
            dynamic_image.height(),
            effective_max_width
        );
        let height = (dynamic_image.height() as f32
            * (effective_max_width as f32 / dynamic_image.width() as f32))
            as u32;
        dynamic_image = dynamic_image.resize(
            effective_max_width,
            height,
            image::imageops::FilterType::Triangle,
        );
    }

    let mut output_data = Vec::new();
    let mut current_quality = quality;

    // Try encoding with JPEG
    encode_jpeg(&dynamic_image, &mut output_data, current_quality)?;

    // Reduce quality if needed to meet max size
    while output_data.len() as u64 > max_size_bytes && current_quality > 30 {
        info!(
            "[SCREENSHOT] Output size {} bytes exceeds max {}. Reducing quality to {}",
            output_data.len(),
            max_size_bytes,
            current_quality - 10
        );
        current_quality -= 10;
        output_data.clear();
        encode_jpeg(&dynamic_image, &mut output_data, current_quality)?;
    }

    // If still too large, resize the image
    if output_data.len() as u64 > max_size_bytes && dynamic_image.width() > 800 {
        info!("[SCREENSHOT] Image still too large after quality reduction. Resizing...");
        let scale_factor = 0.8;

        while output_data.len() as u64 > max_size_bytes && dynamic_image.width() > 800 {
            let new_width = (dynamic_image.width() as f32 * scale_factor) as u32;
            let new_height = (dynamic_image.height() as f32 * scale_factor) as u32;
            info!("[SCREENSHOT] Resizing to {}x{}", new_width, new_height);
            dynamic_image = dynamic_image.resize(
                new_width,
                new_height,
                image::imageops::FilterType::Triangle,
            );
            output_data.clear();
            encode_jpeg(&dynamic_image, &mut output_data, current_quality)?;

            if dynamic_image.width() <= 800 {
                break;
            }
        }
    }

    info!(
        "[SCREENSHOT] Final image size: {}x{}, data size: {} bytes, quality: {}",
        dynamic_image.width(),
        dynamic_image.height(),
        output_data.len(),
        current_quality
    );

    Ok(output_data)
}

/// Process image to base64 data URL. Thin wrapper around process_image_to_bytes.
pub fn process_image(dynamic_image: DynamicImage, params: &ScreenshotParams) -> Result<String> {
    let quality = params.quality.unwrap_or(70) as u8;
    let max_width = params.max_width.map(|w| w as u32);
    let max_size_bytes = params
        .max_size_mb
        .map(|mb| (mb * 1024.0 * 1024.0) as u64)
        .unwrap_or(1024 * 1024);

    let output_data = process_image_to_bytes(dynamic_image, quality, max_width, max_size_bytes)?;

    let base64_data = base64::engine::general_purpose::STANDARD.encode(&output_data);

    // Final check - reject if still too large
    if base64_data.len() > 3 * 1024 * 1024 {
        return Err(Error::WindowOperationFailed(format!(
            "Screenshot is still too large: {} bytes. Try using a smaller max_width.",
            base64_data.len()
        )));
    }

    Ok(format!("data:image/jpeg;base64,{}", base64_data))
}

/// Process image and write to a file on disk. Returns the file path.
pub fn process_image_to_file(
    dynamic_image: DynamicImage,
    params: &ScreenshotParams,
    output_dir: &str,
) -> Result<String> {
    let quality = params.quality.unwrap_or(70) as u8;
    let max_width = params.max_width.map(|w| w as u32);
    let max_size_bytes = params
        .max_size_mb
        .map(|mb| (mb * 1024.0 * 1024.0) as u64)
        .unwrap_or(1024 * 1024);

    let output_data = process_image_to_bytes(dynamic_image, quality, max_width, max_size_bytes)?;

    // Ensure output directory exists
    std::fs::create_dir_all(output_dir).map_err(|e| {
        Error::WindowOperationFailed(format!("Failed to create output directory '{}': {}", output_dir, e))
    })?;

    // Generate timestamped filename
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let file_path = format!("{}/screenshot_{}.jpg", output_dir, timestamp);

    std::fs::write(&file_path, &output_data).map_err(|e| {
        Error::WindowOperationFailed(format!("Failed to write screenshot to '{}': {}", file_path, e))
    })?;

    info!("[SCREENSHOT] Saved screenshot to: {} ({} bytes)", file_path, output_data.len());

    Ok(file_path)
}

/// Generate a small thumbnail as base64 data URL.
/// Uses hardcoded params: max_width=512, quality=50, max_size=300KB.
pub fn process_thumbnail(dynamic_image: DynamicImage) -> Result<String> {
    let output_data = process_image_to_bytes(
        dynamic_image,
        50,                    // quality
        Some(512),             // max_width
        300 * 1024,            // max_size: 300KB
    )?;

    let base64_data = base64::engine::general_purpose::STANDARD.encode(&output_data);
    Ok(format!("data:image/jpeg;base64,{}", base64_data))
}

pub async fn handle_take_screenshot<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse> {
    let payload: ScreenshotRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for takeScreenshot: {}", e)))?;

    // Call the async method
    let result = app.tauri_mcp().take_screenshot_async(payload).await;
    match result {
        Ok(response) => {
            let data = serde_json::to_value(response)
                .map_err(|e| Error::Anyhow(format!("Failed to serialize response: {}", e)))?;
            Ok(SocketResponse {
                success: true,
                data: Some(data),
                error: None,
                id: None,
            })
        }
        Err(e) => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(e.to_string()),
            id: None,
        }),
    }
}
