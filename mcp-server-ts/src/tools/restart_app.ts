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
