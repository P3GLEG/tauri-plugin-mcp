# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Linux screenshot crash on windows with non-ASCII titles: bumped `xcap`
  0.0.4 → 0.9 and `image` 0.24 → 0.25 (JPEG encoding now converts RGBA → RGB,
  required by image 0.25). Ported from #22 — thanks @leiha.

## [0.2.0] - 2026-07-16

### ⚠️ Behavior changes (read before upgrading)

- **Dialog stubs are on by default.** `window.alert`/`confirm`/`prompt` are
  replaced with non-blocking stubs — native dialogs block the webview's JS
  thread and deadlock every MCP tool that round-trips through JS. `confirm()`
  auto-answers **false** (the safe default for a consent gate) and `prompt()`
  returns its default value; every intercepted dialog is recorded in the log
  buffer under target `"dialog"`. Opt out with `.stub_dialogs(false)` or
  override answers via `window.__TAURI_MCP_DIALOG_RESPONSES__ = { confirm: true }`.
- **`restart_app` refuses in dev mode.** Under `tauri dev`, restarting re-execs
  the binary outside the dev supervisor and orphans the app, so the command now
  returns an error with guidance instead. Use `navigate(action='reload')` to
  reload the frontend, or restart the dev command manually.
- **macOS native input fails loudly without Accessibility.** Native mouse/key
  injection previously reported success while events were silently dropped; it
  now returns an error telling you to grant Accessibility. Selector-based
  clicks are unaffected (they dispatch synthetic pointer events in-page), and
  `mouse_action` hover falls back to synthetic events automatically.
- **Selector-based clicks use synthetic pointer events** (`isTrusted=false`,
  may retarget to the nearest interactive ancestor) instead of native
  coordinate clicks. Right/middle/double and raw x/y clicks remain native.
- **`execute_js` returns real completion values**: indirect eval with
  completion-value semantics, promises are awaited, and bare object literals
  are evaluated as expressions. Output format is now `<value>\n(js type: <type>)`.
- **`manage_storage` stores values verbatim** — the old behavior JSON-parsed
  JSON-looking values and could corrupt them to `"[object Object]"`.
- **Fail-loud lookups**: `query_page` map mode errors when `scope_selector`
  matches nothing (previously scanned the whole page); `find_element` errors on
  detached refs and zero-size (hidden) elements.
- **`query_logs` hides plugin-internal chatter by default** — pass
  `include_plugin=true` to see socket tracing and JS bridge logs.
- **Rust API**: `PluginConfig`, `LogEntry`, `LogCounts`, and `IpcEntry` are now
  `#[non_exhaustive]` — construct `PluginConfig` via `PluginConfig::new()` and
  its builder methods.
- **MCP server lifecycle**: the Node server exits when its stdio client
  disconnects, so closed sessions no longer leave orphaned processes.

### Added

- `press_key` tool: synthetic key presses with modifier chords, repeat counts,
  optional selector targeting, and default-action emulation (Enter submits,
  Tab moves focus, Backspace/Delete edit).
- `wait_for` tool: wait for text/selector/ref to become visible, hidden,
  attached, or detached.
- `manage_ipc` tool: invoke any `#[tauri::command]` through the app's real IPC
  path, emit events, `arm_event` → act → `captured` assertions, `wait_event`,
  and per-command stats. Apps can self-report their own invoke traffic via the
  `push_ipc` command; such entries are labeled `[self-reported]` and treated
  as untrusted since any page script can forge them.
- `log_mark` tool: bracket an action with markers, then
  `query_logs({ between: id })` returns exactly the logs it produced.
- `type_text`: multi-field form-fill mode (with optional submit ref) and file
  attachment to `<input type="file">` (10 MB/file, 25 MB/call).
- `PluginConfig::expose_commands` to declare commands for `manage_ipc`
  discovery, and `PluginConfig::stub_dialogs` to control dialog stubbing.
- `take_screenshot` warns when the target window is hidden or occluded.

### Fixed

- Auth tokens are redacted from socket server logs; raw request lines only log
  at trace level.
- `restart_app` no longer force-kills an app that explicitly refuses to
  restart; force-kill is reserved for unreachable (frozen) processes.
- MCP tool responses no longer double-unwrap the socket payload (`press_key`
  focus/`preventDefault` feedback, `type_text` file-attach confirmation,
  `manage_ipc` results).
- File uploads decode base64 natively via `fetch(data:)` instead of a
  char-by-char loop that froze the UI at multi-MB sizes.
