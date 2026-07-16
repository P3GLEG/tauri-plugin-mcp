import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

function formatTs(ts: number): string {
  try {
    return new Date(ts).toISOString().slice(11, 23); // HH:MM:SS.mmm
  } catch {
    return String(ts);
  }
}

function formatCapturedEntries(data: any): string {
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (entries.length === 0) {
    return "No captured IPC activity matched. The buffer fills as the frontend calls invoke() — interact with the app first, or loosen filters.";
  }
  const lines = entries.map((e: any) => {
    const dur = e.duration_ms !== undefined ? ` ${e.duration_ms}ms` : "";
    const args = e.args_preview ? ` args=${e.args_preview}` : "";
    const outcome = e.status === "error"
      ? ` ERROR: ${e.error || "unknown"}`
      : (e.result_preview ? ` → ${e.result_preview}` : "");
    return `#${e.id} ${formatTs(e.ts)} [${e.kind}] ${e.name} ${e.status}${dur}${args}${outcome}`;
  });
  let header = `${data.returned} of ${data.total_matched} matched entries (newest last)`;
  if (data.dropped_total > 0) header += `; ${data.dropped_total} oldest entries evicted from buffer`;
  return `${header}\n${lines.join("\n")}`;
}

function formatCommandStats(data: any): string {
  const observed = Array.isArray(data.observed) ? data.observed : [];
  const declared = Array.isArray(data.declared) ? data.declared : [];
  const parts: string[] = [];
  if (observed.length > 0) {
    parts.push("Observed commands (from captured invoke() traffic):");
    for (const s of observed) {
      const avg = s.avg_duration_ms !== undefined ? `, avg ${s.avg_duration_ms}ms` : "";
      const errs = s.errors > 0 ? `, ${s.errors} errors` : "";
      parts.push(`  ${s.name} — ${s.count} calls${errs}${avg}, last: ${s.last_status}`);
    }
  } else {
    parts.push("No commands observed yet — the capture buffer fills as the frontend calls invoke().");
  }
  if (declared.length > 0) {
    parts.push(`Declared via PluginConfig::expose_commands: ${declared.join(", ")}`);
  }
  if (data.note) parts.push(`Note: ${data.note}`);
  return parts.join("\n");
}

export function registerManageIpcTool(server: McpServer) {
  server.tool(
    "manage_ipc",
    "Tauri IPC layer access — invoke backend commands and observe webview↔Rust traffic. Actions: 'invoke' calls a #[tauri::command] with JSON args through the app's real IPC path and returns the result (great for bisecting bugs into frontend vs Rust). 'captured' lists recorded invoke() calls and events with name/status/duration filters. 'commands' aggregates per-command stats (call counts, error rates, latency) plus any commands the app declared. 'emit' fires a Tauri event into the app. 'wait_event' blocks until a named event fires (assert 'saving emits user-updated'). 'clear' empties the capture buffer.",
    {
      action: z.enum(["invoke", "captured", "commands", "clear", "emit", "wait_event"]).describe("IPC operation to perform."),
      command: z.string().optional().describe("(invoke) Command name, e.g. 'get_user' or 'plugin:dialog|open'."),
      args: z.record(z.unknown()).optional().describe("(invoke) Arguments object passed to the command. Keys should match the command's parameter names (camelCase as the frontend would send them)."),
      event: z.string().optional().describe("(emit/wait_event) Event name."),
      payload: z.unknown().optional().describe("(emit) JSON payload for the emitted event."),
      kind: z.enum(["invoke", "event"]).optional().describe("(captured) Filter by entry kind."),
      name_contains: z.string().optional().describe("(captured) Case-insensitive substring filter on command/event name."),
      status: z.enum(["ok", "error", "emitted", "received"]).optional().describe("(captured) Filter by outcome. Tip: status='error' shows only failed invokes."),
      since_id: z.number().int().optional().describe("(captured) Only entries with id greater than this — use the last seen id as a cursor."),
      limit: z.number().int().min(1).max(500).default(50).describe("(captured) Max entries to return (newest kept). Default 50."),
      timeout_ms: z.number().int().positive().optional().describe("(invoke/wait_event) Timeout in ms. Default 10000."),
      window_label: z.string().default("main").describe("Target window for invoke (and emit, when set). Defaults to 'main'."),
    },
    {
      title: "Manage Tauri IPC",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params) => {
      try {
        if (params.action === "invoke" && !params.command) {
          return createErrorResponse("'command' is required for action=invoke");
        }
        if ((params.action === "emit" || params.action === "wait_event") && !params.event) {
          return createErrorResponse(`'event' is required for action=${params.action}`);
        }

        const payload: Record<string, unknown> = { action: params.action, window_label: params.window_label };
        if (params.command !== undefined) payload.command = params.command;
        if (params.args !== undefined) payload.args = params.args;
        if (params.event !== undefined) payload.event = params.event;
        if (params.payload !== undefined) payload.payload = params.payload;
        if (params.kind !== undefined) payload.kind = params.kind;
        if (params.name_contains !== undefined) payload.name_contains = params.name_contains;
        if (params.status !== undefined) payload.status = params.status;
        if (params.since_id !== undefined) payload.since_id = params.since_id;
        if (params.limit !== undefined) payload.limit = params.limit;
        if (params.timeout_ms !== undefined) payload.timeout_ms = params.timeout_ms;

        logCommandParams('manage_ipc', payload);
        const timeoutMs = (params.timeout_ms ?? 10000) + 5000;
        const result = await socketClient.sendCommand('manage_ipc', payload, timeoutMs);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response from manage_ipc');
        }
        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || `manage_ipc ${params.action} failed`);
        }

        const data = (result as any).data ?? {};
        switch (params.action) {
          case "invoke": {
            const trunc = data.truncated ? " [result truncated at 30000 chars]" : "";
            const dur = data.durationMs !== undefined ? ` (${data.durationMs}ms)` : "";
            return createSuccessResponse(`invoke("${params.command}") succeeded${dur}${trunc}:\n${data.result ?? "null"}`);
          }
          case "captured":
            return createSuccessResponse(formatCapturedEntries(data));
          case "commands":
            return createSuccessResponse(formatCommandStats(data));
          case "clear":
            return createSuccessResponse(`Cleared ${data.cleared ?? 0} captured IPC entries`);
          case "emit":
            return createSuccessResponse(`Emitted event '${params.event}'${params.window_label ? ` to window '${params.window_label}'` : ""}`);
          case "wait_event":
            if (data.received === false) {
              return createSuccessResponse(`Event '${params.event}' did NOT fire within ${data.timed_out_after_ms}ms`);
            }
            return createSuccessResponse(`Event '${params.event}' fired. Payload: ${JSON.stringify(data.payload)}`);
          default:
            return createSuccessResponse(JSON.stringify(data, null, 2));
        }
      } catch (error) {
        console.error('manage_ipc error:', error);
        return createErrorResponse(`manage_ipc failed: ${(error as Error).message}`);
      }
    },
  );
}
