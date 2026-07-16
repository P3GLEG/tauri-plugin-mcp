import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerPressKeyTool(server: McpServer) {
  server.tool(
    "press_key",
    "Presses a keyboard key (with optional modifiers) in the webview. Use for keys type_text cannot express: Escape, Enter, Tab, arrow keys, Backspace, Delete, Home/End, PageUp/PageDown, F1-F12, or modifier chords like cmd+a. Targets the focused element by default, or provide a selector to focus an element first. Dispatches synthetic keydown/keyup events and emulates the default action (text insertion, Enter submits forms/activates buttons, Tab moves focus, Backspace/Delete edit text) unless the app calls preventDefault. Note: OS-level shortcuts (app menus, global shortcuts) are not triggered — these are in-page events only.",
    {
      key: z.string().describe("Key to press: a DOM key name ('Escape', 'Enter', 'Tab', 'ArrowDown', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'F1'-'F12') or a single character ('a', '1', '/')."),
      modifiers: z.array(z.enum(["ctrl", "cmd", "shift", "alt"])).optional().describe("Modifier keys held during the press. 'cmd' maps to metaKey, 'ctrl' to ctrlKey."),
      repeat: z.number().int().min(1).max(100).default(1).describe("Number of times to press the key (e.g. ArrowDown x3). Default 1."),
      selector_type: z.enum(["ref", "id", "class", "css", "tag", "text"]).optional().describe("Optional: selector type to focus a target element before pressing. 'ref' uses numbered refs from query_page map mode."),
      selector_value: z.string().optional().describe("Selector value. For 'ref', provide the ref number as string."),
      window_label: z.string().default("main").describe("Target window. Defaults to 'main'."),
    },
    {
      title: "Press Keyboard Key",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params) => {
      try {
        if ((params.selector_type && !params.selector_value) || (!params.selector_type && params.selector_value)) {
          return createErrorResponse("selector_type and selector_value must be provided together");
        }

        const payload: Record<string, unknown> = {
          key: params.key,
          repeat: params.repeat,
          window_label: params.window_label,
        };
        if (params.modifiers && params.modifiers.length > 0) payload.modifiers = params.modifiers;
        if (params.selector_type) {
          payload.selector_type = params.selector_type;
          payload.selector_value = params.selector_value;
        }

        logCommandParams('press_key', payload);
        const result = await socketClient.sendCommand('press_key', payload);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response from press_key');
        }
        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'press_key failed');
        }

        // sendCommand resolves with the response's `data` field directly
        const data = (result as any).data ?? result;
        const mods = params.modifiers?.length ? `${params.modifiers.join('+')}+` : '';
        const times = params.repeat > 1 ? ` x${params.repeat}` : '';
        const target = data.target ? ` (focus: <${data.target.tag}${data.target.id ? ` #${data.target.id}` : ''}>)` : '';
        const prevented = data.defaultPrevented ? ' — app handler called preventDefault' : '';
        return createSuccessResponse(`Pressed ${mods}${params.key}${times}${target}${prevented}`);
      } catch (error) {
        console.error('press_key error:', error);
        return createErrorResponse(`Failed to press key: ${(error as Error).message}`);
      }
    },
  );
}
