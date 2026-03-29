# Design: `restart_app` MCP Tool

## Summary

Add a `restart_app` tool to tauri-plugin-mcp that allows AI agents to restart a Tauri application and automatically reconnect. No new dependencies required — Tauri core's `AppHandle::restart()` provides the restart primitive.

## Motivation

The plugin currently has no way to recover from a broken app state. If the webview is unresponsive or the app enters a bad state, an AI agent has no recourse. A restart tool closes this gap.

## Architecture

### Rust Side

**New command constant** (`src/shared/mod.rs`):
```rust
pub const RESTART_APP: &str = "restart_app";
```

**New model** (`src/models.rs`):
```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartAppRequest {
    pub delay_ms: Option<u64>, // default 500, clamped to 100-5000
}
```

No separate response model — the handler returns a `SocketResponse` directly with a message string in `data`, consistent with other simple handlers.

**New handler** (`src/tools/restart_app.rs`):
1. Parse `RestartAppRequest` from payload
2. Clamp `delay_ms` to range 100-5000ms (default 500ms)
3. Clone the `AppHandle`
4. Spawn a detached `tokio::spawn` that:
   - Sleeps for `delay_ms` to let the response flush over the socket
   - Calls `app.restart()`
5. Return a success `SocketResponse` immediately (before the restart fires), with `data: "Restarting application in {delay_ms}ms"`

**Router update** (`src/tools/mod.rs`):
- Add `commands::RESTART_APP => handle_restart_app(app, payload).await`
- Update `test_command_constants_are_unique` test: add `RESTART_APP` to the array and bump expected count to 26

### TypeScript MCP Server Side

**New tool** (`mcp-server-ts/src/tools/restart_app.ts`):
- Registers `restart_app` MCP tool
- Parameters:
  - `delay_ms` (optional number, default 500) — delay before restart (clamped 100-5000 on Rust side)
- Handler flow:
  1. Send `restart_app` command via `socketClient.sendCommand()`
  2. Expect the connection to drop after receiving the initial response
  3. Call `socketClient.waitForReconnect(15, 2000)` — dedicated reconnection loop
  4. On success: send a `ping` command to verify the app is functional, then return `"Application restarted successfully"` to the LLM
  5. On timeout: return error `"Application restarted but failed to reconnect within 30s"`
- MCP metadata: `destructiveHint: true`, `readOnlyHint: false`

**New method on `TauriSocketClient`** (`mcp-server-ts/src/tools/client.ts`):
- `async waitForReconnect(maxAttempts: number, delayMs: number): Promise<void>`
- Sets a `suppressAutoReconnect` flag to prevent the existing `on('close')` auto-reconnect handler from competing
- Rejects all pending `responseCallbacks` with a "restart in progress" error (cleans up any in-flight requests from other tools)
- Sets `isConnected = false` and destroys the current socket
- Polls `connect()` in a loop (maxAttempts times, delayMs apart)
- On success: resets `suppressAutoReconnect` flag and `reconnectAttempts` counter
- On failure: resets flags and throws

- Modify the existing `on('close')` handler to check `suppressAutoReconnect` before auto-reconnecting

**Tool registration** (`mcp-server-ts/src/tools/index.ts`):
- Add `registerRestartAppTool(server)` to `registerAllTools()`

## Error Handling

| Scenario | Behavior |
|----------|----------|
| App not connected when restart called | `sendCommand` fails; tool returns `"Cannot restart: app is not connected"` |
| `app.restart()` fails silently (macOS) | Reconnection loop times out after 30s; tool returns error |
| Multiple rapid restart calls | Second call fails to connect; returns error |
| Auth token changes after restart | `connect()` re-reads token file on each attempt |
| In-flight requests from other tools | `waitForReconnect` rejects all pending callbacks before starting reconnection loop |
| `delay_ms` out of range | Clamped to 100-5000ms on Rust side |

## Decisions

- **No `tauri-plugin-process` dependency**: `AppHandle::restart()` is in Tauri core. Adding a plugin dependency would force users to register it.
- **No macOS `std::process::Command` fallback**: Tauri's built-in `process::restart()` already handles `.app` bundle resolution. If it fails, the reconnection timeout surfaces the error.
- **Respond-then-restart pattern**: The Rust handler returns the socket response before triggering the restart via a delayed spawned task. This ensures the MCP server receives confirmation that the restart was intentional.
- **Dedicated reconnection loop with suppression**: The existing `client.ts` reconnection (3 retries, 6s) is insufficient for app restart. The restart tool uses its own loop (15 retries, 30s) and sets a `suppressAutoReconnect` flag to prevent the existing `on('close')` handler from competing.
- **Post-restart health check**: After reconnecting, a `ping` command verifies the app is actually functional, not just accepting socket connections.
- **No separate response model**: `SocketResponse` already has `success`, `data`, and `error` fields. A dedicated `RestartAppResponse` would duplicate structure with no benefit.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/shared/mod.rs` | Add `RESTART_APP` constant |
| `src/models.rs` | Add `RestartAppRequest` |
| `src/tools/restart_app.rs` | **New** — Rust handler |
| `src/tools/mod.rs` | Add module, route command, update test |
| `mcp-server-ts/src/tools/restart_app.ts` | **New** — MCP tool registration |
| `mcp-server-ts/src/tools/client.ts` | Add `waitForReconnect()`, `suppressAutoReconnect` flag |
| `mcp-server-ts/src/tools/index.ts` | Register new tool |
