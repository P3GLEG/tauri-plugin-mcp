import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerWaitForTool(server: McpServer) {
  server.tool(
    "wait_for",
    "Waits for a condition to be met before returning: text appearing/disappearing on the page, an element becoming visible/hidden, or an element being attached/detached from the DOM. Useful after actions that trigger async content loading (navigation, form submission, AJAX). Provide exactly one of: text, selector, or ref.",
    {
      window_label: z.string().default("main").describe("The window to observe. Defaults to 'main'."),
      text: z.string().optional().describe("Wait for this text to appear (or disappear if state='hidden') in the page body."),
      selector: z.string().optional().describe("CSS selector for the element to wait for."),
      ref: z.number().int().optional().describe("Ref number (from get_page_map) of the element to wait for."),
      state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible").describe("Condition to wait for. 'visible': element exists and is visible. 'hidden': element is hidden or text is absent. 'attached': element exists in DOM. 'detached': element removed from DOM."),
      timeout_ms: z.number().int().positive().max(300000).default(10000).describe("Maximum time to wait in milliseconds. Default: 10000 (10 seconds). Max: 300000 (5 minutes)."),
    },
    {
      title: "Wait For Condition",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ window_label, text, selector, ref, state, timeout_ms }) => {
      try {
        const payload: Record<string, unknown> = { window_label, state, timeout_ms };
        if (text !== undefined) payload.text = text;
        if (selector !== undefined) payload.selector = selector;
        if (ref !== undefined) payload.ref = ref;

        logCommandParams('wait_for', payload);

        // Give the socket round-trip headroom beyond the in-page wait timeout
        const socketTimeoutMs = Math.max(30000, timeout_ms + 5000);
        const result = await socketClient.sendCommand('wait_for', payload, socketTimeoutMs);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response');
        }

        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'wait_for failed');
        }

        const data = result.data ?? result;
        return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('wait_for error:', error);
        return createErrorResponse(`Failed to wait for condition: ${(error as Error).message}`);
      }
    },
  );
}
