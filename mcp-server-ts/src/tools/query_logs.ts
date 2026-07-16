import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

interface LogEntry {
  id: number;
  ts: number;
  level: string;
  source: "rust" | "js" | "marker";
  target?: string | null;
  message: string;
  /** Present when >1 — N consecutive identical messages were coalesced. */
  repeat?: number;
}

interface LogCounts {
  error: number; warn: number; info: number; debug: number; trace: number;
  rust: number; js: number; marker: number;
  /** Plugin-internal entries in the buffer (hidden unless include_plugin=true). */
  plugin?: number;
}

interface BetweenBounds { begin: number; end: number; }

interface TailResult {
  entries: LogEntry[];
  totalMatched: number;
  bufferSize: number;
  bufferCapacity: number;
  droppedTotal: number;
  nextCursor: number | null;
  counts: LogCounts;
  betweenBounds?: BetweenBounds;
}

interface SummaryResult {
  mode: "summary";
  bufferSize: number;
  bufferCapacity: number;
  droppedTotal: number;
  counts: LogCounts;
  recentWarningsAndErrors: LogEntry[];
}

function formatCompact(entry: LogEntry): string {
  const iso = new Date(entry.ts).toISOString().slice(11, 23); // HH:MM:SS.mmm
  const lvl = entry.level.toUpperCase().padEnd(5);
  const src = entry.source.toUpperCase().padEnd(6);
  const tgt = entry.target ? ` ${entry.target}` : "";
  const rep = entry.repeat && entry.repeat > 1 ? ` (×${entry.repeat})` : "";
  return `[${iso}][${lvl}][${src}]${tgt} ${entry.message}${rep}`;
}

function formatTail(r: TailResult, format: "compact" | "json"): string {
  const bracket = r.betweenBounds
    ? `# between markers: begin=${r.betweenBounds.begin} end=${r.betweenBounds.end}\n`
    : "";
  const header =
    `# logs: showing ${r.entries.length}/${r.totalMatched} matched ` +
    `(buffer ${r.bufferSize}/${r.bufferCapacity}, dropped ${r.droppedTotal})\n` +
    `# counts: error=${r.counts.error} warn=${r.counts.warn} info=${r.counts.info} ` +
    `debug=${r.counts.debug} trace=${r.counts.trace} | rust=${r.counts.rust} js=${r.counts.js} marker=${r.counts.marker}\n` +
    (r.counts.plugin ? `# ${r.counts.plugin} plugin-internal entries hidden (pass include_plugin=true to see them)\n` : "") +
    bracket +
    (r.nextCursor != null ? `# nextCursor=${r.nextCursor} (pass as since_id to paginate)\n` : "");
  if (format === "json") return header + "\n" + JSON.stringify(r.entries, null, 2);
  const body = r.entries.map(formatCompact).join("\n");
  return header + "\n" + body;
}

function formatSummary(r: SummaryResult): string {
  const lines: string[] = [
    `# log summary (buffer ${r.bufferSize}/${r.bufferCapacity}, dropped ${r.droppedTotal})`,
    `# counts: error=${r.counts.error} warn=${r.counts.warn} info=${r.counts.info} ` +
      `debug=${r.counts.debug} trace=${r.counts.trace} | rust=${r.counts.rust} js=${r.counts.js}` +
      (r.counts.plugin ? ` (plugin-internal: ${r.counts.plugin}, hidden by default)` : ""),
    "",
    `## last ${r.recentWarningsAndErrors.length} warnings/errors:`,
  ];
  for (const e of r.recentWarningsAndErrors) lines.push(formatCompact(e));
  return lines.join("\n");
}

export function registerQueryLogsTool(server: McpServer) {
  server.tool(
    "query_logs",
    "Query buffered logs from the Tauri app (both Rust-side log!() output and webview console.* calls). " +
      "Use mode='summary' first to see counts and recent warnings/errors without flooding context. " +
      "Then use mode='tail' with filters (level, source, contains) to drill into specific logs. " +
      "Use since_id with the nextCursor from a previous call to follow new logs incrementally. " +
      "Buffer is bounded — droppedTotal tells you if older logs were evicted.",
    {
      mode: z.enum(["tail", "summary"]).default("tail")
        .describe("'summary' returns counts + last 10 warn/error entries (small payload). 'tail' returns matching entries."),
      level: z.enum(["trace", "debug", "info", "warn", "error"]).optional()
        .describe("Minimum severity to include. 'warn' returns warn+error only."),
      source: z.enum(["rust", "js"]).optional()
        .describe("Filter to logs from Rust backend ('rust') or webview console ('js')."),
      contains: z.string().optional()
        .describe("Case-insensitive substring filter on the message."),
      since_id: z.number().int().nonnegative().optional()
        .describe("Pagination cursor — only return entries with id > this. Pair with nextCursor from prior call."),
      since_ms: z.number().int().nonnegative().optional()
        .describe("Only return entries with timestamp (unix ms) >= this. Use Date.now() - N to get last N ms."),
      limit: z.number().int().min(1).max(1000).default(100)
        .describe("Max entries to return (1-1000). Default 100."),
      head: z.boolean().default(false)
        .describe("If true, return oldest matching entries; default returns most recent (tail)."),
      format: z.enum(["compact", "json"]).default("compact")
        .describe("'compact' = one line per entry (smaller). 'json' = full JSON for entries."),
      between: z.string().optional()
        .describe("Marker tag — return only entries between the two most recent log_mark calls with this id. If only one marker exists, the upper bound is 'now'. Use this to capture exactly the logs produced by an action you just performed."),
      include_markers: z.boolean().default(false)
        .describe("If true, include the marker sentinel entries themselves in the result. Default false."),
      include_plugin: z.boolean().default(false)
        .describe("If true, include the MCP plugin's own instrumentation logs (socket command tracing, JS bridge chatter). Hidden by default so app logs aren't buried. Default false."),
    },
    {
      title: "Query App Logs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ mode, level, source, contains, since_id, since_ms, limit, head, format, between, include_markers, include_plugin }) => {
      try {
        const payload: Record<string, unknown> = { mode, limit, head };
        if (level !== undefined) payload.level = level;
        if (source !== undefined) payload.source = source;
        if (contains !== undefined) payload.contains = contains;
        if (since_id !== undefined) payload.sinceId = since_id;
        if (since_ms !== undefined) payload.sinceMs = since_ms;
        if (between !== undefined) payload.between = between;
        if (include_markers) payload.includeMarkers = true;
        if (include_plugin) payload.includePlugin = true;

        logCommandParams("query_logs", payload);

        const result = await socketClient.sendCommand("query_logs", payload);
        if (!result || typeof result !== "object") {
          return createErrorResponse("query_logs returned no data");
        }

        if (mode === "summary") {
          return createSuccessResponse(formatSummary(result as SummaryResult));
        }
        return createSuccessResponse(formatTail(result as TailResult, format));
      } catch (error) {
        return createErrorResponse(`query_logs failed: ${(error as Error).message}`);
      }
    },
  );
}
