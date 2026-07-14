import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

// Helper function to format element info text (from get_element_position)
function formatElementInfo(element: any, position: { x: number, y: number }, clickInfo: string): string {
  return `Found ${element.tag || ''} element${element.id ? ` with id "${element.id}"` : ''}${element.classes ? ` and classes "${element.classes}"` : ''}.
Position (raw coordinates for mouse movement): x=${position.x}, y=${position.y}
${clickInfo}`;
}

// Helper to parse get_element_position multi-format response
function parseFindElementResponse(result: any): ReturnType<typeof createSuccessResponse> | ReturnType<typeof createErrorResponse> {
  // Case 1: Direct top-level format
  if (result.element && 'x' in result && 'y' in result) {
    const clickInfo = result.clicked ?
      (result.clickResult?.success ? "Element was clicked successfully." : "Click attempt failed.") : "";
    return createSuccessResponse(formatElementInfo(
      result.element,
      { x: result.x, y: result.y },
      clickInfo
    ));
  }

  // Case 2: Nested data format
  if (result.data) {
    const data = result.data;
    if (data.element && 'x' in data && 'y' in data) {
      const clickInfo = data.clicked ?
        (data.clickResult?.success ? "Element was clicked successfully." : "Click attempt failed.") : "";
      return createSuccessResponse(formatElementInfo(
        data.element,
        { x: data.x, y: data.y },
        clickInfo
      ));
    }
  }

  // Case 3: Success property format
  if ('success' in result) {
    if (result.success === true && result.data) {
      const data = result.data;
      const element = data.element || {};
      const clickInfo = data.clicked ?
        (data.clickResult?.success ? "Element was clicked successfully." : "Click attempt failed.") : "";
      return createSuccessResponse(formatElementInfo(
        element,
        { x: data.x, y: data.y },
        clickInfo
      ));
    } else if (!result.success) {
      return createErrorResponse(result.error || 'Failed to find element');
    }
  }

  // Fallback
  return createErrorResponse(`Element found, but response format unexpected. Response data: ${JSON.stringify(result)}`);
}

export function registerQueryPageTool(server: McpServer) {
  server.tool(
    "query_page",
    "Inspects the current page. Modes: 'map' returns a structured JSON map of elements with numbered refs (preferred). 'html' returns raw DOM HTML (large — use only when map is insufficient). 'state' returns lightweight metadata (URL, title, scroll, viewport). 'find_element' locates an element by ref/selector and returns its exact CSS pixel coordinates — this is the RECOMMENDED way to get click targets (do NOT estimate coordinates from screenshots). 'app_info' returns app name, version, OS, windows, and monitors.",
    {
      mode: z.enum(["html", "map", "state", "find_element", "app_info"]).describe("What to query. 'map' for structured element map with refs. 'html' for raw DOM. 'state' for URL/title/scroll. 'find_element' for element coordinates. 'app_info' for app environment."),
      window_label: z.string().default("main").describe("The window to query. Defaults to 'main'."),
      // map mode options
      include_content: z.boolean().optional().describe("(map) Include page text content. Default: true."),
      interactive_only: z.boolean().optional().describe("(map) Only return interactive elements. Default: false."),
      scope_selector: z.union([z.string(), z.array(z.string())]).optional().describe("(map) CSS selector(s) to limit scan scope."),
      max_depth: z.number().int().nonnegative().optional().describe("(map) Max DOM tree depth to recurse."),
      delta: z.boolean().optional().describe("(map) Return only changes since last call. Default: false."),
      wait_for_stable: z.boolean().optional().describe("(map) Wait for DOM mutations to settle before scanning. Default: false."),
      quiet_ms: z.number().int().nonnegative().optional().describe("(map) Milliseconds of mutation silence for stability. Default: 300."),
      max_wait_ms: z.number().int().nonnegative().optional().describe("(map) Max wait for DOM stability in ms. Default: 3000."),
      timeout_secs: z.number().int().positive().max(300).optional().describe("(map) Rust-side timeout in seconds. Default: 10. Max: 300 (5 minutes)."),
      include_metadata: z.boolean().optional().describe("(map) Include structured page metadata (JSON-LD, OpenGraph, description). Default: true."),
      // find_element mode options
      selector_type: z.enum(["ref", "id", "class", "css", "tag", "text"]).optional().describe("(find_element) Selector type. 'ref' uses numbered reference from map mode. 'css' accepts any CSS selector."),
      selector_value: z.string().optional().describe("(find_element) Selector value. For 'ref', the ref number as string."),
      should_click: z.boolean().optional().describe("(find_element) Click the element once found. Default: false."),
    },
    {
      title: "Query Page Content and Elements",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (params) => {
      const { mode, window_label } = params;

      try {
        switch (mode) {
          case "html": {
            logCommandParams('get_dom', { window_label });
            // get_dom expects a raw string payload, not an object
            const result = await socketClient.sendCommand('get_dom', window_label);

            let domContent;
            if (typeof result === 'string') {
              domContent = result;
            } else if (result && typeof result === 'object') {
              if (typeof result.data === 'string') {
                domContent = result.data;
              } else {
                domContent = JSON.stringify(result);
              }
            } else {
              domContent = String(result);
            }

            return createSuccessResponse(domContent);
          }

          case "map": {
            const payload: Record<string, unknown> = {
              window_label,
              include_content: params.include_content ?? true,
              interactive_only: params.interactive_only ?? false,
              delta: params.delta ?? false,
              wait_for_stable: params.wait_for_stable ?? false,
              include_metadata: params.include_metadata ?? true,
            };
            if (params.scope_selector !== undefined) payload.scope_selector = params.scope_selector;
            if (params.max_depth !== undefined) payload.max_depth = params.max_depth;
            if (params.quiet_ms !== undefined) payload.quiet_ms = params.quiet_ms;
            if (params.max_wait_ms !== undefined) payload.max_wait_ms = params.max_wait_ms;
            if (params.timeout_secs !== undefined) payload.timeout_secs = params.timeout_secs;

            logCommandParams('get_page_map', payload);
            // Give the socket round-trip headroom beyond the Rust-side timeout
            const socketTimeoutMs = params.timeout_secs !== undefined
              ? Math.max(30000, params.timeout_secs * 1000 + 5000)
              : 30000;
            const result = await socketClient.sendCommand('get_page_map', payload, socketTimeoutMs);

            if (!result || typeof result !== 'object') {
              return createErrorResponse('Failed to get a valid response');
            }
            if ('success' in result && !result.success) {
              return createErrorResponse(result.error as string || 'get_page_map failed');
            }

            const data = result.data ?? result;
            return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
          }

          case "state": {
            const payload = { window_label };
            logCommandParams('get_page_state', payload);
            const result = await socketClient.sendCommand('get_page_state', payload);

            if (!result || typeof result !== 'object') {
              return createErrorResponse('Failed to get a valid response');
            }
            if ('success' in result && !result.success) {
              return createErrorResponse(result.error as string || 'get_page_state failed');
            }

            const data = result.data ?? result;
            return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
          }

          case "find_element": {
            if (!params.selector_type || !params.selector_value) {
              return createErrorResponse("'selector_type' and 'selector_value' are required for find_element mode");
            }

            const payload = {
              selector_type: params.selector_type,
              selector_value: params.selector_value,
              window_label,
              should_click: params.should_click ?? false,
            };

            logCommandParams('get_element_position', payload);
            const result = await socketClient.sendCommand('get_element_position', payload);

            if (!result || typeof result !== 'object') {
              return createErrorResponse('Failed to get a valid response');
            }

            return parseFindElementResponse(result);
          }

          case "app_info": {
            logCommandParams('get_app_info', {});
            const result = await socketClient.sendCommand('get_app_info', {});

            if (!result || typeof result !== 'object') {
              return createErrorResponse('Failed to get a valid response');
            }
            if ('success' in result && !result.success) {
              return createErrorResponse(result.error as string || 'get_app_info failed');
            }

            const data = result.data ?? result;
            return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
          }

          default:
            return createErrorResponse(`Unknown mode: ${mode}`);
        }
      } catch (error) {
        console.error(`query_page (${mode}) error:`, error);
        return createErrorResponse(`Failed to query page (${mode}): ${(error as Error).message}`);
      }
    },
  );
}
