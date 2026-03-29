# Tauri Plugin: Model Context Protocol (MCP)

[![SafeSkill 83/100](https://img.shields.io/badge/SafeSkill-83%2F100_Passes%20with%20Notes-yellow)](https://safeskill.dev/scan/p3gleg-tauri-plugin-mcp)

A Tauri plugin and MCP server that allow AI agents such as Cursor and Claude Code to interact with and debug your Tauri application through screenshots, DOM access, input simulation, and more.

## Install

### npm (guest-js bindings)
```bash
npm install tauri-plugin-mcp
```

### MCP Server CLI
```bash
npm install -g tauri-plugin-mcp-server
# or run directly
npx tauri-plugin-mcp-server
```

### Rust (Cargo)
*Coming soon to crates.io.* For now, use a git dependency:
```toml
[dependencies]
tauri-plugin-mcp = { git = "https://github.com/P3GLEG/tauri-plugin-mcp" }
```

## Tools

The MCP server exposes 10 high-level tools to AI agents:

| Tool | Description |
|------|-------------|
| **take_screenshot** | Captures a screenshot of an application window. Saves full image to disk with small thumbnail inline (optimized for token efficiency). |
| **query_page** | Inspects the current page. Modes: `map` (structured element refs), `html` (raw DOM), `state` (URL/title/scroll/viewport), `find_element` (CSS pixel coordinates for clicking), `app_info` (app metadata, windows, monitors). |
| **click** | Clicks at x/y coordinates or via selector (ref, id, class, tag, text). Selector-based clicks auto-resolve element position. |
| **type_text** | Types text into the page. Supports a `fields` array for bulk form fill, selector targeting, or typing into the focused element. Works with inputs, textareas, contentEditable, React, Lexical, and Slate. |
| **mouse_action** | Non-click mouse actions: `hover`, `scroll` (by direction/amount/to element/to top/bottom), `drag` (start to end coordinates). |
| **navigate** | Webview navigation: `goto` (URL), `back`/`forward` (with optional delta), `reload`. |
| **execute_js** | Runs arbitrary JavaScript in the webview. Returns the result of the last statement or promise. |
| **manage_storage** | localStorage operations (get/set/remove/clear/keys) and cookie management (get/clear). |
| **manage_window** | Window control (list/focus/minimize/maximize/close/position/size/fullscreen), zoom, devtools, and webview state management. |
| **wait_for** | Waits for a condition: text appearing/disappearing, element visible/hidden/attached/detached. Useful after async content loads. |

## Setup

### 1. Register the plugin in your Tauri app

Only include the MCP plugin in development builds:

```rust
#[cfg(debug_assertions)]
{
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        tauri_plugin_mcp::PluginConfig::new("APPLICATION_NAME".to_string())
            .start_socket_server(true)
            // IPC socket (default — recommended)
            .socket_path("/tmp/tauri-mcp.sock")
            // Or TCP socket
            // .tcp_localhost(4000)
            // For multi-webview apps where the webview label differs from the window label
            // .default_webview_label("preview".to_string())
            // Optional auth token for TCP connections
            // .auth_token("my-secret-token".to_string())
    ));
}
```

### 2. Configure your AI agent

#### IPC Mode (default, recommended)

```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "npx",
      "args": ["tauri-plugin-mcp-server"]
    }
  }
}
```

With a custom socket path:
```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "npx",
      "args": ["tauri-plugin-mcp-server"],
      "env": {
        "TAURI_MCP_IPC_PATH": "/custom/path/to/socket"
      }
    }
  }
}
```

#### TCP Mode

For Docker, remote debugging, or when IPC doesn't work:

```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "npx",
      "args": ["tauri-plugin-mcp-server"],
      "env": {
        "TAURI_MCP_CONNECTION_TYPE": "tcp",
        "TAURI_MCP_TCP_HOST": "127.0.0.1",
        "TAURI_MCP_TCP_PORT": "4000"
      }
    }
  }
}
```

Make sure your Tauri app uses the same connection mode:
```rust
.plugin(tauri_plugin_mcp::init_with_config(
    tauri_plugin_mcp::PluginConfig::new("MyApp".to_string())
        .tcp_localhost(4000)
))
```

## Building from source

```bash
pnpm install
pnpm run build          # JS guest bindings
cargo build --release   # Rust plugin

# MCP server
cd mcp-server-ts
pnpm install && pnpm build
```

## Architecture

```
AI Agent (Claude, Cursor, etc.)
    ↕ MCP protocol (stdio)
MCP Server (tauri-plugin-mcp-server)
    ↕ IPC socket or TCP
Tauri Plugin (Rust)
    ↕ Tauri events with correlation IDs
Guest JS (webview)
    ↕ DOM APIs
Your Application
```

- **Rust plugin** (`src/`) — Async socket server, command routing, native input injection (macOS), screenshot capture
- **Guest JS** (`guest-js/`) — DOM interaction, element resolution, form filling, event handling
- **MCP Server** (`mcp-server-ts/`) — Translates MCP tool calls into socket commands

### Security

- Auth token support for TCP connections (constant-time comparison)
- Token file written with `0o600` permissions, deleted on shutdown
- Non-loopback TCP without auth token is rejected
- Stale socket cleanup on startup

### Platform notes

- **macOS**: Native `NSEvent` injection — no Accessibility permissions needed
- **Windows/Linux**: JS-based input fallback (`isTrusted=false`, ~80% coverage)
- **Screenshots**: macOS/Windows use native capture; Linux uses `xcap`

## Troubleshooting

1. **"Connection refused"** — Ensure your Tauri app is running and the socket server started. Check that both sides use the same connection mode (IPC or TCP).

2. **"Socket file not found" (IPC)** — Check that the socket path exists (look in `/tmp` on macOS/Linux). Try TCP mode as an alternative.

3. **"Permission denied"** — On Unix, check file permissions for the socket. TCP mode avoids file permission issues.

4. **Testing your setup:**
   ```bash
   npx @modelcontextprotocol/inspector npx tauri-plugin-mcp-server
   ```

## License

MIT
