import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

// Extract x/y from get_element_position multi-format response
function extractCoordinates(result: any): { x: number; y: number } | null {
  // Direct top-level
  if ('x' in result && 'y' in result && typeof result.x === 'number') {
    return { x: result.x, y: result.y };
  }
  // Nested data
  if (result.data && 'x' in result.data && 'y' in result.data) {
    return { x: result.data.x, y: result.data.y };
  }
  // Success wrapper
  if (result.success === true && result.data) {
    return { x: result.data.x, y: result.data.y };
  }
  return null;
}

export function registerClickTool(server: McpServer) {
  server.tool(
    "click",
    "Clicks at a position in the webview. Provide x/y coordinates directly, or provide a selector (ref from query_page map mode, or id/class/tag/text) to auto-resolve coordinates. For selector-based clicks, this first finds the element then clicks its center. IMPORTANT: Do not guess x/y coordinates from screenshots — screenshot resolution differs from page CSS coordinates. Preferred workflow: (1) use query_page with mode='find_element' to get exact coordinates, then pass those here, or (2) use selector_type/selector_value to auto-resolve. Only use raw x/y with coordinates returned by find_element.",
    {
      x: z.number().optional().describe("X coordinate in CSS pixels. Required if no selector provided."),
      y: z.number().optional().describe("Y coordinate in CSS pixels. Required if no selector provided."),
      button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button. Default: 'left'."),
      click_type: z.enum(["single", "double"]).optional().describe("Click type. 'double' sends two rapid clicks. Default: 'single'."),
      selector_type: z.enum(["ref", "id", "class", "css", "tag", "text"]).optional().describe("Selector type to find element. 'ref' uses numbered ref from query_page map mode. 'css' accepts any CSS selector."),
      selector_value: z.string().optional().describe("Selector value. For 'ref', provide the ref number as string."),
      window_label: z.string().optional().describe("Target window. Defaults to 'main'."),
    },
    {
      title: "Click Element or Position",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params) => {
      try {
        let targetX = params.x;
        let targetY = params.y;
        const windowLabel = params.window_label;

        // If selector provided, click via the in-page synthetic pointer
        // sequence (pointerdown→mousedown→pointerup→mouseup→click) instead
        // of resolving coordinates and clicking natively. The JS path
        // targets the exact element, is unaffected by display scale
        // factors / window position, and works when the app window is not
        // frontmost. Native clicking remains for raw x/y and for
        // right/middle/double clicks, which the JS path can't express.
        const useJsClick = params.selector_type && params.selector_value
          && (params.button === undefined || params.button === "left")
          && params.click_type !== "double";

        if (params.selector_type && params.selector_value) {
          const findPayload = {
            selector_type: params.selector_type,
            selector_value: params.selector_value,
            window_label: windowLabel ?? "main",
            should_click: useJsClick,
          };
          logCommandParams('get_element_position', findPayload);
          const findResult = await socketClient.sendCommand('get_element_position', findPayload);

          if (!findResult || typeof findResult !== 'object') {
            return createErrorResponse('Failed to find element');
          }

          // Check for error in response
          if ('success' in findResult && !findResult.success) {
            return createErrorResponse(findResult.error || 'Failed to find element');
          }

          if (useJsClick) {
            const data = (findResult as any).data ?? findResult;
            const el = data.element || {};
            const clickResult = data.clickResult || {};
            if (clickResult.success === false) {
              return createErrorResponse(`Element found but click dispatch failed: ${clickResult.error || 'unknown'}`);
            }
            return createSuccessResponse(
              `Clicked <${(el.tag || 'element').toLowerCase()}${el.id ? ` id="${el.id}"` : ''}> via synthetic pointer events (resolved from ${params.selector_type}="${params.selector_value}")`
            );
          }

          const coords = extractCoordinates(findResult);
          if (!coords) {
            return createErrorResponse(`Could not extract coordinates from element response: ${JSON.stringify(findResult)}`);
          }
          targetX = Math.round(coords.x);
          targetY = Math.round(coords.y);
        }

        if (targetX === undefined || targetY === undefined) {
          return createErrorResponse("Either x/y coordinates or selector_type/selector_value must be provided");
        }

        const clickPayload: Record<string, unknown> = {
          x: Math.round(targetX),
          y: Math.round(targetY),
          click: true,
          button: params.button,
          window_label: windowLabel,
        };

        logCommandParams('simulate_mouse_movement', clickPayload);
        await socketClient.sendCommand('simulate_mouse_movement', clickPayload);

        // Double click: send a second click
        if (params.click_type === "double") {
          await socketClient.sendCommand('simulate_mouse_movement', clickPayload);
        }

        const selectorInfo = params.selector_type
          ? ` (resolved from ${params.selector_type}="${params.selector_value}")`
          : '';
        const doubleInfo = params.click_type === "double" ? " (double-click)" : "";
        return createSuccessResponse(
          `Clicked ${params.button || 'left'} button at (${targetX}, ${targetY})${selectorInfo}${doubleInfo}`
        );
      } catch (error) {
        console.error('click error:', error);
        return createErrorResponse(`Failed to click: ${(error as Error).message}`);
      }
    },
  );
}
