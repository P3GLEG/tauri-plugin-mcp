import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

// File upload limits: base64 payloads travel through the socket and the
// Tauri event system, so keep them bounded.
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MB per call

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
  ".json": "application/json", ".csv": "text/csv", ".xml": "application/xml",
  ".html": "text/html", ".zip": "application/zip",
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

function mimeForFile(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

// Parse send_text_to_element multi-format response
function parseSendTextResponse(result: any, text: string): ReturnType<typeof createSuccessResponse> | ReturnType<typeof createErrorResponse> {
  // Case 1: Direct element at top level
  if (result.element) {
    const elementInfo = result.element;
    return createSuccessResponse(
      `Successfully sent text to ${elementInfo.tag || ''} element${elementInfo.id ? ` with id "${elementInfo.id}"` : ''}.\nText: "${text}"`
    );
  }

  // Case 2: Success wrapper
  if ('success' in result) {
    if (result.success === true) {
      const data = result.data || {};
      const elementInfo = data.element || {};
      return createSuccessResponse(
        `Successfully sent text to ${elementInfo.tag || ''} element${elementInfo.id ? ` with id "${elementInfo.id}"` : ''}.\nText: "${text}"`
      );
    } else {
      return createErrorResponse(result.error || 'Failed to send text to element');
    }
  }

  // Case 3: Nested data.element
  if (result.data && result.data.element) {
    const elementInfo = result.data.element;
    return createSuccessResponse(
      `Successfully sent text to ${elementInfo.tag || ''} element${elementInfo.id ? ` with id "${elementInfo.id}"` : ''}.\nText: "${text}"`
    );
  }

  // Fallback
  return createErrorResponse(`Response format unexpected: ${JSON.stringify(result)}`);
}

export function registerTypeTextTool(server: McpServer) {
  server.tool(
    "type_text",
    "Types text into the page. Four modes: (1) Provide 'fields' array to fill multiple form fields at once (each by ref or selector). (2) Provide 'selector_type'+'selector_value' to target a specific element. (3) Provide only 'text' to type into the currently focused element. (4) Provide 'files' (absolute paths) + selector to attach files to an <input type=\"file\">. Supports inputs, textareas, <select> dropdowns (text selects the matching option by value or label), contentEditable, React controlled components, Lexical, and Slate editors.",
    {
      text: z.string().optional().describe("Text to type. Required unless using 'fields' mode."),
      // Selector-based targeting
      selector_type: z.enum(["ref", "id", "class", "css", "tag", "text"]).optional().describe("Selector type for targeting a specific element. 'ref' uses numbered reference from query_page map mode. 'css' accepts any CSS selector."),
      selector_value: z.string().optional().describe("Selector value. For 'ref', provide the ref number as string."),
      // Form fill mode
      fields: z.array(z.object({
        ref: z.number().int().optional().describe("Element ref from query_page map mode."),
        selector_type: z.enum(["id", "class", "css", "tag", "text"]).optional().describe("Selector type (when ref not provided)."),
        selector_value: z.string().optional().describe("Selector value (when ref not provided)."),
        value: z.string().describe("Value to enter into the field."),
        clear: z.boolean().default(true).describe("Clear field before entering text. Default: true."),
      })).optional().describe("Array of form fields to fill. Each needs either a ref or selector_type+selector_value."),
      submit_ref: z.number().int().optional().describe("(fields mode) Ref of submit button to click after filling all fields."),
      // File upload mode
      files: z.array(z.string()).optional().describe("Absolute paths of files to attach to an <input type=\"file\">. Requires selector_type/selector_value targeting the input (or a container holding it). Max 10MB per file, 25MB total."),
      // Common options
      window_label: z.string().default("main").describe("Target window. Defaults to 'main'."),
      delay_ms: z.number().int().nonnegative().optional().describe("Delay between keystrokes in ms. Default varies by mode."),
      initial_delay_ms: z.number().int().nonnegative().optional().describe("(focused mode) Initial delay before typing begins in ms."),
    },
    {
      title: "Type Text Into Page",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params) => {
      try {
        const { window_label } = params;

        // Mode 0: File upload (files array provided)
        if (params.files && params.files.length > 0) {
          if (!params.selector_type || !params.selector_value) {
            return createErrorResponse("'selector_type' and 'selector_value' are required in files mode to target the <input type=\"file\">");
          }

          const fileEntries: Array<{ name: string; mimeType: string; dataBase64: string }> = [];
          let totalBytes = 0;
          for (const filePath of params.files) {
            if (!path.isAbsolute(filePath)) {
              return createErrorResponse(`File path must be absolute: ${filePath}`);
            }
            let stat;
            try {
              stat = await fs.stat(filePath);
            } catch {
              return createErrorResponse(`File not found or unreadable: ${filePath}`);
            }
            if (!stat.isFile()) {
              return createErrorResponse(`Not a regular file: ${filePath}`);
            }
            if (stat.size > MAX_FILE_BYTES) {
              return createErrorResponse(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 10MB): ${filePath}`);
            }
            totalBytes += stat.size;
            if (totalBytes > MAX_TOTAL_BYTES) {
              return createErrorResponse(`Total upload size exceeds 25MB limit`);
            }
            const data = await fs.readFile(filePath);
            fileEntries.push({
              name: path.basename(filePath),
              mimeType: mimeForFile(filePath),
              dataBase64: data.toString("base64"),
            });
          }

          const payload = {
            selector_type: params.selector_type,
            selector_value: params.selector_value,
            files: fileEntries,
            window_label,
          };
          logCommandParams('set_file_input', { ...payload, files: fileEntries.map(f => f.name) });
          const result = await socketClient.sendCommand('set_file_input', payload, 60000);

          if (!result || typeof result !== 'object') {
            return createErrorResponse('Failed to get a valid response from set_file_input');
          }
          if ('success' in result && !result.success) {
            return createErrorResponse(result.error as string || 'set_file_input failed');
          }
          const data = (result as any).data ?? {};
          const names = Array.isArray(data.filesAttached) ? data.filesAttached.join(', ') : fileEntries.map(f => f.name).join(', ');
          return createSuccessResponse(`Attached ${fileEntries.length} file(s) to file input: ${names}`);
        }

        // Mode 1: Fill form (fields array provided)
        if (params.fields) {
          const payload: Record<string, unknown> = { window_label, fields: params.fields };
          if (params.submit_ref !== undefined) payload.submit_ref = params.submit_ref;

          logCommandParams('fill_form', payload);
          const result = await socketClient.sendCommand('fill_form', payload);

          if (!result || typeof result !== 'object') {
            return createErrorResponse('Failed to get a valid response');
          }
          if ('success' in result && !result.success) {
            return createErrorResponse(result.error as string || 'fill_form failed');
          }

          const data = result.data ?? result;
          return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        }

        // Mode 2: Send text to specific element (selector provided)
        if (params.selector_type && params.selector_value) {
          if (!params.text) {
            return createErrorResponse("'text' is required when using selector_type/selector_value");
          }

          const payload = {
            selector_type: params.selector_type,
            selector_value: params.selector_value,
            text: params.text,
            window_label,
            delay_ms: params.delay_ms ?? 20,
          };

          logCommandParams('send_text_to_element', payload);
          const result = await socketClient.sendCommand('send_text_to_element', payload);

          if (!result || typeof result !== 'object') {
            return createErrorResponse('Failed to get a valid response');
          }

          return parseSendTextResponse(result, params.text);
        }

        // Mode 3: Type into focused element (no selector, no fields)
        // Uses JS-based typing which works with Lexical, Slate, contentEditable, and standard inputs
        if (!params.text) {
          return createErrorResponse("'text' is required when not using fields or selector mode");
        }

        const payload: Record<string, unknown> = {
          text: params.text,
          window_label,
        };
        if (params.delay_ms !== undefined) payload.delay_ms = params.delay_ms;
        if (params.initial_delay_ms !== undefined) payload.initial_delay_ms = params.initial_delay_ms;

        logCommandParams('type_into_focused', payload);
        const result = await socketClient.sendCommand('type_into_focused', payload);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response from type_into_focused');
        }

        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'type_into_focused failed');
        }

        const data = (result as any).data ?? result;
        const elementInfo = data?.element || {};
        const strategy = elementInfo.strategy ? ` (strategy: ${elementInfo.strategy})` : '';
        return createSuccessResponse(
          `Successfully typed ${params.text.length} characters into focused ${elementInfo.tag || 'element'}${elementInfo.id ? ` #${elementInfo.id}` : ''}${strategy}`
        );
      } catch (error) {
        console.error('type_text error:', error);
        return createErrorResponse(`Failed to type text: ${(error as Error).message}`);
      }
    },
  );
}
