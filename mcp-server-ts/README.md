# Tauri MCP Server

This is a Model Context Protocol (MCP) server that connects to a Tauri application's socket server to provide tools for controlling and interacting with the Tauri application.

## Overview

The server bridges MCP clients (like LLMs) with a Tauri application by:

1. Connecting to the Tauri socket server via a Unix socket/named pipe (or TCP)
2. Providing MCP tools that map to Tauri functionality
3. Running as a stdio-based MCP server that any MCP client can use

## Available Tools

The server registers 13 MCP tools:

### `take_screenshot`

Captures a screenshot of an application window. By default saves the full image to disk and returns a small thumbnail inline (token-efficient); set `inline=true` for full base64 inline.

**Parameters:**
- `window_label` (optional): Window to capture (default: `"main"`)
- `quality` (optional): JPEG quality 1-100 (default: 70)
- `max_width` (optional): Maximum image width in pixels (default: 1024)
- `max_size_mb` (optional): Maximum file size in MB (default: 1.0)
- `output_dir` (optional): Directory to save the screenshot to (default: system temp)
- `inline` (optional): Return full-resolution base64 inline instead of saving to disk (default: false)
- `audience` (optional): `"user"`, `"assistant"`, or `"both"` — hint for who consumes the image

**Returns:** Image content (thumbnail + file path, or full inline base64)

Note: screenshot pixel coordinates do NOT match the CSS pixel coordinates used by `click`/`mouse_action`. Use `query_page` with `mode="find_element"` to get click targets.

### `query_page`

Inspects the current page.

**Parameters:**
- `mode` (required): `"map"` (structured element map with numbered refs — preferred), `"html"` (raw DOM), `"state"` (URL/title/scroll/viewport), `"find_element"` (exact CSS pixel coordinates of an element), `"app_info"` (app name, version, OS, windows, monitors)
- `window_label` (optional): Target window (default: `"main"`)
- Map-mode options: `include_content`, `interactive_only`, `scope_selector`, `max_depth`, `delta`, `wait_for_stable`, `quiet_ms`, `max_wait_ms`, `timeout_secs` (max 300), `include_metadata`
- Find-element options: `selector_type` (`"ref"`, `"id"`, `"class"`, `"css"`, `"tag"`, `"text"`), `selector_value`, `should_click`

**Returns:** JSON page map, HTML string, page state, element coordinates, or app info depending on mode

### `click`

Clicks at a position in the webview, either by raw x/y coordinates or by resolving a selector to its center.

**Parameters:**
- `x`, `y` (optional): CSS pixel coordinates (required if no selector)
- `button` (optional): `"left"`, `"right"`, `"middle"` (default: `"left"`)
- `click_type` (optional): `"single"` or `"double"` (default: `"single"`)
- `selector_type` (optional): `"ref"`, `"id"`, `"class"`, `"css"`, `"tag"`, `"text"`
- `selector_value` (optional): Selector value (for `"ref"`, the ref number as a string)
- `window_label` (optional): Target window (default: `"main"`)

**Returns:** Confirmation message with the clicked coordinates

### `type_text`

Types text into the page. Three modes: bulk form fill (`fields` array), a specific element (`selector_type` + `selector_value`), or the currently focused element (just `text`). Works with inputs, textareas, contentEditable, React controlled components, Lexical, and Slate.

**Parameters:**
- `text` (optional): Text to type (required unless using `fields`)
- `selector_type` (optional): `"ref"`, `"id"`, `"class"`, `"css"`, `"tag"`, `"text"`
- `selector_value` (optional): Selector value
- `fields` (optional): Array of `{ ref | selector_type + selector_value, value, clear }` for bulk form fill
- `submit_ref` (optional): Ref of a submit button to click after filling all fields
- `window_label` (optional): Target window (default: `"main"`)
- `delay_ms`, `initial_delay_ms` (optional): Typing delays

**Returns:** Confirmation with the target element info

### `mouse_action`

Non-click mouse actions.

**Parameters:**
- `action` (required): `"hover"`, `"scroll"`, or `"drag"`
- Hover/drag: `x`, `y`, `relative`, `end_x`, `end_y`
- Scroll: `direction` (`"up"`/`"down"`), `amount` (pixels, `"page"`, `"half"`), `to_ref`, `to_top`, `to_bottom`
- `window_label` (optional): Target window (default: `"main"`)

**Returns:** Confirmation message

### `navigate`

Controls webview navigation.

**Parameters:**
- `action` (required): `"goto"`, `"back"`, `"forward"`, `"reload"`
- `url` (optional): URL for `"goto"`
- `delta` (optional): History steps for `"back"`/`"forward"`
- `window_label` (optional): Target window (default: `"main"`)

**Returns:** Navigation result

### `execute_js`

Executes arbitrary JavaScript in a webview. The universal escape hatch.

**Parameters:**
- `code` (required): JavaScript code to execute
- `window_label` (optional): Target window (default: `"main"`)
- `timeout_ms` (optional): Maximum execution time in milliseconds (max: 300000)

**Returns:** The result of the last statement or promise resolution, serialized as a string

### `manage_storage`

Manages browser storage (localStorage and cookies).

**Parameters:**
- `store` (required): `"local_storage"` or `"cookies"`
- `action` (required): For `local_storage`: `"get"`, `"set"`, `"remove"`, `"clear"`, `"keys"`. For `cookies`: `"get_all"`, `"get_for_url"`, `"clear_all"` (clears ALL browsing data — cookies, cache, and localStorage — not just cookies)
- `key`, `value` (optional): For localStorage get/set/remove
- `url` (optional): For `"get_for_url"`
- `window_label` (optional): Target window (default: `"main"`)

**Returns:** Operation result

### `manage_window`

Manages windows, zoom, devtools, and webview state.

**Parameters:**
- `action` (required): Window ops (`"list"`, `"focus"`, `"minimize"`, `"maximize"`, `"unmaximize"`, `"close"`, `"show"`, `"hide"`, `"set_position"`, `"set_size"`, `"center"`, `"toggle_fullscreen"`), zoom (`"set_zoom"`, `"get_zoom"`), devtools (`"open_devtools"`, `"close_devtools"`, `"is_devtools_open"`), webview state (`"clear_browsing_data"`, `"set_background_color"`, `"get_bounds"`, `"set_auto_resize"`)
- `window_label` (optional): Target window (default: `"main"`)
- Action-specific: `x`, `y` (set_position), `width`, `height` (set_size), `scale` (set_zoom), `r`/`g`/`b`/`a` (set_background_color), `enabled` (set_auto_resize)

**Returns:** Operation result

### `wait_for`

Waits for a condition: text appearing/disappearing, or an element becoming visible/hidden/attached/detached. Provide exactly one of `text`, `selector`, or `ref`.

**Parameters:**
- `text` (optional): Text to wait for
- `selector` (optional): CSS selector of the element to wait for
- `ref` (optional): Element ref from `query_page` map mode
- `state` (optional): `"visible"`, `"hidden"`, `"attached"`, `"detached"` (default: `"visible"`)
- `timeout_ms` (optional): Maximum wait in milliseconds (default: 10000, max: 300000)
- `window_label` (optional): Target window (default: `"main"`)

**Returns:** Wait result

### `restart_app`

Restarts the Tauri application and waits for it to come back online. Force-kills the app if it is frozen (IPC mode only). Destructive — all in-memory state is lost. If `TAURI_DEV_URL` is set, the WebView is navigated there after restart.

**Parameters:**
- `delay_ms` (optional): Delay before restart, 100-5000 ms (default: 500)

**Returns:** Restart confirmation

### `query_logs`

Queries buffered logs from the Tauri app (Rust `log!()` output and webview `console.*` calls).

**Parameters:**
- `mode` (optional): `"summary"` (counts + recent warnings/errors) or `"tail"` (matching entries; default)
- `level` (optional): Minimum severity — `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"`
- `source` (optional): `"rust"` or `"js"`
- `contains` (optional): Case-insensitive substring filter
- `since_id`, `since_ms` (optional): Pagination/time cursors
- `limit` (optional): Max entries, 1-1000 (default: 100)
- `head` (optional): Return oldest instead of most recent (default: false)
- `format` (optional): `"compact"` or `"json"` (default: `"compact"`)
- `between` (optional): Marker tag — return entries between the two most recent `log_mark` calls with this id
- `include_markers` (optional): Include marker entries in the result (default: false)

**Returns:** Formatted log entries or summary

### `log_mark`

Inserts a marker into the log buffer. Call once before an action and once after with the same `id`, then use `query_logs` with `between` to see exactly the logs produced in between.

**Parameters:**
- `id` (required): Marker tag (reuse the same id for the begin/end pair)
- `note` (optional): Free-form description attached to the marker

**Returns:** Confirmation with the marker entry id

## Setup and Usage

1. Ensure the Tauri application is running with the socket server active
2. Start this MCP server
3. Connect your MCP client to this server
4. Use the tools to interact with the Tauri application

By default the server connects to the Tauri socket at `/tmp/tauri-mcp.sock` (Unix) or the `tauri-mcp.sock` named pipe on Windows. Configuration via environment variables:

- `TAURI_MCP_IPC_PATH` — custom Unix socket path
- `TAURI_MCP_CONNECTION_TYPE=tcp` with `TAURI_MCP_TCP_HOST` / `TAURI_MCP_TCP_PORT` — TCP mode
- `TAURI_MCP_AUTH_TOKEN` — auth token (otherwise read from the socket's `.token` file)
- `TAURI_DEV_URL` — dev-server URL used by `restart_app` to reload the WebView after a restart

## Error Handling

All tools follow the MCP error reporting convention:
- If a tool succeeds, it returns a result object with `content`
- If a tool fails, it returns an object with `isError: true` and an error message in `content`

## Example

Using the `take_screenshot` tool from an MCP client:

```json
{
  "name": "take_screenshot",
  "arguments": {
    "window_label": "main",
    "quality": 90,
    "max_width": 1920
  }
}
```

The response will include the saved file path plus a thumbnail (or full base64 image data with `inline: true`).
