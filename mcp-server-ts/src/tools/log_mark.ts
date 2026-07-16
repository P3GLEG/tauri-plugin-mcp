import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerLogMarkTool(server: McpServer) {
  server.tool(
    "log_mark",
    "Insert a marker into the log buffer. Use to bracket an action: call once before the action, perform the action with other tools, then call again with the SAME id. Afterward, query_logs({ between: <id> }) returns exactly the logs produced between the two markers. If you only call it once, query_logs treats 'now' as the end — useful for 'show me everything since I started X'.",
    {
      id: z.string().min(1).max(128)
        .describe("Marker tag. Reuse the same id for the matching begin/end pair. Examples: 'click-submit', 'navigate-settings', 'type-search'."),
      note: z.string().max(512).optional()
        .describe("Optional free-form description attached to the marker entry (e.g. 'about to click Save')."),
    },
    {
      title: "Mark Log Position",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ id, note }) => {
      try {
        const payload: Record<string, unknown> = { id };
        if (note !== undefined) payload.note = note;
        logCommandParams("log_mark", payload);

        const result = await socketClient.sendCommand("log_mark", payload);
        const entryId = result && typeof result === "object" ? (result as any).entryId : undefined;
        const markerCount = result && typeof result === "object" ? (result as any).markerCount : undefined;
        const idSuffix = entryId != null ? ` (entry id ${entryId})` : "";
        // An even marker count means this call closed a begin/end pair.
        if (typeof markerCount === "number" && markerCount >= 2 && markerCount % 2 === 0) {
          return createSuccessResponse(
            `Marker '${id}' inserted${idSuffix} — bracket closed. ` +
              `Call query_logs({ between: '${id}' }) to see exactly what happened between the markers.`,
          );
        }
        return createSuccessResponse(
          `Marker '${id}' inserted${idSuffix}. ` +
            `Perform your action, then call log_mark again with id='${id}' to close the bracket, ` +
            `then query_logs({ between: '${id}' }) to see exactly what happened.`,
        );
      } catch (error) {
        return createErrorResponse(`log_mark failed: ${(error as Error).message}`);
      }
    },
  );
}
