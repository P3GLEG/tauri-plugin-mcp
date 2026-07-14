import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerManageStorageTool(server: McpServer) {
  server.tool(
    "manage_storage",
    "Manages browser storage. For localStorage: get/set/remove items, clear all, or list keys. For cookies: get all cookies, get cookies for a URL, or clear all browsing data (nuclear — clears cookies, cache, and localStorage).",
    {
      store: z.enum(["local_storage", "cookies"]).describe("Which storage to manage."),
      action: z.enum(["get", "set", "remove", "clear", "keys", "get_all", "get_for_url", "clear_all"])
        .describe("Action to perform. Valid for store='local_storage': 'get', 'set', 'remove', 'clear', 'keys'. Valid for store='cookies': 'get_all', 'get_for_url', 'clear_all'. Note: 'clear_all' clears ALL browsing data (cookies, cache, AND localStorage), not just cookies."),
      key: z.string().optional().describe("(local_storage) Key name. Required for get/set/remove."),
      value: z.string().optional().describe("(local_storage) Value to store. Required for 'set'."),
      url: z.string().optional().describe("(cookies) URL to get cookies for. Required for 'get_for_url'."),
      window_label: z.string().default("main").describe("Target window. Defaults to 'main'."),
    },
    {
      title: "Manage Browser Storage",
      readOnlyHint: false,
      destructiveHint: true,
      // Not idempotent: 'set' overwrites values and 'clear_all' wipes all browsing data
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params) => {
      try {
        const { store, action, window_label } = params;

        if (store === "local_storage") {
          // Validate local_storage actions
          const validActions = ["get", "set", "remove", "clear", "keys"];
          if (!validActions.includes(action)) {
            return createErrorResponse(`Invalid action '${action}' for local_storage. Valid: ${validActions.join(', ')}`);
          }

          // Validate key requirements
          if ((action === 'set' || action === 'remove') && !params.key) {
            return createErrorResponse(`'key' is required for the '${action}' action`);
          }
          if (action === 'set' && params.value === undefined) {
            return createErrorResponse("'value' is required for the 'set' action");
          }

          const payload: Record<string, unknown> = {
            action,
            key: params.key,
            value: params.value,
            window_label,
          };

          logCommandParams('manage_local_storage', payload);
          const result = await socketClient.sendCommand('manage_local_storage', payload);

          // Format result
          let resultText;
          if (typeof result === 'string') {
            resultText = result;
          } else if (Array.isArray(result)) {
            resultText = JSON.stringify(result);
          } else if (result === null || result === undefined) {
            resultText = String(result);
          } else {
            resultText = JSON.stringify(result, null, 2);
          }

          return createSuccessResponse(resultText);
        }

        if (store === "cookies") {
          const validActions = ["get_all", "get_for_url", "clear_all"];
          if (!validActions.includes(action)) {
            return createErrorResponse(`Invalid action '${action}' for cookies. Valid: ${validActions.join(', ')}`);
          }

          const payload: Record<string, unknown> = { action, window_label };
          if (params.url) payload.url = params.url;

          logCommandParams('manage_cookies', payload);
          const result = await socketClient.sendCommand('manage_cookies', payload);

          if (!result || typeof result !== 'object') {
            return createErrorResponse('Failed to get a valid response');
          }
          if ('success' in result && !result.success) {
            return createErrorResponse(result.error as string || 'manage_cookies failed');
          }

          const data = result.data ?? result;
          return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        }

        // Should be unreachable due to zod enum
        return createErrorResponse(`Unknown store: ${store}`);
      } catch (error) {
        console.error('manage_storage error:', error);
        return createErrorResponse(`Failed to manage storage: ${(error as Error).message}`);
      }
    },
  );
}
