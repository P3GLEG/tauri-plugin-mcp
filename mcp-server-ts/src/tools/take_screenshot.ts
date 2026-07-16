import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import {
  createErrorResponse,
  createImageResponse,
  createAnnotatedImageResponse,
  createEmbeddedResourceResponse,
  extractBase64Data,
  extractFilePath,
  logCommandParams,
} from "./response-helpers.js";

export function registerTakeScreenshotTool(server: McpServer) {
  server.tool(
    "take_screenshot",
    "Captures a screenshot of an application window. By default saves the full image to disk and returns a small thumbnail inline (optimized for token efficiency). Set inline=true to get the full image as base64 instead. Read-only, does not modify application state. WARNING: Screenshot pixel coordinates do NOT match the CSS pixel coordinates used by click/hover/type_text tools. Do NOT visually estimate click targets from screenshots. Instead, use query_page with mode='find_element' to get accurate coordinates for clicking.",
    {
      window_label: z.string().default("main").describe("Window to capture. Defaults to 'main'."),
      quality: z.number().min(1).max(100).optional().describe("JPEG quality (1-100). Lower values produce smaller images. Default: 70."),
      max_width: z.number().min(100).optional().describe("Maximum image width in pixels. Images wider than this will be resized. Default: 1024."),
      max_size_mb: z.number().min(0.1).optional().describe("Maximum file size in MB. Image will be compressed to fit. Default: 1.0."),
      output_dir: z.string().optional().describe("Directory to save screenshot file to. Defaults to system temp directory."),
      inline: z.boolean().optional().describe("If true, return full-resolution base64 image inline instead of saving to disk. Default: false (saves to disk with small thumbnail)."),
      audience: z.enum(["user", "assistant", "both"]).optional().describe("Hint for who should consume the image. 'user' = low priority for model, 'assistant' = high priority for model, 'both' = default behavior."),
    },
    {
      title: "Capture Screenshot of a Specific Application Window",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ window_label, quality, max_width, max_size_mb, output_dir, inline, audience }) => {
      try {
        if (!window_label) {
          window_label = "main";
        }

        // Default behavior: save to disk + thumbnail.
        // Only go full inline if explicitly requested.
        const wantInline = inline === true;
        const save_to_disk = !wantInline;
        const thumbnail = !wantInline;

        const params: Record<string, any> = { window_label, save_to_disk, thumbnail };
        if (quality !== undefined) params.quality = quality;
        if (max_width !== undefined) params.max_width = max_width;
        if (max_size_mb !== undefined) params.max_size_mb = max_size_mb;
        if (output_dir !== undefined) params.output_dir = output_dir;
        logCommandParams('take_screenshot', params);
        
        const result = await socketClient.sendCommand('take_screenshot', params);

        console.error(`Got screenshot result type: ${typeof result}`);

        const base64Data = extractBase64Data(result);
        const filePath = extractFilePath(result);
        const visibilityWarning: string | undefined =
          result && typeof result === 'object' ? (result as any).warning : undefined;

        // Determine audience annotations
        const annotations = audience === "user"
          ? { audience: ["user" as const], priority: 0.3 }
          : audience === "assistant"
          ? { audience: ["assistant" as const], priority: 0.9 }
          : undefined;

        // Combo mode: both thumbnail data AND file path
        if (base64Data && filePath) {
          // Use caller-provided annotations, or default to assistant-focused for thumbnail
          const thumbAnnotations = annotations ?? { audience: ["assistant" as const], priority: 0.9 };
          const content: any[] = [];
          // Inline thumbnail
          content.push({
            type: "image" as const,
            data: base64Data,
            mimeType: "image/jpeg",
            annotations: thumbAnnotations,
          });
          // Resource link to full image for the user
          content.push(createEmbeddedResourceResponse(filePath).content[0]);
          // Text reference
          content.push({ type: "text" as const, text: `Full screenshot saved to: ${filePath}` });
          if (visibilityWarning) content.push({ type: "text" as const, text: `WARNING: ${visibilityWarning}` });
          return { isError: false, content };
        }

        // File-only mode: no inline data, just file path
        if (!base64Data && filePath) {
          const response = createEmbeddedResourceResponse(filePath);
          if (visibilityWarning) {
            (response.content as any[]).push({ type: "text" as const, text: `WARNING: ${visibilityWarning}` });
          }
          return response;
        }

        // Inline mode: base64 data, no file
        if (base64Data) {
          const response = annotations
            ? createAnnotatedImageResponse(base64Data, 'image/jpeg', annotations)
            : createImageResponse(base64Data, 'image/jpeg');
          if (visibilityWarning) {
            (response.content as any[]).push({ type: "text" as const, text: `WARNING: ${visibilityWarning}` });
          }
          return response;
        }

        console.error('Failed to extract base64 data from response:', JSON.stringify(result));
        return createErrorResponse(`Failed to extract image data from response: ${JSON.stringify(result).substring(0, 100)}...`);
      } catch (error) {
        console.error('Screenshot error:', error);
        return createErrorResponse(`Failed to take screenshot: ${(error as Error).message}`);
      }
    },
  );
} 