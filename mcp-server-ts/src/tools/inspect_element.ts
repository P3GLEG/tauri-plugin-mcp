import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerInspectElementTool(server: McpServer) {
  server.tool(
    "inspect_element",
    "Returns bounding rect, computed styles, classList and attributes for elements matching a CSS selector — use this for visual/layout QA instead of execute_js getComputedStyle/getBoundingClientRect snippets. Default style set covers layout + color basics; pass style_props for specific properties (any CSS property name).",
    {
      selector: z.string().describe("CSS selector for the element(s) to inspect."),
      all: z.boolean().optional().describe("Inspect all matches (up to limit). Default: false (first match only)."),
      limit: z.number().int().positive().max(50).optional().describe("Maximum elements when all=true. Default: 10."),
      style_props: z.array(z.string()).optional().describe("Computed style properties to return (e.g. ['padding-left','background-color']). Default: a standard layout/color set."),
      window_label: z.string().optional().describe("Target window. Defaults to 'main'."),
    },
    {
      title: "Inspect Element Geometry and Styles",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (params) => {
      try {
        const payload: Record<string, unknown> = {
          selector: params.selector,
          window_label: params.window_label ?? "main",
        };
        if (params.all !== undefined) payload.all = params.all;
        if (params.limit !== undefined) payload.limit = params.limit;
        if (params.style_props !== undefined) payload.style_props = params.style_props;

        logCommandParams('inspect_element', payload);
        const result = await socketClient.sendCommand('inspect_element', payload);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response');
        }
        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'inspect_element failed');
        }

        const data = result.data ?? result;
        return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('inspect_element error:', error);
        return createErrorResponse(`Failed to inspect element: ${(error as Error).message}`);
      }
    },
  );
}
