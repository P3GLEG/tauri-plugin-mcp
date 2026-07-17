import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerReadTextTool(server: McpServer) {
  server.tool(
    "read_text",
    "Reads the visible text of elements matching a CSS selector — use this instead of execute_js querySelectorAll/innerText scraping. Returns per-element {tag, text, visible} plus requested attributes, with whitespace collapsed and output hard-capped (truncated flag set when clipped). Scope with scope_selector to keep results small. For element geometry/styles use inspect_element; for the full page structure use query_page(mode='map').",
    {
      selector: z.string().describe("CSS selector for the elements to read."),
      all: z.boolean().optional().describe("Read all matches (up to limit). false = first match only. Default: true."),
      limit: z.number().int().positive().max(200).optional().describe("Maximum elements to return when all=true. Default: 20."),
      attrs: z.array(z.string()).optional().describe("Attribute names to include per element (e.g. ['aria-label','href','data-testid'])."),
      max_chars: z.number().int().positive().optional().describe("Total character budget across all returned texts. Default: 4000."),
      scope_selector: z.string().optional().describe("CSS selector to limit the search scope to one container."),
      window_label: z.string().optional().describe("Target window. Defaults to 'main'."),
    },
    {
      title: "Read Element Text",
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
        if (params.attrs !== undefined) payload.attrs = params.attrs;
        if (params.max_chars !== undefined) payload.max_chars = params.max_chars;
        if (params.scope_selector !== undefined) payload.scope_selector = params.scope_selector;

        logCommandParams('read_text', payload);
        const result = await socketClient.sendCommand('read_text', payload);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response');
        }
        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'read_text failed');
        }

        const data = result.data ?? result;
        return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('read_text error:', error);
        return createErrorResponse(`Failed to read text: ${(error as Error).message}`);
      }
    },
  );
}
