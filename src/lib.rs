use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};
use log::{info, warn};

pub use models::*;

#[cfg(desktop)]
mod desktop;

mod error;
mod models;
pub mod shared;
mod socket_server;
mod tools;
// Platform-specific module
mod platform;
// Native input injection (replaces enigo)
#[cfg(desktop)]
mod native_input;

pub use error::{Error, Result};
pub use shared::{
    ScreenshotParams, ScreenshotResult, WindowManagerParams, WindowManagerResult,
};

#[cfg(desktop)]
use desktop::TauriMcp;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the tauri-mcp APIs.
#[cfg(desktop)]
pub trait TauriMcpExt<R: Runtime> {
    fn tauri_mcp(&self) -> &TauriMcp<R>;
}

#[cfg(desktop)]
impl<R: Runtime, T: Manager<R>> crate::TauriMcpExt<R> for T {
    fn tauri_mcp(&self) -> &TauriMcp<R> {
        self.state::<TauriMcp<R>>().inner()
    }
}

/// Socket connection type
#[derive(Clone, Debug)]
pub enum SocketType {
    /// Use IPC (Unix domain socket or Windows named pipe)
    Ipc {
        /// Path to the socket file. If None, a default path will be used.
        path: Option<std::path::PathBuf>,
    },
    /// Use TCP socket
    Tcp {
        /// Host to bind to (e.g., "127.0.0.1" or "0.0.0.0")
        host: String,
        /// Port to bind to
        port: u16,
    },
}

impl Default for SocketType {
    fn default() -> Self {
        SocketType::Ipc { path: None }
    }
}

/// Plugin configuration options.
#[derive(Default)]
pub struct PluginConfig {
    /// Application name (used for default socket naming)
    pub application_name: String,
    /// Socket configuration
    pub socket_type: SocketType,
    /// Whether to start the socket server automatically. Default is true.
    pub start_socket_server: bool,
    /// Default webview label to use when a window label doesn't match a WebviewWindow.
    /// In multi-webview architectures, the window "main" may contain a child webview
    /// with a different label (e.g., "preview"). Set this to that webview's label so
    /// the plugin knows where to send events and evaluate JS.
    pub default_webview_label: Option<String>,
    /// Optional auth token for socket server authentication.
    /// When set, clients must include this token in requests.
    pub auth_token: Option<String>,
}

impl PluginConfig {
    /// Create a new plugin configuration with default values.
    pub fn new(application_name: String) -> Self {
        Self {
            application_name,
            socket_type: SocketType::default(),
            start_socket_server: true,
            default_webview_label: None,
            auth_token: None,
        }
    }

    /// Set the socket path for IPC mode.
    pub fn socket_path(mut self, path: std::path::PathBuf) -> Self {
        self.socket_type = SocketType::Ipc { path: Some(path) };
        self
    }

    /// Configure TCP socket mode.
    pub fn tcp(mut self, host: String, port: u16) -> Self {
        self.socket_type = SocketType::Tcp { host, port };
        self
    }

    /// Set whether to start the socket server automatically.
    pub fn start_socket_server(mut self, start: bool) -> Self {
        self.start_socket_server = start;
        self
    }

    /// Set the default webview label for multi-webview architectures.
    /// When a window label (e.g., "main") doesn't directly correspond to a WebviewWindow,
    /// this label is used to find the correct webview for JS evaluation and event emission.
    pub fn default_webview_label(mut self, label: String) -> Self {
        self.default_webview_label = Some(label);
        self
    }

    /// Set an auth token for socket server authentication.
    pub fn auth_token(mut self, token: String) -> Self {
        self.auth_token = Some(token);
        self
    }

    /// Convenience: configure TCP on localhost (127.0.0.1) with the given port.
    pub fn tcp_localhost(mut self, port: u16) -> Self {
        self.socket_type = SocketType::Tcp {
            host: "127.0.0.1".to_string(),
            port,
        };
        self
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    init_with_config(PluginConfig::default())
}

/// Initializes the plugin with the given configuration.
pub fn init_with_config<R: Runtime>(config: PluginConfig) -> TauriPlugin<R> {
    // Log socket configuration
    match &config.socket_type {
        SocketType::Ipc { path } => {
            if let Some(path) = path {
                info!(
                    "[TAURI_MCP] Socket server will use custom IPC path: {}",
                    path.display()
                );
            } else if !config.application_name.is_empty() {
                let derived_path = std::env::temp_dir()
                    .join(format!("tauri-mcp-{}.sock", config.application_name));
                info!(
                    "[TAURI_MCP] Socket server will use app-derived IPC path: {}",
                    derived_path.display()
                );
            } else {
                let default_path = std::env::temp_dir().join("tauri-mcp.sock");
                info!(
                    "[TAURI_MCP] Socket server will use default IPC path: {}",
                    default_path.display()
                );
            }
        }
        SocketType::Tcp { host, port } => {
            info!(
                "[TAURI_MCP] Socket server will use TCP: {}:{}",
                host, port
            );
        }
    }

    if config.auth_token.is_none() {
        warn!("[TAURI_MCP] WARNING: No auth token configured. Socket server is unauthenticated.");
    }

    if config.start_socket_server {
        info!("[TAURI_MCP] Socket server will start automatically");
    } else {
        info!("[TAURI_MCP] Socket server auto-start is disabled");
    }

    Builder::new("tauri-mcp")
        .invoke_handler(tauri::generate_handler![
        // Server Commands
        ])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                let _ = webview.eval(include_str!("listener_patch.js"));
            }
        })
        .setup(move |app, api| {
            info!("[TAURI_MCP] Setting up plugin");
            #[cfg(mobile)]
            return Err("Mobile is not supported".into());
            #[cfg(desktop)]
            let tauri_mcp = desktop::init(app, api, &config)?;
            app.manage(tauri_mcp);
            info!("[TAURI_MCP] Plugin setup complete");
            Ok(())
        })
        .build()
}
