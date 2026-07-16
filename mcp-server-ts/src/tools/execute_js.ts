import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, formatResultAsText, logCommandParams } from "./response-helpers.js";

export function registerExecuteJsTool(server: McpServer) {
  server.tool(
    "execute_js",
    "Executes arbitrary JavaScript in a webview. Returns the completion value of the code (the last expression's value); promises are awaited and their resolved value returned. This is the universal escape hatch — use it for anything not covered by other tools. Note: `window.__TAURI__` only exists if the app enables `app.withGlobalTauri` — for Tauri events/commands prefer the manage_ipc tool, which works regardless. Caution: can modify page state.",
    {
      code: z.string().describe("JavaScript to execute in the webview. The last expression's value is returned (promises are awaited); the value must be JSON-serializable to round-trip — DOM nodes and functions come back as strings."),
      window_label: z.string().default("main").describe("Target window. Defaults to 'main'."),
      timeout_ms: z.number().int().positive().max(300000).optional().describe("Max execution time in milliseconds. Default: 5000. Max: 300000 (5 minutes). Raise this for code that awaits slow promises."),
    },
    {
      title: "Execute JavaScript Code in Specified Application Window",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ code, window_label, timeout_ms }) => {
      try {
        // Validate required parameters
        if (!code || code.trim() === '') {
          return createErrorResponse("The code parameter is required and cannot be empty");
        }
        
        const params = { code, window_label, timeout_ms };
        logCommandParams('execute_js', params);

        // Give the socket round-trip headroom beyond the JS execution timeout
        const socketTimeoutMs = timeout_ms !== undefined ? Math.max(30000, timeout_ms + 5000) : 30000;

        const result = await socketClient.sendCommand('execute_js', {
          code,
          window_label,
          timeout_ms
        }, socketTimeoutMs);
        
        console.error(`Got JS execution result type: ${typeof result}`);

        // The plugin returns { result: string, type: string } where `result`
        // is already the stringified value (JSON for objects). Emit it
        // directly — wrapping it in another JSON.stringify would force the
        // agent to parse twice.
        if (result && typeof result === 'object' && 'result' in result) {
          const { result: value, type } = result as { result: string; type?: string };
          return createSuccessResponse(`${value}\n(js type: ${type ?? 'unknown'})`);
        }
        return createSuccessResponse(formatResultAsText(result));
      } catch (error) {
        console.error('JS execution error:', error);
        return createErrorResponse(`Failed to execute JavaScript: ${(error as Error).message}`);
      }
    },
  );
} 