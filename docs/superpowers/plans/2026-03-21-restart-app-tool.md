# restart_app MCP Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `restart_app` MCP tool that restarts the Tauri application and automatically reconnects the MCP server.

**Architecture:** The Rust plugin gets a new `restart_app` command that returns a success response immediately, then spawns a delayed task that calls `app.restart()`. The TypeScript MCP server gets a new tool that sends the command, waits for the app to come back, and confirms reconnection to the LLM.

**Tech Stack:** Rust (Tauri v2 core `AppHandle::restart()`), TypeScript (MCP SDK, Node.js net sockets)

**Spec:** `docs/superpowers/specs/2026-03-21-restart-app-tool-design.md`

---

### Task 1: Add the `RESTART_APP` command constant

**Files:**
- Modify: `src/shared/mod.rs:119-145`

- [ ] **Step 1: Add the constant**

In `src/shared/mod.rs`, add `RESTART_APP` to the `commands` module after line 144 (`TYPE_INTO_FOCUSED`):

```rust
    pub const TYPE_INTO_FOCUSED: &str = "type_into_focused";
    pub const RESTART_APP: &str = "restart_app";
```

- [ ] **Step 2: Run tests to verify no conflicts**

Run: `cargo test test_command_constants_are_unique -- --nocapture`
Expected: FAIL — the test expects 25 commands but `RESTART_APP` is not in the test array yet.

- [ ] **Step 3: Commit**

```bash
git add src/shared/mod.rs
git commit -m "feat: add RESTART_APP command constant"
```

---

### Task 2: Add `RestartAppRequest` model

**Files:**
- Modify: `src/models.rs`

- [ ] **Step 1: Add the request model**

Append to the end of `src/models.rs` (after line 157):

```rust
// Restart app request model
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartAppRequest {
    /// Delay in ms before restart (default 500, clamped to 100-5000)
    pub delay_ms: Option<u64>,
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: Success (no compilation errors).

- [ ] **Step 3: Commit**

```bash
git add src/models.rs
git commit -m "feat: add RestartAppRequest model"
```

---

### Task 3: Implement the Rust restart handler

**Files:**
- Create: `src/tools/restart_app.rs`

- [ ] **Step 1: Create the handler file**

Create `src/tools/restart_app.rs` with the following content:

```rust
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check`
Expected: Warning about unused module (not wired up yet), but no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/restart_app.rs
git commit -m "feat: implement restart_app Rust handler"
```

---

### Task 4: Wire the handler into the command router

**Files:**
- Modify: `src/tools/mod.rs:9-48` (module declarations and re-exports)
- Modify: `src/tools/mod.rs:64-104` (match arms)
- Modify: `src/tools/mod.rs:148-192` (test)

- [ ] **Step 1: Add module declaration and re-export**

In `src/tools/mod.rs`, add after line 25 (`pub mod zoom;`):

```rust
pub mod restart_app;
```

Add after line 48 (`pub use zoom::handle_manage_zoom;`):

```rust
pub use restart_app::handle_restart_app;
```

- [ ] **Step 2: Add the match arm**

In `src/tools/mod.rs`, add after the `TYPE_INTO_FOCUSED` match arm (line 97) and before the `_ =>` catch-all (line 98):

```rust
        commands::RESTART_APP => handle_restart_app(app, payload).await,
```

- [ ] **Step 3: Update the uniqueness test**

In `src/tools/mod.rs`, in the `test_command_constants_are_unique` test, add `commands::RESTART_APP` to the `all_commands` array after `commands::TYPE_INTO_FOCUSED` (line 179), and change the expected count on line 190 from `25` to `26`:

```rust
            commands::TYPE_INTO_FOCUSED,
            commands::RESTART_APP,
        ];
```

```rust
        assert_eq!(seen.len(), 26, "Expected 26 unique commands");
```

- [ ] **Step 4: Run tests**

Run: `cargo test -- --nocapture`
Expected: All tests pass, including `test_command_constants_are_unique` with 26 commands.

- [ ] **Step 5: Commit**

```bash
git add src/tools/mod.rs
git commit -m "feat: wire restart_app into command router"
```

---

### Task 5: Add `waitForReconnect` method to TypeScript socket client

**Files:**
- Modify: `mcp-server-ts/src/tools/client.ts:29-36` (class properties)
- Modify: `mcp-server-ts/src/tools/client.ts:141-155` (close handler)
- Modify: `mcp-server-ts/src/tools/client.ts:295` (before class closing brace)

- [ ] **Step 1: Add the `suppressAutoReconnect` property**

In `mcp-server-ts/src/tools/client.ts`, add after line 36 (`private authToken: string | undefined;`):

```typescript
  private suppressAutoReconnect = false;
```

- [ ] **Step 2: Guard the auto-reconnect in the close handler**

In `mcp-server-ts/src/tools/client.ts`, modify the `on('close')` handler (lines 141-155) to check the flag. Replace:

```typescript
      this.client!.on('close', () => {
        this.isConnected = false;
        console.error('Socket connection closed');

        // Try to reconnect if not too many attempts
        if (this.reconnectAttempts < 3) {
          this.reconnectAttempts++;
          console.error(`Socket closed. Attempting to reconnect in 2 seconds...`);
          setTimeout(() => {
            this.connect().catch(e => {
              console.error('Reconnection failed:', e);
            });
          }, 2000);
        }
      });
```

With:

```typescript
      this.client!.on('close', () => {
        this.isConnected = false;
        console.error('Socket connection closed');

        // Skip auto-reconnect if a managed reconnection (e.g. restart) is in progress
        if (this.suppressAutoReconnect) {
          console.error('Auto-reconnect suppressed (managed reconnection in progress)');
          return;
        }

        // Try to reconnect if not too many attempts
        if (this.reconnectAttempts < 3) {
          this.reconnectAttempts++;
          console.error(`Socket closed. Attempting to reconnect in 2 seconds...`);
          setTimeout(() => {
            this.connect().catch(e => {
              console.error('Reconnection failed:', e);
            });
          }, 2000);
        }
      });
```

- [ ] **Step 3: Add the `waitForReconnect` method**

Add the following method to the `TauriSocketClient` class, before the closing brace of the class (before line 296):

```typescript
  /**
   * Disconnects the current socket and polls for reconnection.
   * Used after intentional operations that kill the server (e.g. restart).
   * Suppresses the automatic reconnect handler to avoid races.
   */
  async waitForReconnect(maxAttempts: number = 15, delayMs: number = 2000): Promise<void> {
    // Suppress the auto-reconnect handler
    this.suppressAutoReconnect = true;

    // Reject all pending callbacks — the server is going away
    for (const [id, callback] of this.responseCallbacks.entries()) {
      callback.reject(new Error('Connection closed for restart'));
      this.responseCallbacks.delete(id);
    }

    // Tear down current socket
    if (this.client) {
      this.client.removeAllListeners();
      this.client.destroy();
      this.client = null;
    }
    this.isConnected = false;
    this.buffer = '';

    // Poll for reconnection
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      console.error(`Reconnect attempt ${attempt}/${maxAttempts}...`);
      try {
        this.reconnectAttempts = 0;
        await this.connect();
        console.error('Reconnected successfully after restart');
        this.suppressAutoReconnect = false;
        return;
      } catch (e) {
        console.error(`Reconnect attempt ${attempt} failed: ${(e as Error).message}`);
      }
    }

    // All attempts exhausted
    this.suppressAutoReconnect = false;
    throw new Error(`Failed to reconnect after ${maxAttempts} attempts (${maxAttempts * delayMs / 1000}s)`);
  }
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd mcp-server-ts && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add mcp-server-ts/src/tools/client.ts
git commit -m "feat: add waitForReconnect method to socket client"
```

---

### Task 6: Create the TypeScript `restart_app` MCP tool

**Files:**
- Create: `mcp-server-ts/src/tools/restart_app.ts`

- [ ] **Step 1: Create the tool file**

Create `mcp-server-ts/src/tools/restart_app.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerRestartAppTool(server: McpServer) {
  server.tool(
    "restart_app",
    "Restarts the Tauri application and waits for it to come back online. Use when the app is in a broken state, unresponsive, or needs a fresh start. This is a destructive operation — all in-memory state will be lost.",
    {
      delay_ms: z.number().int().min(100).max(5000).optional()
        .describe("Delay in milliseconds before the app restarts (default 500). Allows in-flight operations to complete."),
    },
    {
      title: "Restart Tauri Application",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ delay_ms }) => {
      try {
        const params = { delay_ms: delay_ms ?? 500 };
        logCommandParams('restart_app', params);

        // Send the restart command — the server will respond before restarting
        await socketClient.sendCommand('restart_app', { delay_ms: params.delay_ms });

        // The app is now shutting down. Wait for it to come back.
        console.error('Restart command acknowledged. Waiting for app to come back...');
        try {
          await socketClient.waitForReconnect(15, 2000);
        } catch (reconnectError) {
          return createErrorResponse(
            `Application was restarted but failed to reconnect within 30s. ` +
            `The app may still be starting up — try again shortly. ` +
            `Error: ${(reconnectError as Error).message}`
          );
        }

        // Verify the app is functional with a ping
        try {
          await socketClient.sendCommand('ping', { value: 'restart-health-check' });
        } catch (pingError) {
          return createErrorResponse(
            `Reconnected after restart but health check failed: ${(pingError as Error).message}`
          );
        }

        return createSuccessResponse('Application restarted and reconnected successfully.');
      } catch (error) {
        const message = (error as Error).message;
        if (message.includes('connect') || message.includes('ECONNREFUSED') || message.includes('ENOENT')) {
          return createErrorResponse(`Cannot restart: app is not connected. Error: ${message}`);
        }
        return createErrorResponse(`Failed to restart application: ${message}`);
      }
    },
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd mcp-server-ts && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add mcp-server-ts/src/tools/restart_app.ts
git commit -m "feat: create restart_app MCP tool"
```

---

### Task 7: Register the tool and final verification

**Files:**
- Modify: `mcp-server-ts/src/tools/index.ts:1-11` (imports)
- Modify: `mcp-server-ts/src/tools/index.ts:18-29` (registration)

- [ ] **Step 1: Add import**

In `mcp-server-ts/src/tools/index.ts`, add after line 11 (`import { registerWaitForTool } from "./wait_for.js";`):

```typescript
import { registerRestartAppTool } from "./restart_app.js";
```

- [ ] **Step 2: Register the tool**

In `mcp-server-ts/src/tools/index.ts`, add after line 28 (`registerWaitForTool(server);`):

```typescript
  registerRestartAppTool(server);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd mcp-server-ts && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Verify Rust compiles and tests pass**

Run: `cargo test -- --nocapture`
Expected: All tests pass (26 unique commands).

- [ ] **Step 5: Build the TypeScript MCP server**

Run: `cd mcp-server-ts && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add mcp-server-ts/src/tools/index.ts
git commit -m "feat: register restart_app tool in MCP server"
```
