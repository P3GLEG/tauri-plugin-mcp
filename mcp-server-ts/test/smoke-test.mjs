#!/usr/bin/env node
/**
 * MCP Protocol Smoke Test
 *
 * Spawns the MCP server, sends initialize + tools/list over stdio,
 * and validates that all 13 tools are registered with correct schemas.
 *
 * Run:  node test/smoke-test.mjs
 * (from mcp-server-ts/ directory, after `npm run build`)
 */

import { spawn } from "node:child_process";
import { once } from "node:events";

// ── Expectations ──────────────────────────────────────────────────────

const EXPECTED_TOOL_COUNT = 19;

const EXPECTED_TOOLS = [
  "take_screenshot",
  "query_page",
  "click",
  "type_text",
  "press_key",
  "mouse_action",
  "navigate",
  "execute_js",
  "manage_storage",
  "manage_window",
  "wait_for",
  "restart_app",
  "query_logs",
  "log_mark",
  "manage_ipc",
  "read_text",
  "inspect_element",
  "dispatch_pointer",
  "app_bridge",
];

// Tools whose selector_type enum MUST include "ref"
const TOOLS_WITH_REF_SELECTOR = ["query_page", "click", "type_text", "press_key"];

// Specific schema property checks:  tool -> param -> assertion
const SCHEMA_CHECKS = {
  take_screenshot: {
    params: [
      "window_label", "quality", "max_width", "max_size_mb",
      "output_dir", "inline", "audience",
    ],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  query_page: {
    params: [
      "mode", "window_label", "include_content", "interactive_only",
      "scope_selector", "max_depth", "delta", "wait_for_stable",
      "quiet_ms", "max_wait_ms", "timeout_secs", "include_metadata",
      "selector_type", "selector_value", "should_click",
      "find_scope_selector", "match", "nth",
    ],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  click: {
    params: [
      "x", "y", "button", "click_type",
      "selector_type", "selector_value", "window_label",
      "scope_selector", "match", "nth",
    ],
    annotations: { destructiveHint: true },
  },
  type_text: {
    params: [
      "text", "selector_type", "selector_value", "fields",
      "submit_ref", "files", "window_label", "delay_ms", "initial_delay_ms",
    ],
    annotations: { destructiveHint: true },
  },
  press_key: {
    params: [
      "key", "modifiers", "repeat",
      "selector_type", "selector_value", "window_label",
    ],
    annotations: { destructiveHint: true },
  },
  manage_ipc: {
    params: [
      "action", "command", "args", "event", "payload", "kind",
      "name_contains", "status", "since_id", "limit", "timeout_ms",
      "window_label",
    ],
    annotations: { destructiveHint: true },
  },
  mouse_action: {
    params: [
      "action", "x", "y", "relative", "end_x", "end_y",
      "direction", "amount", "to_ref", "to_top", "to_bottom", "window_label",
    ],
    annotations: { destructiveHint: false },
  },
  navigate: {
    params: ["action", "url", "delta", "window_label"],
    annotations: { destructiveHint: false },
  },
  execute_js: {
    params: ["code", "window_label", "timeout_ms"],
    annotations: { destructiveHint: true },
  },
  manage_storage: {
    params: ["store", "action", "key", "value", "url", "window_label"],
    annotations: { destructiveHint: true },
  },
  manage_window: {
    params: [
      "action", "window_label", "x", "y", "width", "height",
      "scale", "r", "g", "b", "a", "enabled",
    ],
    annotations: { destructiveHint: true },
  },
  wait_for: {
    params: ["window_label", "text", "selector", "ref", "state", "timeout_ms"],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  restart_app: {
    params: ["delay_ms"],
    annotations: { destructiveHint: true },
  },
  query_logs: {
    params: [
      "mode", "level", "source", "contains", "since_id", "since_ms",
      "limit", "head", "format", "between", "include_markers",
    ],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  log_mark: {
    params: ["id", "note"],
    annotations: { destructiveHint: false },
  },
  read_text: {
    params: [
      "selector", "all", "limit", "attrs", "max_chars",
      "scope_selector", "window_label",
    ],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  inspect_element: {
    params: ["selector", "all", "limit", "style_props", "window_label"],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  dispatch_pointer: {
    params: [
      "selector_type", "selector_value", "gesture", "offset", "to",
      "steps", "button", "modifiers", "window_label",
    ],
    annotations: { destructiveHint: true },
  },
  app_bridge: {
    params: [
      "action", "name", "args", "timeout_ms", "max_chars", "window_label",
    ],
    annotations: { destructiveHint: false },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

let failures = 0;

function pass(msg) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  failures++;
}

function check(condition, passMsg, failMsg) {
  if (condition) pass(passMsg);
  else fail(failMsg);
}

// ── MCP Protocol Communication ───────────────────────────────────────

function sendJsonRpc(proc, id, method, params = {}) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  proc.stdin.write(msg + "\n");
}

async function collectResponses(proc, expectedCount, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const responses = [];
    let buffer = "";

    const timer = setTimeout(() => {
      reject(new Error(`Timeout: got ${responses.length}/${expectedCount} responses in ${timeoutMs}ms. Buffer: ${buffer}`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      // MCP messages are newline-delimited JSON
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          responses.push(JSON.parse(trimmed));
        } catch {
          // skip non-JSON lines (e.g. logging)
        }
        if (responses.length >= expectedCount) {
          clearTimeout(timer);
          resolve(responses);
        }
      }
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1mMCP Protocol Smoke Test\x1b[0m\n");

  // Spawn server — point it at a TCP port nothing listens on so the
  // startup connection attempt fails fast (tool registration doesn't
  // require a live socket).
  const proc = spawn("node", ["build/index.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      TAURI_MCP_CONNECTION_TYPE: "tcp",
      TAURI_MCP_TCP_HOST: "127.0.0.1",
      TAURI_MCP_TCP_PORT: "1", // nothing listens here — fast failure
    },
  });

  // Collect stderr for debugging
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    // Send initialize + tools/list
    const responsePromise = collectResponses(proc, 2);

    sendJsonRpc(proc, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.1.0" },
    });

    // Small delay to let initialize complete before sending next request
    await new Promise((r) => setTimeout(r, 500));

    // Send initialized notification (required by MCP protocol)
    const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    proc.stdin.write(notif + "\n");

    await new Promise((r) => setTimeout(r, 200));

    sendJsonRpc(proc, 2, "tools/list", {});

    const responses = await responsePromise;

    // ── Validate initialize response ───────────────────────────────
    console.log("1. Initialize response:");

    const initResp = responses.find((r) => r.id === 1);
    check(initResp, "Got initialize response", "No initialize response");

    if (initResp?.result) {
      const { serverInfo } = initResp.result;
      check(
        serverInfo?.name === "tauri-mcp",
        `Server name: ${serverInfo?.name}`,
        `Unexpected server name: ${serverInfo?.name}`
      );
      // instructions may be at result.instructions or result.serverInfo.instructions
      const instructions = initResp.result.instructions ?? serverInfo?.instructions;
      check(
        typeof instructions === "string" && instructions.includes("query_page"),
        `Server instructions present and mention query_page`,
        `Missing or incomplete server instructions: ${instructions}`
      );
    } else {
      fail(`Initialize result missing: ${JSON.stringify(initResp)}`);
    }

    // ── Validate tools/list response ───────────────────────────────
    console.log("\n2. Tools list:");

    const toolsResp = responses.find((r) => r.id === 2);
    check(toolsResp, "Got tools/list response", "No tools/list response");

    const tools = toolsResp?.result?.tools || [];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    const toolNames = tools.map((t) => t.name).sort();

    check(
      tools.length === EXPECTED_TOOL_COUNT,
      `Tool count: ${tools.length}`,
      `Expected ${EXPECTED_TOOL_COUNT} tools, got ${tools.length}: [${toolNames.join(", ")}]`
    );

    // Check all expected tools are present
    console.log("\n3. Expected tools present:");
    for (const name of EXPECTED_TOOLS) {
      check(
        name in toolMap,
        name,
        `MISSING: ${name}`
      );
    }

    // Check no unexpected tools
    const unexpected = toolNames.filter((n) => !EXPECTED_TOOLS.includes(n));
    check(
      unexpected.length === 0,
      "No unexpected tools",
      `Unexpected tools: [${unexpected.join(", ")}]`
    );

    // ── Validate ref selector ──────────────────────────────────────
    console.log("\n4. 'ref' in selector_type enums:");
    for (const toolName of TOOLS_WITH_REF_SELECTOR) {
      const tool = toolMap[toolName];
      if (!tool) { fail(`${toolName}: tool not found`); continue; }

      const selectorProp = tool.inputSchema?.properties?.selector_type;
      const enumValues = selectorProp?.enum || [];
      check(
        enumValues.includes("ref"),
        `${toolName}: selector_type includes 'ref' → [${enumValues.join(", ")}]`,
        `${toolName}: selector_type missing 'ref' → [${enumValues.join(", ")}]`
      );
    }

    // ── Validate schema properties and annotations ─────────────────
    console.log("\n5. Schema property and annotation checks:");
    for (const [toolName, checks] of Object.entries(SCHEMA_CHECKS)) {
      const tool = toolMap[toolName];
      if (!tool) { fail(`${toolName}: tool not found`); continue; }

      // Check expected params exist in inputSchema
      if (checks.params) {
        const schemaProps = Object.keys(tool.inputSchema?.properties || {});
        const missing = checks.params.filter((p) => !schemaProps.includes(p));
        check(
          missing.length === 0,
          `${toolName}: all ${checks.params.length} params present`,
          `${toolName}: missing params [${missing.join(", ")}] (has: [${schemaProps.join(", ")}])`
        );
      }

      // Check annotations
      if (checks.annotations) {
        const ann = tool.annotations || {};
        for (const [key, expected] of Object.entries(checks.annotations)) {
          check(
            ann[key] === expected,
            `${toolName}: ${key} = ${ann[key]}`,
            `${toolName}: ${key} expected ${expected}, got ${ann[key]}`
          );
        }
      }
    }
  } finally {
    proc.kill();
    // Wait for process to actually exit
    await once(proc, "exit").catch(() => {});
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(50));
  if (failures === 0) {
    console.log(`\x1b[32m\x1b[1mAll checks passed.\x1b[0m\n`);
  } else {
    console.log(`\x1b[31m\x1b[1m${failures} check(s) failed.\x1b[0m\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\n\x1b[31mFatal error:\x1b[0m", err.message);
  process.exitCode = 1;
});
