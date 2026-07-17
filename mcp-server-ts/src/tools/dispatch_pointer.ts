import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerDispatchPointerTool(server: McpServer) {
  server.tool(
    "dispatch_pointer",
    "Dispatches a synthetic pointer/mouse gesture (full pointerdown→mousedown→pointerup→mouseup→click chains) on the EXACT element matched — no retargeting to interactive ancestors. Built for targets the click tool can't drive: canvas sub-regions (pass offset), modal backdrops, drag-and-drop, and hover states. Drag interpolates moves and also dispatches them on document (works with d3-drag; synthetic events bypass setPointerCapture). Events have isTrusted=false — handlers requiring trusted events won't fire; use mouse_action for native OS input.",
    {
      selector_type: z.enum(["css", "ref"]).optional().describe("How to find the element. Default: 'css'."),
      selector_value: z.string().describe("CSS selector, or the ref number (as string) from query_page map mode."),
      gesture: z.enum(["click", "dblclick", "down", "up", "hover", "drag"]).describe("Gesture to dispatch."),
      offset: z.object({ x: z.number(), y: z.number() }).optional().describe("Origin in px from the element's top-left corner. Default: element center. Essential for canvas hit-testing."),
      to: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        dx: z.number().optional(),
        dy: z.number().optional(),
      }).optional().describe("Drag destination: absolute viewport {x,y} OR relative {dx,dy} from the origin."),
      steps: z.number().int().positive().max(100).optional().describe("Interpolated move events for drag. Default: 8."),
      button: z.number().int().min(0).max(2).optional().describe("0=left, 1=middle, 2=right. Default: 0."),
      modifiers: z.array(z.enum(["shift", "ctrl", "alt", "meta"])).optional().describe("Modifier keys held during the gesture."),
      window_label: z.string().optional().describe("Target window. Defaults to 'main'."),
    },
    {
      title: "Dispatch Pointer Gesture",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params) => {
      try {
        const payload: Record<string, unknown> = {
          selector_value: params.selector_value,
          gesture: params.gesture,
          window_label: params.window_label ?? "main",
        };
        if (params.selector_type !== undefined) payload.selector_type = params.selector_type;
        if (params.offset !== undefined) payload.offset = params.offset;
        if (params.to !== undefined) payload.to = params.to;
        if (params.steps !== undefined) payload.steps = params.steps;
        if (params.button !== undefined) payload.button = params.button;
        if (params.modifiers !== undefined) payload.modifiers = params.modifiers;

        logCommandParams('dispatch_pointer', payload);
        const result = await socketClient.sendCommand('dispatch_pointer', payload);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response');
        }
        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'dispatch_pointer failed');
        }

        const data = result.data ?? result;
        return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('dispatch_pointer error:', error);
        return createErrorResponse(`Failed to dispatch pointer gesture: ${(error as Error).message}`);
      }
    },
  );
}
