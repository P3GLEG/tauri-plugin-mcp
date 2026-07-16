# Tauri Plugin: Model Context Protocol (MCP)

A Tauri plugin and MCP server that allow AI agents such as Cursor and Claude Code to interact with and debug your Tauri application through screenshots, DOM access, input simulation, and more.

Upgrading? Behavior changes are listed in [CHANGELOG.md](CHANGELOG.md).

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

The MCP server exposes 15 high-level tools to AI agents:

| Tool | Description |
|------|-------------|
| **take_screenshot** | Captures a screenshot of an application window. Saves full image to disk with small thumbnail inline (optimized for token efficiency). |
| **query_page** | Inspects the current page. Modes: `map` (structured element refs), `html` (raw DOM), `state` (URL/title/scroll/viewport), `find_element` (CSS pixel coordinates for clicking), `app_info` (app metadata, windows, monitors). |
| **click** | Clicks via selector (ref, id, class, css, tag, text) or at raw x/y coordinates. Selector-based left clicks dispatch synthetic pointer events at the element (no OS permissions needed); right/middle/double and raw x/y clicks use native clicking. |
| **type_text** | Types text into the page. Supports a `fields` array for bulk form fill, selector targeting, or typing into the focused element. Selects options in `<select>` dropdowns by value or label, and attaches files to `<input type="file">` via a `files` array. Works with inputs, textareas, contentEditable, React, Lexical, and Slate. |
| **press_key** | Presses keyboard keys the typing tools can't express: Escape, Enter, Tab, arrows, Backspace/Delete, F-keys, and modifier chords (cmd+a). Emulates default actions (Enter submits, Tab moves focus) unless the app prevents them. |
| **mouse_action** | Non-click mouse actions: `hover`, `scroll` (by direction/amount/to element/to top/bottom), `drag` (start to end coordinates). |
| **navigate** | Webview navigation: `goto` (URL), `back`/`forward` (with optional delta), `reload`. |
| **execute_js** | Runs arbitrary JavaScript in the webview. Returns the last expression's value; promises are awaited. The universal escape hatch. |
| **manage_storage** | localStorage operations (get/set/remove/clear/keys) and cookie management (get/clear). |
| **manage_window** | Window control (list/focus/minimize/maximize/close/position/size/fullscreen), zoom, devtools, and webview state management. |
| **wait_for** | Waits for a condition: text appearing/disappearing, element visible/hidden/attached/detached. Useful after async content loads. |
| **restart_app** | Restarts the Tauri application and waits for it to come back online. Force-kills a frozen app (IPC mode only). Refuses under `tauri dev` — restarting would orphan the app outside the dev supervisor; reload the frontend with `navigate` instead. |
| **manage_ipc** | Tauri IPC access: `invoke` any `#[tauri::command]` with JSON args through the app's real IPC path, inspect captured webview↔Rust invoke traffic (names, args/result previews, latency, error rates), and drive events — `emit` fires one, `arm_event` registers a background listener before you act (arm → act → check `captured` to assert an event fired), `wait_event` blocks for recurring events. Entries an app self-reports via `push_ipc` are labeled `[self-reported]` — any page script can forge them, so they're surfaced as untrusted. |
| **query_logs** | Queries buffered app logs (Rust `log!()` output, webview `console.*` calls, and intercepted dialogs) with level/source/substring filters, pagination, and a summary mode. |
| **log_mark** | Inserts begin/end markers into the log buffer so `query_logs` can return exactly the logs produced by an action. |

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
            // Optional explicit auth token (IPC and TCP). If omitted, a random
            // token is generated and written to a `.token` sidecar file that
            // the MCP server discovers automatically — no wiring needed.
            // .auth_token("my-secret-token".to_string())
    ));
}
```

By default the plugin replaces `window.alert`/`confirm`/`prompt` with non-blocking stubs — native dialogs block the webview's JS thread and would deadlock every MCP tool that round-trips through JS. Intercepted dialogs are auto-answered (`confirm` → false — the safe answer for a consent gate, `prompt` → its default value) and recorded in the log buffer under target `"dialog"` so `query_logs` can report them. Opt out with `.stub_dialogs(false)`, or override answers at runtime by setting `window.__TAURI_MCP_DIALOG_RESPONSES__ = { confirm: true, prompt: "value" }` (e.g. via `execute_js`).

The `#[cfg(debug_assertions)]` guard keeps the plugin out of release binaries entirely. As a second line of defense, the plugin also refuses to start its socket server in release builds unless you explicitly opt in with `.allow_release_builds(true)`.

### 2. Initialize the guest bindings

The webview side of the plugin must be initialized by your frontend — tools like `execute_js`, `query_page`, `type_text`, `click` (selector mode), and `wait_for` depend on it. Without this step those tools fail with a timeout ("Timeout waiting for JS execution").

```bash
npm install tauri-plugin-mcp
```

```ts
// In your app's entry point (e.g. main.ts / main.tsx)
import { setupPluginListeners } from 'tauri-plugin-mcp';

if (import.meta.env.DEV) {
  setupPluginListeners();
}
```

Like the Rust side, gate it to development builds.

> **If your app defines an explicit `app.security.capabilities` list in `tauri.conf.json`, you must add the plugin's capability to it.** In Tauri v2 a non-empty `capabilities` list is an *allowlist* — capabilities not named in it are silently ignored, even though they compile. If the list omits the mcp capability, the webview→plugin commands (`push_log`, `push_ipc`) are denied with `"mcp.push_log not allowed"`, and console/dialog logging and IPC capture silently produce nothing while every other tool keeps working (socket-driven tools don't go through this path). Symptom: `window.__TAURI_MCP_LOG_STATS__` in the webview shows `ok: 0, err: N`. Either grant the mcp capability in a capability file and remove the explicit allowlist (Tauri then auto-enables all capability files), or add the capability's identifier to the list — dev-only, since a release build won't have compiled it.

### 3. Configure your AI agent

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

### Running multiple app instances

The Rust plugin honors the `TAURI_MCP_IPC_PATH` environment variable (which overrides the configured IPC socket path), `TAURI_MCP_TCP_PORT` for TCP mode, and `TAURI_MCP_AUTH_TOKEN` (overrides the configured/auto-generated auth token; the TS server reads the same variable). To drive several app instances side by side, launch each instance with its own socket path:

```bash
TAURI_MCP_IPC_PATH=/tmp/myapp-a.sock pnpm tauri dev
TAURI_MCP_IPC_PATH=/tmp/myapp-b.sock pnpm tauri dev
```

Then register one MCP server entry per instance, each with the matching `TAURI_MCP_IPC_PATH` in its env block (the TS server reads the same variable):

```json
{
  "mcpServers": {
    "tauri-mcp-instance-a": {
      "command": "npx",
      "args": ["tauri-plugin-mcp-server"],
      "env": {
        "TAURI_MCP_IPC_PATH": "/tmp/myapp-a.sock"
      }
    },
    "tauri-mcp-instance-b": {
      "command": "npx",
      "args": ["tauri-plugin-mcp-server"],
      "env": {
        "TAURI_MCP_IPC_PATH": "/tmp/myapp-b.sock"
      }
    }
  }
}
```

For TCP, give each instance its own `TAURI_MCP_TCP_PORT` instead.

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

> **⚠️ This is a development tool. Never ship it in production builds.**
> Any process that can reach the socket gets effectively full control of your
> app: arbitrary JavaScript in the app's origin (including access to session
> data), cookie/localStorage reads, OS-level input injection (macOS), and
> screenshots. Keep plugin registration behind `#[cfg(debug_assertions)]` and
> the guest bindings behind a dev-mode check.

Protections in place:

- **Release-build refusal** — the socket server will not start in a release build unless the app opts in with `.allow_release_builds(true)`.
- **Authentication on by default** — if no token is configured, a random one is generated at startup. It's written to a `.token` sidecar file next to the socket (`0o600` on Unix, deleted on shutdown), which the MCP server reads automatically — the default setup stays zero-config. Set an explicit token with `.auth_token(...)` or the `TAURI_MCP_AUTH_TOKEN` env var (both sides honor it). Opting out requires an explicit `.insecure_no_auth()`.
- **Constant-time token comparison** to prevent timing side-channels.
- **Unix socket permissions** — the IPC socket is `chmod 0600` (owner-only).
- **Non-loopback TCP without an explicit auth token is rejected.**
- **Bounded request size** — oversized request lines are dropped before parsing.
- Stale socket and token-file cleanup on startup.

Known limitations: on Windows, the named pipe and token file currently use default ACLs (not yet restricted to the current user the way Unix `0600` is), and the IPC trust boundary on all platforms is "same user" — the token file keeps casual same-user processes out, but any process that can read your files can read the token.

### Platform notes

- **macOS keyboard** (`type_text`): native `NSEvent` injection — no Accessibility permission needed.
- **macOS native mouse** (`mouse_action` hover/drag, and `click` with raw x/y): posted via `CGEventPost`, which the window server **silently drops unless the process is trusted for Accessibility**. Grant it under System Settings → Privacy & Security → Accessibility for the process running the app (your terminal in dev, or the app bundle), then restart. Without it these calls return a clear error. **Selector-based clicks (`click` with `selector_type`/`selector_value`) dispatch synthetic DOM events and need no permission — prefer them.**
- **Windows/Linux**: JS-based input fallback (`isTrusted=false`, ~80% coverage).
- **Screenshots**: macOS/Windows use native capture; Linux uses `xcap`.

## Troubleshooting

1. **"Connection refused"** — Ensure your Tauri app is running and the socket server started. Check that both sides use the same connection mode (IPC or TCP).

2. **"Socket file not found" (IPC)** — Check that the socket path exists (look in `/tmp` on macOS/Linux). Try TCP mode as an alternative.

3. **"Permission denied"** — On Unix, check file permissions for the socket. TCP mode avoids file permission issues.

4. **Console/dialog logs and IPC capture stay empty, but other tools work** — Tauri's ACL is denying the webview→plugin commands. Check `window.__TAURI_MCP_LOG_STATS__` in the app's devtools console: if `err` is climbing and the last error is `"mcp.push_log not allowed"`, your app's `app.security.capabilities` allowlist doesn't include the mcp capability. See the note under *Initialize the guest bindings* above.

5. **Testing your setup:**
   ```bash
   npx @modelcontextprotocol/inspector npx tauri-plugin-mcp-server
   ```

## License

MIT
