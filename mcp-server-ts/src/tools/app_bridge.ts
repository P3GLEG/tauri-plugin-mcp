import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerAppBridgeTool(server: McpServer) {
  server.tool(
    "app_bridge",
    "Calls helpers the host app registered via window.__MCP_BRIDGE__.register(name, fn, description) — the sanctioned way to read app state (store snapshots) or trigger app-level actions, instead of execute_js against app internals. ALWAYS run action='list' first to discover what the app exposes. Helpers may be async; results are JSON-serialized and truncated at max_chars.",
    {
      action: z.enum(["list", "call"]).describe("'list' enumerates registered helpers with descriptions. 'call' invokes one."),
      name: z.string().optional().describe("(call) Helper name from the list."),
      args: z.array(z.any()).optional().describe("(call) Positional arguments passed to the helper."),
      timeout_ms: z.number().int().positive().max(120000).optional().describe("(call) Max time for the helper to resolve. Default: 10000."),
      max_chars: z.number().int().positive().optional().describe("(call) Result size cap. Default: 20000."),
      window_label: z.string().optional().describe("Target window (each window has its own registry). Defaults to 'main'."),
    },
    {
      title: "Call App-Registered Helper",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params) => {
      try {
        const payload: Record<string, unknown> = {
          action: params.action,
          window_label: params.window_label ?? "main",
        };
        if (params.name !== undefined) payload.name = params.name;
        if (params.args !== undefined) payload.args = params.args;
        if (params.timeout_ms !== undefined) payload.timeout_ms = params.timeout_ms;
        if (params.max_chars !== undefined) payload.max_chars = params.max_chars;

        logCommandParams('app_bridge', payload);
        const socketTimeoutMs = Math.max(30000, (params.timeout_ms ?? 10000) + 5000);
        const result = await socketClient.sendCommand('app_bridge', payload, socketTimeoutMs);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response');
        }
        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'app_bridge failed');
        }

        const data = result.data ?? result;
        return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('app_bridge error:', error);
        return createErrorResponse(`Failed to call app bridge: ${(error as Error).message}`);
      }
    },
  );
}
