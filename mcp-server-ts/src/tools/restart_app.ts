import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execSync } from "child_process";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

/**
 * Find the PID of the process listening on the MCP socket.
 * Uses `lsof` on macOS/Linux to find who owns the socket file.
 * Returns undefined if the process can't be found.
 */
function findSocketOwnerPid(socketPath: string): number | undefined {
  try {
    // lsof -U finds Unix domain socket listeners; grep for our socket path
    const output = execSync(`lsof -U 2>/dev/null | grep "${socketPath}" | head -1`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (!output) return undefined;
    // lsof output: COMMAND PID USER FD TYPE ...
    const parts = output.split(/\s+/);
    const pid = parseInt(parts[1], 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/**
 * Force-kill the Tauri app process when the graceful restart command can't
 * reach it (app is frozen/unresponsive). In dev mode, `cargo tauri dev`
 * will automatically relaunch the app after the process exits.
 */
function forceKillApp(socketPath: string): boolean {
  const pid = findSocketOwnerPid(socketPath);
  if (!pid) {
    console.error('Force kill: could not find socket owner PID');
    return false;
  }
  console.error(`Force kill: sending SIGKILL to PID ${pid}`);
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch (e) {
    console.error(`Force kill failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Race a promise against a timeout. Returns the promise result or throws on timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function registerRestartAppTool(server: McpServer) {
  server.tool(
    "restart_app",
    "Restarts the Tauri application and waits for it to come back online. Use when the app is in a broken state, unresponsive, or needs a fresh start. If the app is completely frozen, it will be force-killed. This is a destructive operation — all in-memory state will be lost.",
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
      const socketPath = process.env.TAURI_MCP_IPC_PATH || '/tmp/tauri-mcp.sock';
      let restartMethod = 'graceful';

      try {
        const params = { delay_ms: delay_ms ?? 500 };
        logCommandParams('restart_app', params);

        // Try graceful restart first (5s timeout — if app is frozen, this will fail)
        try {
          await withTimeout(
            socketClient.sendCommand('restart_app', { delay_ms: params.delay_ms }),
            5000,
            'Graceful restart command',
          );
          console.error('Restart command acknowledged. Waiting for app to come back...');
        } catch (gracefulError) {
          // Graceful restart failed — app is likely frozen. Force kill it.
          console.error(`Graceful restart failed: ${(gracefulError as Error).message}`);
          console.error('App appears frozen. Attempting force kill...');
          restartMethod = 'force-kill';

          const killed = forceKillApp(socketPath);
          if (!killed) {
            return createErrorResponse(
              'App is unresponsive and could not be force-killed. ' +
              'The socket owner process was not found. You may need to manually kill the app.'
            );
          }
          console.error('Force kill sent. Waiting for app to restart...');
        }

        // Wait for reconnection (dev mode auto-relaunches after process exit)
        try {
          await socketClient.waitForReconnect(30, 2000);
        } catch (reconnectError) {
          return createErrorResponse(
            `Application was ${restartMethod === 'force-kill' ? 'force-killed' : 'restarted'} ` +
            `but failed to reconnect within 60s. ` +
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

        // After restart, the WebView may be blank (IPC reconnects but frontend hasn't loaded).
        // Navigate to the app's root URL to ensure the frontend is rendered.
        const appUrl = process.env.TAURI_DEV_URL || 'http://localhost:1420/';
        console.error(`Navigating WebView to ${appUrl} to reload frontend...`);
        try {
          await socketClient.sendCommand('navigate_webview', {
            action: 'navigate',
            window_label: 'main',
            url: appUrl,
          });
          // Give the page time to load before the final health check
          await new Promise(resolve => setTimeout(resolve, 3000));
          await socketClient.sendCommand('ping', { value: 'post-navigate-health-check' });
        } catch (navError) {
          return createErrorResponse(
            `Reconnected after restart but failed to reload the WebView: ${(navError as Error).message}. ` +
            `Try manually: navigate goto ${appUrl}`
          );
        }

        const method = restartMethod === 'force-kill' ? ' (via force-kill)' : '';
        return createSuccessResponse(`Application restarted${method}, reconnected, and WebView reloaded successfully.`);
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
